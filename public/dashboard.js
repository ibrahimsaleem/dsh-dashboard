const REFRESH_MS = 3_000;

function fmtNum(n) { return (n ?? 0).toLocaleString('en-US'); }
function fmtCompact(n) {
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n ?? 0);
}
function fmtUsd(n) {
  if (n == null) return '—';
  if (n < 0.01 && n > 0) return '<$0.01';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function statCard(label, value, cls = '', sub = '') {
  return `<div class="stat-card ${cls.includes('cost') ? 'cost' : ''}">
    <div class="label">${esc(label)}</div>
    <div class="value ${cls}">${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;
}

const ACTIVITY_ICON = { tool: '🔧', thinking: '💭', writing: '✍️', waiting: '⏳', step: '▶️', prompt: '📩', idle: '💤' };

function renderStats(d) {
  const s = d.summary;
  document.getElementById('stats').innerHTML = [
    statCard('Sessions', fmtNum(s.sessionCount)),
    statCard('Running now', fmtNum(s.runningSessions), s.runningSessions > 0 ? 'good' : ''),
    statCard('Harness processes', fmtNum(s.harnessProcessCount), s.harnessProcessCount > 0 ? 'good' : 'high'),
    statCard('OTel sessions', fmtNum(s.otelSessionCount), s.otelSessionCount > 0 ? 'accent' : '', 'remote, via /v1/logs'),
    statCard('Turns (requests)', fmtNum(s.totalTurns)),
    statCard('Prompts sent', fmtNum(s.totalPrompts)),
    statCard('Tool calls', fmtNum(s.totalToolCalls)),
    statCard('LLM retries', fmtNum(s.totalRetries), s.totalRetries > 0 ? 'medium' : ''),
    statCard('Turn errors', fmtNum(s.totalErrors), s.totalErrors > 0 ? 'high' : ''),
    statCard('Models connected', fmtNum(s.modelsConnected), 'accent'),
    statCard('Security findings', fmtNum(s.securityFindingsCount), s.securityFindingsCount > 0 ? 'high' : 'good'),
    statCard('Full-access sessions', fmtNum(s.riskyPermissionSessions), s.riskyPermissionSessions > 0 ? 'high' : 'good'),
    statCard('Total tokens', fmtCompact(s.tokens.total), 'accent'),
    statCard('Estimated cost', fmtUsd(s.estimatedCostUsd), 'cost', s.hasUnknownCost ? 'some tokens on unpriced models' : 'all models priced'),
    statCard('Avg cost / session', fmtUsd(s.avgCostPerSessionUsd), 'cost'),
  ].join('');
}

function renderTokenDonut(d) {
  const t = d.summary.tokens;
  const segs = [
    { label: 'Input', value: t.input, color: '#6d83f2' },
    { label: 'Output', value: t.output, color: '#3bc78f' },
    { label: 'Cache read', value: t.cacheRead, color: '#4a4a56' },
    { label: 'Cache write', value: t.cacheWrite, color: '#f2a93b' },
  ];
  document.getElementById('token-donut').innerHTML = donutWithLegend(segs, { size: 150, thickness: 22 });
}

function renderRiskDonut(d) {
  const risky = d.sessions.filter(s => s.riskyPermission).length;
  const safe = d.sessions.length - risky;
  const segs = [
    { label: 'workspace-write / ask', value: safe, color: '#3bc78f' },
    { label: 'danger-full-access / never', value: risky, color: '#f2555a' },
  ];
  document.getElementById('risk-donut').innerHTML = donutWithLegend(segs, { size: 150, thickness: 22 });
}

function renderSpark(d) {
  const points = d.activityTimeline.map(b => b.count);
  document.getElementById('activity-spark').innerHTML = svgSparkline(points, { width: 1180, height: 70, color: '#6d83f2' });
}

let lastTrendFetch = 0;
function maybeRenderTrends() {
  // /api/history only gains a new point once a minute (see lib/history.js) - no
  // point refetching it every 3s refresh cycle.
  if (Date.now() - lastTrendFetch < 30_000) return;
  lastTrendFetch = Date.now();
  renderTrends();
}

async function renderTrends() {
  try {
    const res = await fetch('/api/history');
    const { history } = await res.json();
    if (!history.length) {
      document.getElementById('tokens-trend').innerHTML = '<div class="empty">No history yet — a snapshot is recorded once a minute, check back shortly.</div>';
      document.getElementById('cost-trend').innerHTML = '<div class="empty">No history yet.</div>';
      return;
    }
    document.getElementById('trend-range').textContent = `${history.length} snapshot${history.length === 1 ? '' : 's'}, since ${timeAgo(history[0].t)}`;
    document.getElementById('tokens-trend').innerHTML = svgSparkline(history.map(h => h.totalTokens), { width: 570, height: 70, color: '#6d83f2' });
    document.getElementById('cost-trend').innerHTML = svgSparkline(history.map(h => h.estimatedCostUsd), { width: 570, height: 70, color: '#3bc78f' });
  } catch (e) {
    document.getElementById('tokens-trend').innerHTML = `<div class="empty">error: ${esc(e.message)}</div>`;
  }
}

function renderToolBars(d) {
  const entries = Object.entries(d.toolCallCounts).sort((a, b) => b[1] - a[1]);
  document.getElementById('tool-total').textContent = `${entries.length} distinct tools`;
  document.getElementById('tool-bars').innerHTML = entries.length
    ? hbar(entries.map(([name, count]) => ({ label: `<span class="mono">${esc(name)}</span>`, value: count })))
    : '<div class="empty">No tool calls recorded yet.</div>';
}

function renderCostBars(d) {
  const totals = {};
  for (const s of d.sessions) {
    for (const m of s.cost.byModel) {
      if (!totals[m.key]) totals[m.key] = 0;
      totals[m.key] += m.usd || 0;
    }
  }
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  document.getElementById('cost-total').textContent = fmtUsd(d.summary.estimatedCostUsd);
  document.getElementById('cost-bars').innerHTML = entries.length
    ? hbar(entries.map(([key, usd]) => ({ label: `<span class="mono">${esc(key)}</span>`, value: usd })), { formatVal: fmtUsd, color: 'var(--good)' })
    : '<div class="empty">No priced usage yet.</div>';
}

function permBadge(perm) {
  if (!perm) return '<span class="badge neutral">unknown</span>';
  const danger = perm.preset === 'danger-full-access' || perm.approval === 'never';
  return `<span class="badge ${danger ? 'danger' : 'ok'}">${esc(perm.preset || '?')} / ${esc(perm.approval || '?')}</span>`;
}

function renderLive(d) {
  const running = d.sessions.filter(s => s.running);
  document.getElementById('live-count').textContent = running.length ? `${running.length} active` : 'none active';
  const el = document.getElementById('live-list');
  el.innerHTML = running.length
    ? running.map(s => `
      <div class="live-session">
        <div class="top">
          <div class="name"><span class="pulse-dot"></span>${esc(s.title || s.dirName)}</div>
          <div class="session-sub">turn ${s.turns} · ${fmtCompact(s.tokenUsage.input + s.tokenUsage.output)} tok</div>
        </div>
        <div class="activity-line">${ACTIVITY_ICON[s.activity?.kind] || '•'} ${esc(s.activity?.label || 'working')}</div>
        ${s.activity?.detail ? `<div class="activity-detail">${esc(s.activity.detail)}</div>` : ''}
      </div>`).join('')
    : '<div class="empty">No sessions currently running a step.</div>';
}

function renderSessions(d) {
  document.getElementById('session-count').textContent = `${d.sessions.length} total`;
  const tbody = document.querySelector('#session-table tbody');
  tbody.innerHTML = d.sessions.map(s => {
    const cost = s.cost.knownUsd;
    const costLabel = fmtUsd(cost) + (s.cost.unknownShare > 0 ? ' *' : '');
    return `<tr>
      <td>
        <a href="/session.html?id=${encodeURIComponent(s.id)}" class="session-title" style="text-decoration:none;color:inherit">${s.running ? '<span class="pulse-dot" style="margin-right:6px"></span>' : ''}${esc(s.title || s.dirName)}</a>
        <div class="session-sub mono">${esc(s.origin)}${s.parentSession ? ' · sub of ' + esc(s.parentSession.slice(0, 12)) : ''}</div>
      </td>
      <td><span class="badge ${s.source === 'otel' ? 'accent' : 'neutral'}">${esc(s.source)}</span></td>
      <td>${s.running ? '<span class="badge running">running</span>' : '<span class="badge neutral">idle</span>'}</td>
      <td class="mono">${fmtNum(s.turns)}</td>
      <td class="mono">${fmtNum(s.toolCalls)}</td>
      <td class="mono">${fmtCompact(s.tokenUsage.input + s.tokenUsage.output + s.tokenUsage.cacheRead + s.tokenUsage.cacheWrite)}</td>
      <td class="mono">${costLabel}</td>
      <td>${permBadge(s.permissions)}</td>
      <td class="session-sub">${timeAgo(s.lastActivity)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">No sessions found.</td></tr>';
}

function renderModels(d) {
  document.getElementById('model-count').textContent = `${d.models.length} configured`;
  const tbody = document.querySelector('#model-table tbody');
  tbody.innerHTML = d.models.map(m => {
    const reqs = d.modelRequestCounts[`${m.route}/${m.id}`] || 0;
    const keyBadge = m.hasKey === null ? '<span class="badge neutral">n/a</span>'
      : m.hasKey ? '<span class="badge ok">set</span>' : '<span class="badge danger">missing</span>';
    const price = d.pricing?.[`${m.route}/${m.id}`];
    const priceLabel = price ? `${fmtUsd(price.input)} / ${fmtUsd(price.output)}` : 'unknown';
    return `<tr>
      <td class="mono">${esc(m.route)}</td>
      <td class="mono">${esc(m.id)}</td>
      <td>${keyBadge}</td>
      <td class="mono">${fmtNum(reqs)}</td>
      <td class="mono">${priceLabel}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">No providers configured.</td></tr>';
}

function renderFindings(d) {
  document.getElementById('finding-count').textContent = `${d.securityFindings.length}`;
  const el = document.getElementById('findings-list');
  if (!d.securityFindings.length) {
    el.innerHTML = '<div class="empty">No risky patterns detected in prompts or tool calls.</div>';
    return;
  }
  el.innerHTML = `<table><tbody>${d.securityFindings.slice(0, 40).map(f => `
    <tr>
      <td><span class="badge ${f.severity}">${esc(f.severity)}</span>${f.autoKill ? ' <span class="badge danger" title="eligible to trigger the kill switch">auto-kill</span>' : ''}</td>
      <td>
        <div>${esc(f.label)}</div>
        <div class="session-sub">${esc(f.source)} · ${timeAgo(f.time)}</div>
        <div class="snippet mono" title="${esc(f.snippet)}">${esc(f.snippet)}</div>
      </td>
    </tr>`).join('')}</tbody></table>`;
}

function renderPermEvents(d) {
  const el = document.getElementById('perm-list');
  if (!d.permissionEvents.length) {
    el.innerHTML = '<div class="empty">No permission/sandbox changes recorded.</div>';
    return;
  }
  const typeLabel = { 'permission/preset': 'preset', 'sandbox/mode': 'sandbox', 'approval/policy': 'approval' };
  el.innerHTML = `<table><tbody>${d.permissionEvents.slice(0, 30).map(p => `
    <tr>
      <td class="mono">${esc(typeLabel[p.type] || p.type)}</td>
      <td>${esc(p.value)}${(p.value === 'danger-full-access' || p.value === 'never') ? ' <span class="badge danger" style="margin-left:6px">risky</span>' : ''}</td>
      <td class="session-sub">${timeAgo(p.time)}</td>
    </tr>`).join('')}</tbody></table>`;
}

function renderProcesses(d) {
  document.getElementById('proc-count').textContent = `${d.harnessProcesses.length} running`;
  const el = document.getElementById('proc-list');
  el.innerHTML = d.harnessProcesses.length
    ? d.harnessProcesses.map(p => `
      <div class="proc-card">
        <div class="info">
          <div><span class="pulse-dot" style="margin-right:6px"></span><b>dsh ${esc(p.profile)}</b></div>
          <div class="pid mono">pid ${p.pid}</div>
        </div>
      </div>`).join('')
    : '<div class="empty">No dsh harness process detected.</div>';
}

const AUTOKILL_LABELS = ['fork bomb', 'pipe-to-shell', 'disable defenses', 'credential dump', 'reverse shell'];

function renderGuard(d) {
  const panel = document.getElementById('guard-panel');
  const toggle = document.getElementById('guard-toggle');
  const title = document.getElementById('guard-title');
  const badge = document.getElementById('guard-status-badge');
  toggle.checked = d.guard.armed;
  panel.classList.toggle('armed', d.guard.armed);
  title.textContent = d.guard.armed ? 'Kill switch: ARMED' : 'Kill switch: disarmed';
  badge.innerHTML = d.guard.armed ? '<span class="badge danger">watching</span>' : '<span class="badge neutral">off</span>';
  document.getElementById('autokill-chips').innerHTML = AUTOKILL_LABELS.map(l => `<span class="rule-chip">${l}</span>`).join('');

  if (d.guard.events.length && !window.__lastGuardEventShown) {
    window.__lastGuardEventShown = d.guard.events[0].time;
  }
}

function showModal(title, body, onConfirm) {
  const backdrop = document.getElementById('modal-backdrop');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  backdrop.classList.remove('hidden');
  const confirmBtn = document.getElementById('modal-confirm');
  const cancelBtn = document.getElementById('modal-cancel');
  const close = () => backdrop.classList.add('hidden');
  confirmBtn.onclick = () => { close(); onConfirm(); };
  cancelBtn.onclick = close;
}

let lastData = null;

async function setGuard(armed) {
  await fetch('/api/guard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ armed }) });
  load();
}

async function killNow() {
  await fetch('/api/kill-now', { method: 'POST' });
  load();
}

document.getElementById('guard-toggle').addEventListener('change', (e) => {
  const wantArmed = e.target.checked;
  e.target.checked = !wantArmed; // revert until confirmed
  if (wantArmed) {
    showModal('Arm kill switch?',
      'While armed, this dashboard will force-stop every running dsh process the instant it detects a fork bomb, a curl|sh style pipe-to-shell, defense-disabling, credential dumping, or a reverse shell in a fresh tool call. This is a hard stop with no further confirmation — arm it only if you want that automatic.',
      () => setGuard(true));
  } else {
    setGuard(false);
  }
});

document.getElementById('stop-now-btn').addEventListener('click', () => {
  showModal('Stop the harness now?',
    'This immediately force-kills every running dsh process on this machine (all sessions, all profiles). Any in-progress work will be lost. This cannot be undone.',
    killNow);
});

async function load() {
  try {
    const res = await fetch('/api/dashboard');
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'failed');
    lastData = d;

    document.getElementById('watching').textContent = d.dshHome;
    document.getElementById('updated').textContent = `updated ${timeAgo(d.generatedAt)}`;

    renderGuard(d);
    renderStats(d);
    renderTokenDonut(d);
    renderRiskDonut(d);
    renderSpark(d);
    maybeRenderTrends();
    renderLive(d);
    renderToolBars(d);
    renderCostBars(d);
    renderSessions(d);
    renderModels(d);
    renderProcesses(d);
    renderFindings(d);
    renderPermEvents(d);
  } catch (e) {
    document.getElementById('updated').textContent = `error: ${e.message}`;
  }
}

load();
setInterval(load, REFRESH_MS);
