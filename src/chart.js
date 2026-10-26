// Responsive SVG line chart with crosshair tooltip. No dependencies.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/**
 * @param {HTMLElement} el
 * @param {object} o
 *   series: [{ id, name, color, v: (number|null)[], dash?: string, thin?: boolean }]
 *   labels: string[]           month label per point
 *   yearOf: (k) => number|null year to tick at point k (first month of a year), else null
 *   unit: 'money' | 'pct' | 'index'
 *   log: boolean
 *   fmt: (v) => string         full formatter for tooltip
 *   fmtAxis: (v) => string     compact formatter for axis
 */
export function drawChart(el, o) {
  const cw = Math.max(280, el.clientWidth || 800);
  const W = 1000, sc = W / cw;
  const narrow = cw < 640;
  const H = Math.round(narrow ? W * 0.95 : Math.min(500, W * 0.5));
  const fs = 11.5 * sc, Tp = 10 * sc, B = 28 * sc, Rm = 10 * sc;
  const all = o.series.flatMap((s) => s.v).filter((v) => v != null && Number.isFinite(v));
  if (!all.length) { el.innerHTML = '<p class="empty">Nothing to show. Turn on at least one line.</p>'; return; }

  let y, ticks = [], fmtTick;
  const log = o.log && o.unit !== 'pct';
  let L;
  if (log) {
    const pos = all.filter((v) => v > 0);
    const maxV = Math.max(...pos), minV = Math.min(...pos);
    const lo = Math.pow(10, Math.floor(Math.log10(Math.max(minV, maxV / 1e9))));
    const top = Math.pow(10, Math.ceil(Math.log10(maxV)));
    const span = Math.log10(top) - Math.log10(lo) || 1;
    const step = span > 7 ? 2 : 1;
    for (let e = Math.log10(lo); e <= Math.log10(top) + 1e-9; e += step) ticks.push(Math.pow(10, e));
    if (span <= 2) { // add 2× and 5× ticks for short ranges
      const extra = [];
      for (const t of ticks) for (const m of [2, 5]) if (t * m < top) extra.push(t * m);
      ticks = ticks.concat(extra).sort((a, b) => a - b);
    }
    y = (v) => Tp + (H - Tp - B) * (1 - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / span);
  } else {
    let minV = Math.min(0, ...all), maxV = Math.max(...all);
    if (maxV === minV) maxV = minV + 1;
    const step = niceStep((maxV - minV) / (narrow ? 4 : 5));
    const lo = Math.floor(minV / step) * step, top = Math.ceil(maxV / step) * step;
    for (let v = lo; v <= top + step / 1e6; v += step) ticks.push(+v.toFixed(10));
    y = (v) => Tp + (H - Tp - B) * (1 - (v - lo) / (top - lo));
  }
  fmtTick = o.fmtAxis;
  const labelsW = Math.max(...ticks.map((t) => fmtTick(t).length));
  L = (labelsW * 7.2 + 14) * sc;

  const n = o.labels.length - 1;
  const x = (k) => L + (W - L - Rm) * (n ? k / n : 0.5);
  const mono = `font-family="JetBrains Mono, ui-monospace, monospace" font-size="${fs.toFixed(1)}" fill="var(--muted)"`;
  let g = '';
  for (const t of ticks) {
    const yy = y(t).toFixed(1);
    const zero = o.unit === 'pct' && Math.abs(t) < 1e-9;
    g += `<line x1="${L}" x2="${W - Rm}" y1="${yy}" y2="${yy}" stroke="${zero ? 'var(--muted)' : 'var(--line)'}" stroke-width="${sc}"/>`;
    g += `<text x="${(L - 8 * sc).toFixed(1)}" y="${(+yy + fs / 3).toFixed(1)}" text-anchor="end" ${mono}>${esc(fmtTick(t))}</text>`;
  }
  // year ticks
  const yearsSpan = n / 12;
  const every = yearsSpan > 12 ? (narrow ? 4 : 2) : yearsSpan > 6 ? (narrow ? 2 : 1) : 1;
  for (let k = 0; k <= n; k++) {
    const yr = o.yearOf(k);
    if (yr != null && yr % every === 0) {
      g += `<line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${H - B}" y2="${(H - B + 5 * sc).toFixed(1)}" stroke="var(--muted)" stroke-width="${sc}"/>`;
      g += `<text x="${x(k).toFixed(1)}" y="${(H - 8 * sc).toFixed(1)}" text-anchor="middle" ${mono}>${yr}</text>`;
    }
  }
  const path = (v) => {
    let d = '', pen = false;
    v.forEach((val, k) => {
      if (val == null || !Number.isFinite(val) || (log && val <= 0)) { pen = false; return; }
      d += (pen ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(val).toFixed(1);
      pen = true;
    });
    return d;
  };
  const sw = 2 * sc;
  for (const s of o.series) {
    const last = [...s.v].reverse().find((v) => v != null);
    g += `<path d="${path(s.v)}" fill="none" stroke="${s.color}" stroke-width="${(s.thin ? sw * 0.8 : sw).toFixed(2)}" ${s.dash ? `stroke-dasharray="${s.dash.split(' ').map((d) => d * sc).join(' ')}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    if (!s.dash && last != null && (!log || last > 0)) g += `<circle cx="${x(n).toFixed(1)}" cy="${y(last).toFixed(1)}" r="${(3.5 * sc).toFixed(1)}" fill="${s.color}"/>`;
  }
  g += `<line class="hov" x1="0" x2="0" y1="${Tp}" y2="${H - B}" stroke="var(--muted)" stroke-width="${sc}" visibility="hidden"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Chart')}">${g}<rect x="${L}" y="0" width="${W - L - Rm}" height="${H - B}" fill="transparent"/></svg><div class="tip" hidden></div>`;

  const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), hov = el.querySelector('.hov');
  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) * W) / rect.width;
    const k = Math.max(0, Math.min(n, Math.round(((px - L) / (W - L - Rm)) * n)));
    hov.setAttribute('x1', x(k)); hov.setAttribute('x2', x(k)); hov.setAttribute('visibility', 'visible');
    const rows = o.series.filter((s) => s.v[k] != null).sort((a, b) => b.v[k] - a.v[k]);
    const max = narrow ? 8 : 14;
    tip.innerHTML = `<b>${esc(o.labels[k])}</b>` + rows.slice(0, max).map((s) => `<div class="r"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><span>${esc(o.fmt(s.v[k]))}</span></div>`).join('') + (rows.length > max ? `<div class="r"><span>+${rows.length - max} more</span></div>` : '');
    tip.hidden = false;
    const tw = tip.offsetWidth, left = (x(k) * rect.width) / W;
    const elW = el.clientWidth;
    tip.style.left = (left + 14 + tw > elW ? Math.max(0, left - 14 - tw) : left + 14) + 'px';
    tip.style.top = '4px';
  };
  const hide = () => { tip.hidden = true; hov.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
}
