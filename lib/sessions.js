const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

function frameOffsets(buf, fromByte = 0) {
  const offsets = [];
  let idx = fromByte;
  while (true) {
    const found = buf.indexOf(ZSTD_MAGIC, idx);
    if (found === -1) break;
    offsets.push(found);
    idx = found + 4;
  }
  return offsets;
}

function decodeFrames(buf, offsets, startIdx) {
  let out = '';
  for (let i = startIdx; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      out += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch (e) {
      // corrupt/partial frame (e.g. mid-write) - skip
    }
  }
  return out;
}

// path -> { size, events, processedThroughByte }
const cache = new Map();

/**
 * Read a session's event log, decoding only the zstd frames appended since
 * the last read (each append batch is its own frame; the file only grows).
 * This is what makes frequent polling for a "live" view cheap even once a
 * session's log reaches hundreds of KB.
 */
function readSessionEvents(filePath) {
  const stat = fs.statSync(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.size === stat.size) return cached.events;

  const buf = fs.readFileSync(filePath);
  const offsets = frameOffsets(buf);

  let events, startIdx;
  if (cached && buf.length >= cached.processedThroughByte) {
    startIdx = offsets.findIndex(o => o >= cached.processedThroughByte);
    if (startIdx === -1) startIdx = offsets.length;
    events = cached.events.slice();
  } else {
    startIdx = 0;
    events = [];
  }

  const text = decodeFrames(buf, offsets, startIdx);
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch (e) { /* partial trailing line */ }
  }

  cache.set(filePath, { size: stat.size, events, processedThroughByte: buf.length });
  return events;
}

function findSessionFiles(sessionsRoot) {
  const results = [];
  if (!fs.existsSync(sessionsRoot)) return results;
  const workspaces = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const ws of workspaces) {
    const wsPath = path.join(sessionsRoot, ws.name);
    const sessionDirs = fs.readdirSync(wsPath, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const sd of sessionDirs) {
      const file = path.join(wsPath, sd.name, 'session.jsonl.zstd');
      if (fs.existsSync(file)) {
        results.push({ workspace: ws.name, sessionDir: sd.name, file });
      }
    }
  }
  return results;
}

module.exports = { readSessionEvents, findSessionFiles };
