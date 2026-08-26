const path = require('path');
const os = require('os');
const express = require('express');
const { buildDashboard, getSessionTimeline } = require('./lib/aggregate');
const { killAllHarnessProcesses } = require('./lib/processes');
const { router: otelRouter } = require('./lib/otel');
const { readHistory } = require('./lib/history');
const { sessionsToCsv } = require('./lib/csv');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PORT = process.env.DASHBOARD_PORT || 4590;
const REFRESH_MS = 3_000;

let cache = null;
let lastError = null;

const guard = {
  armed: false,
  armedAt: null,
  events: [], // {time, reason, killed: [{pid, ok}]}
};

function refresh() {
  try {
    cache = buildDashboard(DSH_HOME);
    lastError = null;
    checkGuard();
  } catch (e) {
    lastError = e.message;
    console.error('[dsh-dashboard] refresh failed:', e);
  }
}

// When armed, any NEW finding since arming that's on the auto-kill allowlist
// (see lib/security.js) immediately stops every detected dsh process. This
// is reactive, not preventive: it can only act after the harness has already
// logged the tool call, so it's a fast circuit-breaker, not a guarantee the
// command never ran. For genuine prevention, see guardian-plugin/.
function checkGuard() {
  if (!guard.armed || !cache) return;
  const trigger = cache.securityFindings.find(f => f.autoKill && f.time > guard.armedAt);
  if (!trigger) return;

  const killed = killAllHarnessProcesses(`auto-kill: ${trigger.label}`);
  guard.events.unshift({ time: Date.now(), reason: trigger.label, snippet: trigger.snippet, killed });
  guard.armed = false; // one-shot: nothing left running to guard once the harness is down
  console.warn('[dsh-dashboard] GUARD TRIGGERED:', trigger.label, killed);
}

refresh();
setInterval(refresh, REFRESH_MS);

const app = express();
app.use('/', otelRouter()); // POST /v1/logs - OTLP/HTTP-JSON log receiver, see lib/otel.js
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/dashboard', (req, res) => {
  if (!cache) return res.status(503).json({ error: lastError || 'not ready' });
  res.json({ ...cache, guard });
});

app.get('/api/refresh', (req, res) => {
  refresh();
  res.json({ ok: !lastError, error: lastError });
});

app.post('/api/guard', (req, res) => {
  guard.armed = !!req.body?.armed;
  guard.armedAt = guard.armed ? Date.now() : null;
  res.json({ guard });
});

app.post('/api/kill-now', (req, res) => {
  const killed = killAllHarnessProcesses('manual emergency stop');
  guard.events.unshift({ time: Date.now(), reason: 'manual emergency stop', killed });
  guard.armed = false;
  res.json({ killed });
});

app.get('/api/history', (req, res) => {
  res.json({ history: readHistory() });
});

app.get('/api/session/:id', (req, res) => {
  const result = getSessionTimeline(DSH_HOME, req.params.id, Number(req.query.limit) || 500);
  if (!result) return res.status(404).json({ error: 'session not found' });
  res.json(result);
});

app.get('/api/export.json', (req, res) => {
  if (!cache) return res.status(503).json({ error: lastError || 'not ready' });
  res.setHeader('Content-Disposition', 'attachment; filename="dsh-dashboard-export.json"');
  res.json(cache);
});

app.get('/api/export/sessions.csv', (req, res) => {
  if (!cache) return res.status(503).send('not ready');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="dsh-sessions.csv"');
  res.send(sessionsToCsv(cache.sessions));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`dsh-dashboard: http://127.0.0.1:${PORT} (watching ${DSH_HOME}, refresh ${REFRESH_MS}ms)`);
  console.log(`dsh-dashboard: OTLP log receiver at http://127.0.0.1:${PORT}/v1/logs`);
});
