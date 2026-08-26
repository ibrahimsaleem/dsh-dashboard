// Redaction for OTel-ingested event bodies. dsh-session-telemetry-otel's own
// README is explicit that FULL mode "ships no redaction rules" and exports
// "the complete event.data as-is - user and assistant message content, tool
// arguments and results (command output, file contents), the full system
// prompt and tool schemas" - so a dashboard that receives that over the
// network is a second place secrets could leak, on top of whatever already
// leaked to the remote dsh process's own memory. This redacts at ingest
// time (lib/otel.js calls redactValue() before ever storing a record), not
// at read time, so nothing unredacted is retained even in-process memory.
//
// Off by default is NOT an option here: a receiver that might sit on a
// shared network should default to safe. Set DASHBOARD_OTEL_REDACT=false
// to disable (e.g. for a trusted loopback-only setup where you want the
// full unredacted timeline).

const REDACTED = '[REDACTED]';

// Key names that mean "redact this whole value, whatever it looks like" -
// far more reliable than pattern-matching the value, and low false-positive
// (a key named `apiKey` is never something you want to keep raw).
const SENSITIVE_KEY_RE = /password|secret|token|api[_-]?key|credential|authorization|private[_-]?key/i;

// Value-shaped patterns, for strings that aren't already caught by key name
// (e.g. a secret pasted into free-text message content or a shell command).
const VALUE_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT-shaped
];

function redactString(s) {
  let out = s;
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

function redactValue(value, keyHint) {
  if (typeof value === 'string') {
    if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) return REDACTED;
    // dsh's own event shape carries tool call arguments as a JSON-encoded
    // string (not a nested object), which would otherwise hide key-based
    // redaction (a `"password": "..."` inside that string is still just
    // text to the string branch above) - so recurse through JSON-looking
    // strings too, re-encoding after redaction.
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        return JSON.stringify(redactValue(parsed));
      } catch (e) { /* not actually JSON - fall through to plain string handling */ }
    }
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map(v => redactValue(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}

function isEnabled() {
  return process.env.DASHBOARD_OTEL_REDACT !== 'false';
}

module.exports = { redactValue, isEnabled, REDACTED };
