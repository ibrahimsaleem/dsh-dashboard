// Reduces a session's full raw event stream (thousands of chunk-level
// streaming events) down to the events actually worth showing a human:
// prompts, tool calls/results, turn/step boundaries, permission changes,
// and final assistant messages. Streaming chunk types
// (assistant/chunk, reasoning-chunks, text-chunks, tool-call-chunks,
// agent/inbox/spliced) are dropped - their content is already reconstructed
// in the corresponding tool/call, tool/result, and assistant/message events.

const KEPT_TYPES = new Set([
  'session', 'permission/preset', 'sandbox/mode', 'approval/policy',
  'command/run', 'command/done', 'turn/start', 'turn/end',
  'step/start', 'step/end', 'user/message', 'tool/call', 'tool/result',
  'assistant/message', 'todo/write', 'llm/retry', 'session/title',
]);

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

function summarize(ev) {
  // Unlike every other event type, `session` carries its fields at the top
  // level (id/cwd/origin/...) rather than nested under `.data`.
  if (ev.type === 'session') {
    return { label: 'session started', detail: `cwd: ${ev.cwd || ''}${ev.origin ? ` (${ev.origin})` : ''}` };
  }
  const d = ev.data || {};
  switch (ev.type) {
    case 'permission/preset':
      return { label: `permission preset -> ${d.preset}`, detail: '' };
    case 'sandbox/mode':
      return { label: `sandbox mode -> ${d.mode}`, detail: '' };
    case 'approval/policy':
      return { label: `approval policy -> ${d.policy}`, detail: '' };
    case 'command/run':
      return { label: `/${d.name}${d.args || ''}`, detail: `source: ${d.source?.kind || 'unknown'}` };
    case 'command/done':
      return { label: `command ${d.kind}`, detail: d.text || '' };
    case 'turn/start':
      return { label: `turn ${d.turn} started`, detail: '' };
    case 'turn/end':
      return { label: `turn ${d.turn} ended (${d.reason?.kind || '?'})`, detail: d.reason?.error?.message || '' };
    case 'step/start':
      return { label: `step: turn ${d.turn}, step ${d.step}`, detail: '' };
    case 'step/end':
      return { label: `step done: turn ${d.turn}, step ${d.step}`, detail: '' };
    case 'user/message':
      return { label: `prompt (${d.source?.kind || 'user'})`, detail: textOf(d.content).slice(0, 2000) };
    case 'tool/call': {
      let args = d.arguments;
      try { args = JSON.stringify(JSON.parse(d.arguments), null, 2); } catch (e) {}
      return { label: `tool call: ${d.name}`, detail: String(args).slice(0, 2000) };
    }
    case 'tool/result': {
      const content = d.message?.content?.find(c => c.type === 'tool-result');
      const text = content ? textOf(content.content) : '';
      return { label: 'tool result', detail: text.slice(0, 2000) };
    }
    case 'assistant/message': {
      const text = textOf(d.message?.content);
      return { label: 'assistant message', detail: text.slice(0, 2000) };
    }
    case 'todo/write':
      return { label: `todo list updated (${(d.todos || []).length} items)`, detail: (d.todos || []).map(t => `[${t.status}] ${t.content}`).join('\n') };
    case 'llm/retry':
      return { label: `llm retry (${d.retry}/${d.maxRetries})`, detail: d.failure?.message || '' };
    case 'session/title':
      return { label: `title set: "${d.title}"`, detail: '' };
    default:
      return { label: ev.type, detail: '' };
  }
}

function buildTimeline(events, { limit = 500 } = {}) {
  const kept = events.filter(e => KEPT_TYPES.has(e.type));
  const sliced = kept.slice(-limit);
  return sliced.map(ev => ({
    seq: ev.seq ?? null,
    time: ev.time ?? null,
    type: ev.type,
    ...summarize(ev),
  }));
}

module.exports = { buildTimeline };
