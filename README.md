# DSH Monitor

A local, real-time observability dashboard for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — token usage, cost, live agent activity, tool calls, permission/sandbox risk, and a reactive kill switch, all in one page.

![Overview](docs/screenshot-overview.jpg)
![Charts](docs/screenshot-charts.jpg)

## Why this exists

`dsh` is genuinely great — an open-source, plugin-composed agent harness that will happily run with `danger-full-access` sandboxing and no approval prompts if you tell it to. That's powerful. It's also exactly the kind of power that deserves a window into what's actually happening: how many tokens you've burned, what it's costing, what a running agent is doing *right now*, and whether anything it ran looked dangerous.

`dsh` doesn't ship anything like that today. The Web UI shows you one conversation at a time. There's no aggregate token/cost view, no cross-session activity feed, and no security signal beyond the raw per-session event log sitting on disk. If you're running multiple sessions, subagents, and workspaces — which the harness actively encourages — you're flying blind.

So this exists to fix that, entirely from the outside: **no `dsh` plugin, no fork, no changes to the harness at all.** It's a standalone Node app that reads the same files `dsh` already writes to disk and turns them into a live dashboard.

## What it shows

- **Headline stats** — sessions, running agents, harness processes, turns, prompts, tool calls, retries, errors, models connected, security findings, estimated cost
- **Live activity feed** — for every currently-running session: what it's doing right now (which tool, what command/description, or what it's reasoning/writing about), updated every 3 seconds
- **Token composition** and **session permission risk**, as donut charts
- **Activity sparkline** — tool calls per minute over the last 30 minutes
- **Tool-call and cost breakdowns** by name/model, as bar charts
- **Security findings** — a heuristic scanner runs over every prompt and tool-call argument in the logs, flagging destructive filesystem ops, pipe-to-shell patterns, credential dumping, reverse shells, secret literals, persistence mechanisms, and more
- **Permission/sandbox timeline** — every preset/sandbox/approval change across every session, flagged when it lands on `danger-full-access` or `never`
- **Estimated cost**, researched against real OpenRouter/DeepSeek pricing (see `lib/pricing.json`), split per session by which model(s) it actually used
- **Kill switch** — see below

## The kill switch

A toggle that arms a watchdog: the instant a *high-confidence* malicious pattern shows up in a fresh tool call (fork bomb, `curl | sh`-style pipe-to-shell, security-tool disabling, credential dumping, reverse shell), it force-kills every detected `dsh` process. There's also a manual "Stop harness now" button for an immediate kill regardless of arming state.

**Be clear-eyed about what this is and isn't:**

- It's **reactive, not preventive**. It can only act after `dsh` has already logged the tool call to disk — for a fast, single-shot destructive command, execution may finish before the kill lands. Treat it as a fast circuit breaker, not a guarantee.
- Auto-kill is deliberately restricted to a short allowlist of low-false-positive patterns. Things like `rm -rf` or `taskkill /f` are flagged and shown in the findings list, but excluded from auto-kill, because they're routine in normal dev work (`rm -rf node_modules`, killing a stuck dev server) and would make the switch fire constantly on legitimate commands.
- A real *preventive* block would need to hook into `dsh`'s own approval/permission pipeline as a harness plugin — a materially deeper (and riskier) integration than reading log files. This is the honest, lower-risk version: fast detection and a hard stop, not a guarantee nothing dangerous ever runs.

## How it works (no `dsh` plugin required)

Everything is read directly from `~/.dsh` on disk, on a polling loop:

| Data | Source | Notes |
|---|---|---|
| Model/provider inventory | `~/.dsh/settings.yaml` (`llm-pi-ai.providers`) | Parsed with `js-yaml` |
| Per-session tokens, turns, running state | `~/.dsh/storages/session_projcache.json` | `sessionStats.openStep != null` is the "is this agent running right now" signal |
| Full event stream (tool calls, prompts, permission changes) | `~/.dsh/sessions/**/session.jsonl.zstd` | See below — this was the hard part |
| Harness processes | Windows process scan (`Get-CimInstance Win32_Process`) | Filtered to `@deepseek-ai/dsh` command lines only, dashboard's own process excluded |
| Credential presence | `HKCU\Environment` registry read | `process.env` alone only reflects vars set before *this* process started, not `dsh web`'s environment or a `setx` issued after either launched |

### The zstd multi-frame log format

`dsh` session logs are `session.jsonl.zstd` — but not a single zstd stream. Each append batch is compressed as its **own independent zstd frame**, and the frames are just concatenated in the file. Node's one-shot `zlib.zstdDecompressSync()` (and even the streaming `createZstdDecompress()`) only reads the *first* frame and silently stops there.

`lib/sessions.js` scans for zstd magic bytes (`28 B5 2F FD`) to find each frame's start offset, decompresses each frame separately, and concatenates the results. It also caches per-file decode state (size + last processed byte offset) so a poll only decodes *newly appended* frames instead of re-decoding the whole file every 3 seconds — this is what keeps the live view fast even as a session log grows past a megabyte.

## Cost estimation

`lib/pricing.json` holds researched per-model pricing (USD / 1M tokens). A session's cost is split across whichever model(s) it used, weighted by each model's share of requests within that session (the log only carries per-session token totals, not a per-request breakdown, so this is a weighted approximation, not exact accounting). Models with no pricing entry are marked as unknown rather than silently costed at $0.

## Running it

```bash
npm install
npm start
```

Opens on `http://127.0.0.1:4590`, bound to localhost only. Override with `DASHBOARD_PORT` and `DSH_HOME` env vars if needed.

## What's next

This started as "I want to see what my harness is doing" and turned into a real observability layer built entirely from the outside. Ideas for where this goes next:

- Historical trend charts (cost/tokens over days, not just a live snapshot)
- Per-session drill-down pages with the full timeline
- CSV/JSON export
- OpenTelemetry bridge (`dsh` already ships `dsh-session-telemetry-otel` — wiring this dashboard to consume that instead of/alongside raw log polling would make it work for remote/multi-machine harness deployments, not just local)
- A real preventive mode, built as an actual `dsh` plugin hooking the approval pipeline, once the read-only version has proven itself

Contributions and ideas welcome — this is meant to be a starting point for harness observability, not a finished product.

## License

MIT
