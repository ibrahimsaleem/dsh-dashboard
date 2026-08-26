const { execFileSync } = require('child_process');

/**
 * Enumerate running `dsh` harness processes (any profile: web, tui,
 * headless...) by scanning process command lines. Excludes this dashboard's
 * own process and any node process that doesn't clearly look like a dsh
 * launch, so a false match can't kill something unrelated.
 */
function listHarnessProcesses() {
  let raw;
  try {
    raw = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress",
    ], { encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    return [];
  }
  let list;
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return [];
  }

  const results = [];
  for (const proc of list) {
    const cmd = proc.CommandLine || '';
    if (proc.ProcessId === process.pid) continue;
    if (!/@deepseek-ai[\\/]dsh\b/i.test(cmd) && !/[\\/]dsh[\\/]lib[\\/]bin\.js/i.test(cmd)) continue;
    if (/dsh-dashboard/i.test(cmd)) continue; // never target ourselves

    let profile = 'unknown';
    const profileMatch = cmd.match(/--profile[= ]("?)([\w-]+)\1/) || cmd.match(/\bbin\.js"?\s+(\w+)/);
    if (profileMatch) profile = profileMatch[2] || profileMatch[1];
    else if (/\bweb\b/.test(cmd)) profile = 'web';

    results.push({
      pid: proc.ProcessId,
      profile,
      commandLine: cmd,
      creationDate: proc.CreationDate || null,
    });
  }
  return results;
}

function killProcess(pid, reason) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 5000 });
    return { pid, ok: true, reason };
  } catch (e) {
    return { pid, ok: false, reason, error: e.message };
  }
}

function killAllHarnessProcesses(reason) {
  const procs = listHarnessProcesses();
  return procs.map(p => killProcess(p.pid, reason));
}

module.exports = { listHarnessProcesses, killProcess, killAllHarnessProcesses };
