const path = require('path');
const os = require('os');
const express = require('express');
const { buildDashboard } = require('./lib/aggregate');
const { killAllHarnessProcesses } = require('./lib/processes');

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
// command never ran.
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`dsh-dashboard: http://127.0.0.1:${PORT} (watching ${DSH_HOME}, refresh ${REFRESH_MS}ms)`);
});
