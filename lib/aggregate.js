const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { readSessionEvents, findSessionFiles } = require('./sessions');
const { scanText, SEVERITY_RANK } = require('./security');
const { estimateSessionCost, pricing } = require('./cost');
const { listHarnessProcesses } = require('./processes');
const { listOtelSessions } = require('./otel');
const { buildTimeline } = require('./timeline');
const { appendSnapshot } = require('./history');

// This dashboard runs as its own process, so process.env only reflects vars
// set before *it* started - not the running `dsh web` process, and not vars
// added via `setx` after either process launched (Windows only applies those
// to processes started fresh afterward). The persisted user env block in the
// registry is the only reliable "is this configured" signal, so read it
// directly instead of trusting our own inherited environment.
function readPersistedUserEnv() {
  const out = {};
  try {
    const raw = execFileSync('reg', ['query', 'HKCU\\Environment'], { encoding: 'utf8' });
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s{4}(\S+)\s+REG_\w+\s+(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch (e) { /* non-Windows or reg unavailable */ }
  return out;
}

function hasCredential(envVar) {
  if (process.env[envVar]) return true;
  return !!readPersistedUserEnv()[envVar];
}

function loadSettings(dshHome) {
  const settingsPath = path.join(dshHome, 'settings.yaml');
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return yaml.load(fs.readFileSync(settingsPath, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function loadProjCache(dshHome) {
  const p = path.join(dshHome, 'storages', 'session_projcache.json');
  if (!fs.existsSync(p)) return { tables: { sessions: {} } };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { tables: { sessions: {} } };
  }
}

function modelInventory(settings) {
  const providers = settings?.['llm-pi-ai']?.providers || {};
  const models = [];
  for (const [route, cfg] of Object.entries(providers)) {
    const list = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : [{ id: '(installed catalog)' }];
    for (const m of list) {
      models.push({ route, id: m.id, apiKeyEnv: cfg.apiKeyEnv || null, hasKey: cfg.apiKeyEnv ? hasCredential(cfg.apiKeyEnv) : null });
    }
  }
  return models;
}

// Human-readable description of what's currently happening in a session,
// derived from its most recent events - the closest thing to "what is this
// agent doing right now" without hooking into the live process.
function describeActivity(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'tool/call') {
      let arg = '';
      try { arg = JSON.parse(ev.data.arguments)?.description || JSON.parse(ev.data.arguments)?.command || ''; } catch (e) {}
      return { kind: 'tool', label: ev.data.name, detail: String(arg).slice(0, 90), time: ev.time };
    }
    if (ev.type === 'tool/result') return { kind: 'waiting', label: 'processing tool result', detail: '', time: ev.time };
    if (ev.type === 'text-chunks' || ev.type === 'reasoning-chunks') {
      const detail = (ev.data.texts || []).join('').slice(0, 90);
      return { kind: ev.type === 'reasoning-chunks' ? 'thinking' : 'writing', label: ev.type === 'reasoning-chunks' ? 'reasoning' : 'responding', detail, time: ev.time };
    }
    if (ev.type === 'step/start') return { kind: 'step', label: `turn ${ev.data.turn}, step ${ev.data.step}`, detail: '', time: ev.time };
    if (ev.type === 'user/message') return { kind: 'prompt', label: 'received prompt', detail: '', time: ev.time };
  }
  return { kind: 'idle', label: 'idle', detail: '', time: null };
}

function buildDashboard(dshHome) {
  const settings = loadSettings(dshHome);
  const projCache = loadProjCache(dshHome);
  const sessionRows = projCache.tables?.sessions || {};
  const models = modelInventory(settings);
  const harnessProcesses = listHarnessProcesses();

  const fileSources = findSessionFiles(path.join(dshHome, 'sessions')).map(sf => {
    let events = [];
    try { events = readSessionEvents(sf.file); } catch (e) { /* corrupt/partial - skip this file this cycle */ }
    const meta = events.find(e => e.type === 'session');
    return {
      sessionId: meta?.id || sf.sessionDir,
      dirName: sf.sessionDir,
      workspace: sf.workspace,
      events,
      source: 'local',
    };
  });
  const otelSources = listOtelSessions().map(s => ({
    sessionId: s.sessionId,
    dirName: s.sessionId,
    workspace: s.cwd || '(remote)',
    cwd: s.cwd,
    parentSession: s.parentSession,
    events: s.events,
    source: 'otel',
  }));
  // A session reported by both sources (e.g. testing the OTel receiver
  // against your own local dsh) keeps whichever copy has more events -
  // they should converge, but the log file is the more complete record
  // since OTel export can be batched/delayed.
  const bySessionId = new Map();
  for (const src of [...otelSources, ...fileSources]) {
    const existing = bySessionId.get(src.sessionId);
    if (!existing || src.events.length >= existing.events.length) bySessionId.set(src.sessionId, src);
  }
  const sessionFiles = Array.from(bySessionId.values());

  const sessions = [];
  const toolCallCounts = {};
  const modelRequestCounts = {};
  const securityFindings = [];
  const permissionEvents = [];
  let totalToolCalls = 0;
  let totalUserPrompts = 0;
  let totalTurns = 0;
  let totalRetries = 0;
  let totalErrors = 0;
  let totalKnownCostUsd = 0;
  let anyUnknownCost = false;
  const activity = [];
  const tokenTimeline = []; // {time, sessionId} at each tool/call, for an events-over-time chart

  for (const sf of sessionFiles) {
    const events = sf.events;
    if (!events.length) continue;
    const sessionMeta = events.find(e => e.type === 'session');
    const sessionId = sf.sessionId;
    const projRow = sessionRows[sessionId]?.rows || {};

    let turns = 0, toolCalls = 0, prompts = 0, retries = 0, errors = 0;
    let lastActivity = sessionMeta?.createdAt || 0;
    let currentPermission = null, currentSandbox = null, currentApproval = null;
    const requestCountsByModel = {};

    for (const ev of events) {
      lastActivity = Math.max(lastActivity, ev.time || 0);

      if (ev.type === 'turn/start') { turns++; totalTurns++; }
      if (ev.type === 'turn/end' && ev.data?.reason?.kind === 'error') errors++;

      if (ev.type === 'user/message' && ev.data?.source?.kind === 'user') {
        prompts++; totalUserPrompts++;
        const text = (ev.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        for (const hit of scanText(text)) {
          securityFindings.push({ ...hit, sessionId, time: ev.time, source: 'prompt', title: sf.sessionDir });
        }
      }

      if (ev.type === 'tool/call') {
        toolCalls++; totalToolCalls++;
        const name = ev.data?.name || 'unknown';
        toolCallCounts[name] = (toolCallCounts[name] || 0) + 1;
        activity.push({ time: ev.time, sessionId, kind: 'tool', name });
        tokenTimeline.push({ time: ev.time, sessionId });
        for (const hit of scanText(ev.data?.arguments)) {
          securityFindings.push({ ...hit, sessionId, time: ev.time, source: `tool:${name}`, title: sf.sessionDir });
        }
      }

      if (ev.type === 'request/context') {
        const key = `${ev.data.provider}/${ev.data.model}`;
        modelRequestCounts[key] = (modelRequestCounts[key] || 0) + 1;
        requestCountsByModel[key] = (requestCountsByModel[key] || 0) + 1;
      }

      if (ev.type === 'llm/retry') { retries++; totalRetries++; }

      if (ev.type === 'permission/preset') currentPermission = ev.data.preset;
      if (ev.type === 'sandbox/mode') currentSandbox = ev.data.mode;
      if (ev.type === 'approval/policy') currentApproval = ev.data.policy;
      if (ev.type === 'permission/preset' || ev.type === 'sandbox/mode' || ev.type === 'approval/policy') {
        permissionEvents.push({ sessionId, time: ev.time, type: ev.type, value: ev.data.preset || ev.data.mode || ev.data.policy, title: sf.sessionDir });
      }
    }

    totalErrors += errors;

    const stats = projRow.sessionStats?.val || {};
    const tokenUsageRaw = projRow.tokenUsage?.val?.totals || {};
    const permissions = projRow.permissions?.val || { preset: currentPermission, sandbox: currentSandbox, approval: currentApproval };
    const tokenUsage = {
      input: tokenUsageRaw.uncachedInputTokens || 0,
      output: tokenUsageRaw.outputTokens || 0,
      cacheRead: tokenUsageRaw.cacheReadTokens || 0,
      cacheWrite: tokenUsageRaw.cacheWriteTokens || 0,
    };

    const cost = estimateSessionCost(tokenUsage, requestCountsByModel);
    totalKnownCostUsd += cost.knownUsd;
    if (cost.unknownShare > 0) anyUnknownCost = true;

    const running = stats.openStep != null;

    sessions.push({
      id: sessionId,
      dirName: sf.sessionDir,
      workspace: sf.workspace,
      title: projRow.title?.val || null,
      // Local session events carry these fields flat on the event itself;
      // OTel-reconstructed sessions don't get a matching flat `session`
      // event (the seam's `identityOf()` sends session.cwd/parent_id as
      // attributes, not as the event body), so fall back to what otel.js
      // already tracked from those attributes directly.
      cwd: sessionMeta?.cwd || sf.cwd || null,
      origin: sessionMeta?.origin || (sf.source === 'otel' ? 'otel' : 'top-level'),
      parentSession: sessionMeta?.parentSession || sf.parentSession || null,
      createdAt: sessionMeta?.createdAt || events[0]?.time || null,
      lastActivity,
      running,
      activity: running ? describeActivity(events) : null,
      turns: stats.turns ?? turns,
      steps: stats.steps ?? 0,
      toolCalls,
      prompts,
      retries,
      errors,
      tokenUsage,
      cost,
      requestCountsByModel,
      permissions,
      riskyPermission: permissions.preset === 'danger-full-access' || permissions.approval === 'never',
      source: sf.source,
    });
  }

  sessions.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  activity.sort((a, b) => b.time - a.time);
  securityFindings.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.time - a.time));

  const totals = sessions.reduce((acc, s) => {
    acc.input += s.tokenUsage.input;
    acc.output += s.tokenUsage.output;
    acc.cacheRead += s.tokenUsage.cacheRead;
    acc.cacheWrite += s.tokenUsage.cacheWrite;
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  // events-per-minute for the last 30 minutes, for a simple activity sparkline
  const now = Date.now();
  const BUCKET_MS = 60_000;
  const BUCKETS = 30;
  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
    t: now - (BUCKETS - 1 - i) * BUCKET_MS, count: 0,
  }));
  for (const a of activity) {
    const bucketIdx = BUCKETS - 1 - Math.floor((now - a.time) / BUCKET_MS);
    if (bucketIdx >= 0 && bucketIdx < BUCKETS) buckets[bucketIdx].count++;
  }

  const result = {
    generatedAt: now,
    dshHome,
    summary: {
      sessionCount: sessions.length,
      runningSessions: sessions.filter(s => s.running).length,
      harnessProcessCount: harnessProcesses.length,
      otelSessionCount: sessions.filter(s => s.source === 'otel').length,
      totalTurns,
      totalPrompts: totalUserPrompts,
      totalToolCalls,
      totalRetries,
      totalErrors,
      modelsConnected: models.length,
      securityFindingsCount: securityFindings.length,
      riskyPermissionSessions: sessions.filter(s => s.riskyPermission).length,
      tokens: { ...totals, total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite },
      estimatedCostUsd: totalKnownCostUsd,
      hasUnknownCost: anyUnknownCost,
      avgCostPerSessionUsd: sessions.length ? totalKnownCostUsd / sessions.length : 0,
      avgCostPerTurnUsd: totalTurns ? totalKnownCostUsd / totalTurns : 0,
    },
    models,
    pricing,
    modelRequestCounts,
    toolCallCounts,
    sessions,
    harnessProcesses,
    securityFindings: securityFindings.slice(0, 200),
    permissionEvents: permissionEvents.sort((a, b) => b.time - a.time).slice(0, 100),
    recentActivity: activity.slice(0, 100),
    activityTimeline: buckets,
  };

  appendSnapshot(result.summary);
  return result;
}

// Used by GET /api/session/:id - re-resolves the session's raw events (cheap:
// lib/sessions.js caches per-file decode state) and reduces them to a
// human-readable timeline rather than shipping every streaming chunk.
function getSessionTimeline(dshHome, sessionId, limit, beforeSeq) {
  const fileSources = findSessionFiles(path.join(dshHome, 'sessions'));
  for (const sf of fileSources) {
    let events = [];
    try { events = readSessionEvents(sf.file); } catch (e) { continue; }
    const meta = events.find(e => e.type === 'session');
    const id = meta?.id || sf.sessionDir;
    if (id === sessionId || sf.sessionDir === sessionId) {
      return { sessionId: id, source: 'local', title: meta?.cwd, ...buildTimeline(events, { limit, beforeSeq }) };
    }
  }
  const otelMatch = listOtelSessions().find(s => s.sessionId === sessionId);
  if (otelMatch) {
    return { sessionId, source: 'otel', title: otelMatch.cwd, ...buildTimeline(otelMatch.events, { limit, beforeSeq }) };
  }
  return null;
}

module.exports = { buildDashboard, getSessionTimeline };
