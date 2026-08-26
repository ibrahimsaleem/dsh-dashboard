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

// otelSessions: Map<sessionId, { cwd, parentSession, createdAt, eventsBySeq: Map<seq, event> }>
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

function ingestLogRecord(record) {
  const attrs = attrsToObject(record.attributes);
  const sessionId = attrs['session.id'];
  if (!sessionId) return; // not one of ours (or malformed) - ignore rather than throw, one bad record shouldn't drop the batch

  if (!otelSessions.has(sessionId)) {
    otelSessions.set(sessionId, { cwd: null, parentSession: null, createdAt: null, eventsBySeq: new Map() });
  }
  const sess = otelSessions.get(sessionId);
  if (attrs['session.cwd']) sess.cwd = attrs['session.cwd'];
  if (attrs['session.parent_id']) sess.parentSession = attrs['session.parent_id'];

  const timeUnixNano = record.timeUnixNano || record.observedTimeUnixNano;
  const time = timeUnixNano ? Math.round(Number(timeUnixNano) / 1e6) : Date.now();
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
      const resourceLogs = req.body?.resourceLogs || [];
      let count = 0;
      for (const rl of resourceLogs) {
        for (const sl of rl.scopeLogs || []) {
          for (const record of sl.logRecords || []) {
            ingestLogRecord(record);
            count++;
          }
        }
      }
      res.json({ partialSuccess: {} }); // OTLP/HTTP success shape
      if (count) console.log(`[dsh-dashboard] otel: ingested ${count} log record(s), ${otelSessions.size} session(s) tracked`);
    } catch (e) {
      console.error('[dsh-dashboard] otel ingest failed:', e);
      res.status(400).json({ error: e.message });
    }
  });

  return r;
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

module.exports = { router, listOtelSessions, decodeAnyValue };
