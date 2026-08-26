// Heuristic pattern rules for flagging risky commands/prompts. None of this
// exists natively in the harness - it's scanned here from tool-call
// arguments and message text pulled out of the session event logs.

// autoKill=true marks rules the kill-switch is allowed to act on
// automatically when armed - restricted to patterns with very low
// false-positive risk in normal dev work. Things like `rm -rf` or
// `taskkill /f` are flagged for visibility but deliberately excluded from
// auto-kill because they're routine (node_modules cleanup, killing a stuck
// dev server) and would make the switch trigger constantly.
const RULES = [
  { id: 'destructive-fs', severity: 'high', autoKill: false, label: 'Destructive filesystem wipe', re: /\brm\s+-[a-z]*r[a-z]*f|\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force|del\s+\/[fsq]{1,3}\s|format\s+[a-z]:/i },
  { id: 'fork-bomb', severity: 'high', autoKill: true, label: 'Fork bomb pattern', re: /:\(\)\s*\{\s*:\|:&\s*\};:/ },
  { id: 'pipe-to-shell', severity: 'high', autoKill: true, label: 'Remote script piped directly to a shell', re: /(curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(sh|bash|iex|Invoke-Expression|powershell)/i },
  { id: 'invoke-expression', severity: 'medium', autoKill: false, label: 'Dynamic code execution (Invoke-Expression/eval)', re: /\bInvoke-Expression\b|\biex\s|(^|[^.\w])eval\s*\(/i },
  { id: 'disable-defenses', severity: 'high', autoKill: true, label: 'Disabling security tooling', re: /Set-MpPreference\s+-DisableRealtimeMonitoring|DisableAntiSpyware|netsh\s+advfirewall\s+set[^\n]*off|Disable-WindowsOptionalFeature/i },
  { id: 'credential-dump', severity: 'high', autoKill: true, label: 'Credential dumping tool', re: /mimikatz|Invoke-Mimikatz|lsass\.dmp|procdump[^\n]*lsass/i },
  { id: 'persistence', severity: 'medium', autoKill: false, label: 'Persistence mechanism (scheduled task / run key)', re: /schtasks\s+\/create|reg\s+add[^\n]*\\Run\b|New-ScheduledTask/i },
  { id: 'secret-literal', severity: 'medium', autoKill: false, label: 'Possible secret/API key literal', re: /\bsk-[a-zA-Z0-9]{16,}\b|\bAKIA[0-9A-Z]{12,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'reverse-shell', severity: 'high', autoKill: true, label: 'Reverse shell / raw socket listener', re: /nc\s+-e\s|\/dev\/tcp\/|New-Object\s+System\.Net\.Sockets\.TCPClient/i },
  { id: 'exfil', severity: 'medium', autoKill: false, label: 'Possible data exfiltration via network tool', re: /curl[^\n]*--upload-file|Invoke-WebRequest[^\n]*-Method\s+Post[^\n]*-InFile/i },
  { id: 'kill-process', severity: 'low', autoKill: false, label: 'Force-killing processes', re: /taskkill\s+\/f|Stop-Process[^\n]*-Force/i },
  { id: 'shutdown', severity: 'medium', autoKill: false, label: 'System shutdown/restart', re: /shutdown\s+\/[sr]\b|Restart-Computer|Stop-Computer/i },
];

/**
 * Scan one piece of text (a tool-call argument blob or a user/assistant
 * message) for risky patterns. Returns [] when nothing matches.
 */
function scanText(text) {
  if (!text || typeof text !== 'string') return [];
  const hits = [];
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m) {
      hits.push({
        ruleId: rule.id,
        severity: rule.severity,
        autoKill: rule.autoKill,
        label: rule.label,
        snippet: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim(),
      });
    }
  }
  return hits;
}

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

module.exports = { scanText, RULES, SEVERITY_RANK };
