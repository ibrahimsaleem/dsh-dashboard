// Small dependency-free SVG chart helpers. Everything here returns an HTML
// string; no canvas, no external chart library - keeps this dashboard
// self-contained and fast to load.

function svgDonut(segments, { size = 140, thickness = 20 } = {}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  let offset = 0;
  const cx = size / 2, cy = size / 2;
  const circles = segments.filter(s => s.value > 0).map(s => {
    const frac = s.value / total;
    const dash = frac * c;
    const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}"
      stroke-width="${thickness}" stroke-dasharray="${dash} ${c - dash}"
      stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt">
      <title>${s.label}: ${s.value.toLocaleString()}</title>
    </circle>`;
    offset += dash;
    return circle;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${circles}</svg>`;
}

function donutWithLegend(segments, opts) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const donut = svgDonut(segments, opts);
  const legend = segments.map(s => {
    const pct = total ? (s.value / total * 100).toFixed(1) : '0.0';
    return `<div class="legend-row">
      <span class="sw" style="background:${s.color}"></span>
      <span class="legend-label">${s.label}</span>
      <span class="legend-val">${s.value.toLocaleString()} <span class="legend-pct">(${pct}%)</span></span>
    </div>`;
  }).join('');
  return `<div class="donut-wrap"><div class="donut-svg">${donut}</div><div class="donut-legend">${legend}</div></div>`;
}

function svgSparkline(points, { width = 300, height = 64, color = '#6d83f2' } = {}) {
  const max = Math.max(1, ...points);
  const stepX = width / Math.max(1, points.length - 1);
  const coords = points.map((v, i) => [i * stepX, height - (v / max) * (height - 6) - 3]);
  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;
  const id = 'spark' + Math.random().toString(36).slice(2, 8);
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${areaPath}" fill="url(#${id})" stroke="none"/>
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function hbar(rows, { color = 'var(--accent)', formatVal = (v) => v.toLocaleString() } = {}) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return rows.map(r => `
    <div class="bar-row">
      <div class="name mono">${r.label}</div>
      <div class="track"><div class="fill" style="width:${(r.value / max * 100).toFixed(1)}%;background:${r.color || color}"></div></div>
      <div class="num">${formatVal(r.value)}</div>
    </div>`).join('');
}
