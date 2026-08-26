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

let sessionId = null;
let oldestLoadedSeq = null;
let loadedCount = 0;

function itemHtml(ev) {
  if (ev.compact) {
    // Turn/step boundaries render as thin dividers, not full cards - these
    // are frequent (one pair per step) and mostly useful for orientation,
    // not detail, so they shouldn't dominate the scroll the way a 489-event
    // session's raw timeline otherwise would.
    return `<div class="tl-divider"><span>${timeStr(ev.time)}</span><span>${esc(ev.label)}</span></div>`;
  }
  return `
    <div class="tl-item">
      <div class="tl-time">${timeStr(ev.time)}</div>
      <div class="tl-body">
        <div class="tl-label"><span class="badge ${TYPE_COLOR[ev.type] || 'neutral'}">${esc(ev.type)}</span> ${esc(ev.label)}</div>
        <div class="tl-detail">${esc(ev.detail)}</div>
      </div>
    </div>`;
}

function renderPage(timeline, { prepend } = {}) {
  const html = timeline.map(itemHtml).join('');
  const container = document.getElementById('timeline');
  if (prepend) {
    container.insertAdjacentHTML('afterbegin', html);
  } else {
    container.innerHTML = html;
  }
  loadedCount += timeline.length;
  document.getElementById('tl-count').textContent = `${loadedCount} loaded`;
}

function renderLoadMore(hasMore) {
  const existing = document.getElementById('load-more-btn');
  if (existing) existing.remove();
  if (!hasMore) return;
  const btn = document.createElement('button');
  btn.id = 'load-more-btn';
  btn.className = 'btn';
  btn.style.cssText = 'display:block;margin-bottom:12px;width:100%';
  btn.textContent = 'Load earlier events';
  btn.onclick = () => loadPage(oldestLoadedSeq);
  document.getElementById('timeline').insertAdjacentElement('beforebegin', btn);
}

async function loadPage(beforeSeq) {
  const url = `/api/session/${encodeURIComponent(sessionId)}?limit=100${beforeSeq != null ? `&beforeSeq=${beforeSeq}` : ''}`;
  const res = await fetch(url);
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || 'failed to load');
  renderPage(d.timeline, { prepend: beforeSeq != null });
  oldestLoadedSeq = d.oldestSeq;
  renderLoadMore(d.hasMore);
  return d;
}

async function load() {
  const params = new URLSearchParams(location.search);
  sessionId = params.get('id');
  if (!sessionId) {
    document.getElementById('head-panel').innerHTML = '<div class="empty">No session id in URL (?id=...).</div>';
    return;
  }
  try {
    const d = await loadPage(null);
    document.getElementById('meta').textContent = `source: ${d.source}`;
    document.getElementById('head-panel').innerHTML = `
      <h2 style="margin-bottom:6px">${esc(sessionId)}</h2>
      <div class="session-sub mono">${esc(d.title || '')}</div>`;
  } catch (e) {
    document.getElementById('head-panel').innerHTML = `<div class="empty">error: ${esc(e.message)}</div>`;
  }
}

load();
