// Optional OTLP/HTTP-JSON log receiver, so this dashboard can monitor a dsh
// instance it doesn't share a filesystem with.
//
// Grounded in @deepseek-ai/dsh-session-telemetry + dsh-session-telemetry-otel
// source (not guessed): dsh's OTel backend maps each session event to a
// log record via `logger.emit({ ...SEVERITY[record.severity], body: record.body,
// attributes: record.attributes })`, where (from identityOf() in
// dsh-session-telemetry/lib/index.js):
//   attributes = { "session.id", "event.type", "event.seq",
//                   "session.cwd"?, "session.parent_id"?, "session.seed_length"? }
//   body = structuredClone(event.data)   <- identical shape to our local
//                                            jsonl events' `.data` field
// The exporter package is @opentelemetry/exporter-logs-otlp-http, which sends
// standard OTLP JSON (not protobuf) to POST <exporter.url>, e.g. .../v1/logs.
//
// To point a dsh instance at this receiver, configure its
// sessionTelemetry-otel plugin (see this repo's README) with
// exporter.url: http://<this-dashboard-host>:<port>/v1/logs and mode: FULL.

const express = require('express');

const STALE_MS = 5 * 60_000; // no ingest from a session in 5min - the remote harness likely stopped/crashed

// otelSessions: Map<sessionId, { cwd, parentSession, createdAt, sourceHost,
//   firstReceivedAt, lastReceivedAt, eventsBySeq: Map<seq, event> }>
// firstReceivedAt/lastReceivedAt are THIS process's wall-clock receipt time,
// distinct from event.time (which is the remote harness's clock) - the two
// can diverge under network delay or OTel's own batching, and receipt time
// is what actually answers "is this remote harness still reporting in".
const otelSessions = new Map();

function decodeAnyValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue); // OTLP JSON encodes int64 as a string
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeAnyValue);
  if ('kvlistValue' in v) {
    const out = {};
    for (const kv of v.kvlistValue.values || []) out[kv.key] = decodeAnyValue(kv.value);
    return out;
  }
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

function attrsToObject(attributeList) {
  const out = {};
  for (const a of attributeList || []) out[a.key] = decodeAnyValue(a.value);
  return out;
}

function ingestLogRecord(record, sourceHost) {
  const attrs = attrsToObject(record.attributes);
  const sessionId = attrs['session.id'];
  if (!sessionId) return; // not one of ours (or malformed) - ignore rather than throw, one bad record shouldn't drop the batch

  const now = Date.now();
  if (!otelSessions.has(sessionId)) {
    otelSessions.set(sessionId, {
      cwd: null, parentSession: null, createdAt: null, sourceHost,
      firstReceivedAt: now, lastReceivedAt: now, eventsBySeq: new Map(),
    });
  }
  const sess = otelSessions.get(sessionId);
  sess.lastReceivedAt = now;
  sess.sourceHost = sourceHost; // last-writer-wins; a session shouldn't move hosts, but don't trust that
  if (attrs['session.cwd']) sess.cwd = attrs['session.cwd'];
  if (attrs['session.parent_id']) sess.parentSession = attrs['session.parent_id'];

  const timeUnixNano = record.timeUnixNano || record.observedTimeUnixNano;
  const time = timeUnixNano ? Math.round(Number(timeUnixNano) / 1e6) : now;
  const type = attrs['event.type'];
  const seq = attrs['event.seq'];
  if (type === 'session' && sess.createdAt == null) sess.createdAt = time;

  sess.eventsBySeq.set(seq, { type, seq, time, data: decodeAnyValue(record.body) });
}

function router() {
  const r = express.Router();
  r.use(express.json({ limit: '10mb' }));

  r.post('/v1/logs', (req, res) => {
    try {
      const sourceHost = req.ip || req.socket?.remoteAddress || 'unknown';
      const resourceLogs = req.body?.resourceLogs || [];
      let count = 0;
      for (const rl of resourceLogs) {
        for (const sl of rl.scopeLogs || []) {
          for (const record of sl.logRecords || []) {
            ingestLogRecord(record, sourceHost);
            count++;
          }
        }
      }
      res.json({ partialSuccess: {} }); // OTLP/HTTP success shape
      if (count) console.log(`[dsh-dashboard] otel: ingested ${count} log record(s) from ${sourceHost}, ${otelSessions.size} session(s) tracked`);
    } catch (e) {
      console.error('[dsh-dashboard] otel ingest failed:', e);
      res.status(400).json({ error: e.message });
    }
  });

  return r;
}

// Fleet health view: one row per remote session, independent of the
// dashboard/session tables' local+otel merge - this is specifically about
// "is this remote harness still reporting in", which event timestamps alone
// can't answer (a stalled exporter can leave old events looking recent).
function listFleetStatus() {
  const now = Date.now();
  return Array.from(otelSessions.entries()).map(([sessionId, sess]) => ({
    sessionId,
    cwd: sess.cwd,
    sourceHost: sess.sourceHost,
    eventCount: sess.eventsBySeq.size,
    firstReceivedAt: sess.firstReceivedAt,
    lastReceivedAt: sess.lastReceivedAt,
    healthy: (now - sess.lastReceivedAt) < STALE_MS,
  })).sort((a, b) => b.lastReceivedAt - a.lastReceivedAt);
}

// Returns entries shaped like lib/sessions.js's findSessionFiles() + a
// pre-decoded events array, so aggregate.js can treat OTel-sourced sessions
// uniformly alongside file-based ones.
function listOtelSessions() {
  const out = [];
  for (const [sessionId, sess] of otelSessions.entries()) {
    const events = Array.from(sess.eventsBySeq.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, ev]) => ev);
    out.push({ sessionId, cwd: sess.cwd, parentSession: sess.parentSession, events, source: 'otel' });
  }
  return out;
}

module.exports = { router, listOtelSessions, listFleetStatus, decodeAnyValue, STALE_MS };
