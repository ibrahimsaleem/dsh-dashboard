// dsh-dashboard-guardian — a preventive tool-call guard for DeepSeek Harness.
//
// Unlike dsh-dashboard's own kill switch (which is reactive: it watches the
// on-disk session log from OUTSIDE the harness process and can only react
// after a tool call was already logged), this plugin runs INSIDE the
// harness and registers a synchronous ctx.tools.guard() callback. That
// callback fires after `tools/pre-execute` and *before* the tool body
// dispatches (see @deepseek-ai/dsh-tools's README), and it receives the
// actual parsed `exec.arguments` — so a match here genuinely blocks
// execution rather than racing it.
//
// Scope is deliberately narrow: the same 5 low-false-positive rules the
// dashboard's kill switch is allowed to auto-act on (see
// dsh-dashboard/lib/security.js — keep these two lists in sync by hand).
// Routine risky commands (`rm -rf`, `taskkill /f`, etc.) are NOT blocked
// here on purpose; they're common in normal dev work and would make this
// unusable if it denied them.

const name = 'dsh-dashboard-guardian';
const inject = ['tools'];

const RULES = [
  { id: 'fork-bomb', label: 'fork bomb pattern', re: /:\(\)\s*\{\s*:\|:&\s*\};:/ },
  { id: 'pipe-to-shell', label: 'remote script piped directly to a shell', re: /(curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(sh|bash|iex|Invoke-Expression|powershell)/i },
  { id: 'disable-defenses', label: 'disabling security tooling', re: /Set-MpPreference\s+-DisableRealtimeMonitoring|DisableAntiSpyware|netsh\s+advfirewall\s+set[^\n]*off|Disable-WindowsOptionalFeature/i },
  { id: 'credential-dump', label: 'credential dumping tool', re: /mimikatz|Invoke-Mimikatz|lsass\.dmp|procdump[^\n]*lsass/i },
  { id: 'reverse-shell', label: 'reverse shell / raw socket listener', re: /nc\s+-e\s|\/dev\/tcp\/|New-Object\s+System\.Net\.Sockets\.TCPClient/i },
];

function checkExecution(exec) {
  let text;
  try {
    text = JSON.stringify(exec.arguments);
  } catch (e) {
    return undefined; // unserializable arguments - nothing to scan, let policy elsewhere decide
  }
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      return `dsh-dashboard-guardian blocked "${exec.name}": matched a high-confidence malicious pattern (${rule.label}). `
        + `This is a preventive guard, not a judgment call about your intent — if this is a false positive, `
        + `disable this plugin (remove its entry from cordis.patch.yml) or narrow its rule set in guardian-plugin/index.js.`;
    }
  }
  return undefined;
}

function apply(ctx) {
  ctx.tools.guard(checkExecution);
}

export { apply, inject, name, RULES, checkExecution };
