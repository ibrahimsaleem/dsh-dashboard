function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sessionsToCsv(sessions) {
  const headers = [
    'id', 'title', 'workspace', 'source', 'running', 'turns', 'steps', 'toolCalls', 'prompts',
    'retries', 'errors', 'tokensInput', 'tokensOutput', 'tokensCacheRead', 'tokensCacheWrite',
    'estimatedCostUsd', 'permissionPreset', 'approvalPolicy', 'lastActivity',
  ];
  const rows = sessions.map(s => [
    s.id, s.title || s.dirName, s.workspace, s.source, s.running, s.turns, s.steps, s.toolCalls, s.prompts,
    s.retries, s.errors, s.tokenUsage.input, s.tokenUsage.output, s.tokenUsage.cacheRead, s.tokenUsage.cacheWrite,
    s.cost.knownUsd.toFixed(6), s.permissions?.preset, s.permissions?.approval,
    s.lastActivity ? new Date(s.lastActivity).toISOString() : '',
  ]);
  return [headers, ...rows].map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
}

module.exports = { sessionsToCsv };
