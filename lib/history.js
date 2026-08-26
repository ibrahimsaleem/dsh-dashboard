const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const SNAPSHOT_INTERVAL_MS = 60_000;
const MAX_LINES_READ = 5_000; // ~3.5 days at one snapshot/minute; older lines are still on disk, just not read every call

let lastSnapshotAt = 0;

function appendSnapshot(summary) {
  const now = Date.now();
  if (now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
  lastSnapshotAt = now;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const row = {
    t: now,
    sessionCount: summary.sessionCount,
    runningSessions: summary.runningSessions,
    totalTurns: summary.totalTurns,
    totalToolCalls: summary.totalToolCalls,
    totalTokens: summary.tokens.total,
    estimatedCostUsd: summary.estimatedCostUsd,
    securityFindingsCount: summary.securityFindingsCount,
  };
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(row) + '\n');
}

function readHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
  const tail = lines.slice(-MAX_LINES_READ);
  return tail.map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

module.exports = { appendSnapshot, readHistory };
