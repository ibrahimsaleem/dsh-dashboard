function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function timeStr(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const TYPE_COLOR = {
  'user/message': 'good', 'tool/call': 'accent', 'tool/result': 'neutral',
  'assistant/message': 'accent', 'turn/start': 'neutral', 'turn/end': 'neutral',
  'permission/preset': 'danger', 'sandbox/mode': 'danger', 'approval/policy': 'danger',
  'llm/retry': 'medium', 'command/run': 'neutral', 'command/done': 'neutral',
};

async function load() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) {
    document.getElementById('head-panel').innerHTML = '<div class="empty">No session id in URL (?id=...).</div>';
    return;
  }
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(id)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'failed to load');

    document.getElementById('meta').textContent = `source: ${d.source}`;
    document.getElementById('head-panel').innerHTML = `
      <h2 style="margin-bottom:6px">${esc(id)}</h2>
      <div class="session-sub mono">${esc(d.title || '')}</div>`;

    document.getElementById('tl-count').textContent = `${d.timeline.length} events`;
    document.getElementById('timeline').innerHTML = d.timeline.length
      ? d.timeline.map(ev => `
        <div class="tl-item">
          <div class="tl-time">${timeStr(ev.time)}</div>
          <div class="tl-body">
            <div class="tl-label"><span class="badge ${TYPE_COLOR[ev.type] || 'neutral'}">${esc(ev.type)}</span> ${esc(ev.label)}</div>
            <div class="tl-detail">${esc(ev.detail)}</div>
          </div>
        </div>`).join('')
      : '<div class="empty">No timeline events.</div>';
  } catch (e) {
    document.getElementById('head-panel').innerHTML = `<div class="empty">error: ${esc(e.message)}</div>`;
  }
}

load();
