// Charts. Two hues carry the whole system: gold is money, aqua is time.
// Both were validated against the card surface (#24221f) for the dark
// lightness band, chroma floor, CVD separation and >=3:1 contrast.
//
// The after-tax rate is deliberately NOT a third hue: it is the same measure
// at a lower level, so it is drawn as the same gold, dashed, with the gap
// between the two filled. That shows the tax bite as an area and avoids
// spending a categorical slot on something that isn't a separate entity.

import * as S from './stats.js';

const MONEY = '#c98500';
const TIME = '#199e70';
const GRID = '#3a3733';
const INK = '#9b958a';
const FAINT = '#6f6a61';

const money0 = (c) => '$' + Math.round(c / 100).toLocaleString();
const money2 = (c) => '$' + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const monthLabel = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short' });
const dateLabel = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// "Nice" axis ceiling so gridlines land on readable numbers.
function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag * 2) / 2 * mag;
}

function frame({ w, h, pad, title, note }) {
  return { w, h, pad, title, note, inner: { w: w - pad.l - pad.r, h: h - pad.t - pad.b } };
}

function card(title, note, svg, legend = '') {
  return `<div class="card chart">
    <h2 class="card-title">${esc(title)}</h2>
    ${note ? `<p class="chart-note">${esc(note)}</p>` : ''}
    ${legend}
    <div class="chart-hold">${svg}<div class="tip" hidden></div></div>
  </div>`;
}

// ── rolling effective rate ────────────────────────────────────────

function rateChart(data, { jobId, now, width }) {
  const series = S.rollingRateSeries(data, { windowDays: 90, stepDays: 7, jobId, now })
    .filter((p) => p.rateCents !== null);

  if (series.length < 2) {
    return card('Effective rate over time',
      'Once there are 90 days of hours and at least one deposit inside the window, the trend appears here.',
      '<p class="empty">Not enough history yet.</p>');
  }

  const pad = { t: 14, r: 58, b: 26, l: 8 };
  const f = frame({ w: width, h: 188, pad });
  const max = niceMax(Math.max(...series.map((p) => p.rateCents)) * 1.12);
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * f.inner.w;
  const y = (c) => pad.t + f.inner.h - (c / max) * f.inner.h;

  const line = (key) => series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const band =
    series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.rateCents).toFixed(1)}`).join('') +
    series.slice().reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.netRateCents).toFixed(1)}`).join('') + 'Z';

  const ticks = [0, max / 2, max];
  const last = series[series.length - 1];

  const svg = `
  <svg viewBox="0 0 ${f.w} ${f.h}" width="100%" height="${f.h}" role="img"
       aria-label="Rolling 90-day effective rate, currently ${money2(last.rateCents)} per hour">
    ${ticks.map((v) => `
      <line x1="${pad.l}" x2="${pad.l + f.inner.w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
            stroke="${GRID}" stroke-width="1"/>
      <text x="${pad.l + f.inner.w + 6}" y="${(y(v) + 3.5).toFixed(1)}" fill="${FAINT}" font-size="10">${money0(v)}</text>`).join('')}
    <path d="${band}" fill="${MONEY}" opacity="0.09"/>
    <path d="${line('netRateCents')}" fill="none" stroke="${MONEY}" stroke-width="2"
          stroke-dasharray="3 3" opacity="0.75" stroke-linejoin="round"/>
    <path d="${line('rateCents')}" fill="none" stroke="${MONEY}" stroke-width="2"
          stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(last.t).toFixed(1)}" cy="${y(last.rateCents).toFixed(1)}" r="4"
            fill="${MONEY}" stroke="#24221f" stroke-width="2"/>
    <text x="${pad.l}" y="${f.h - 8}" fill="${FAINT}" font-size="10">${esc(dateLabel(t0))}</text>
    <text x="${pad.l + f.inner.w}" y="${f.h - 8}" fill="${FAINT}" font-size="10" text-anchor="end">${esc(dateLabel(t1))}</text>
    <g class="hover" hidden>
      <line class="cross" y1="${pad.t}" y2="${pad.t + f.inner.h}" stroke="${INK}" stroke-width="1" opacity=".5"/>
      <circle class="dot" r="4.5" fill="${MONEY}" stroke="#24221f" stroke-width="2"/>
    </g>
    <rect class="capture" x="${pad.l}" y="${pad.t}" width="${f.inner.w}" height="${f.inner.h}" fill="transparent"/>
  </svg>`;

  const legend = `<div class="legend">
    <span><i style="background:${MONEY}"></i>Effective rate</span>
    <span><i class="dash" style="background:${MONEY}"></i>After the tax you set aside</span>
  </div>`;

  const points = series.map((p) => ({ x: x(p.t), y: y(p.rateCents), t: p.t, p }));
  return {
    html: card('Effective rate over time',
      'Each point divides the deposits of the previous 90 days by the hours worked in the same span.',
      svg, legend),
    wire: (root) => wireCrosshair(root, points, (p) =>
      `<b>${dateLabel(p.t)}</b><span>${money2(p.p.rateCents)}/hr</span>` +
      `<span class="dim">${money2(p.p.netRateCents)}/hr after tax</span>` +
      `<span class="dim">${p.p.hours.toFixed(1)}h · ${money0(p.p.incomeCents)} in the window</span>`),
  };
}

// ── monthly bars ──────────────────────────────────────────────────

function barChart(buckets, { width, title, note, color, value, format, ariaUnit }) {
  const vals = buckets.map(value);
  if (!vals.some((v) => v > 0)) {
    return { html: card(title, note, '<p class="empty">Nothing logged yet.</p>'), wire: null };
  }
  const pad = { t: 12, r: 52, b: 24, l: 8 };
  const f = frame({ w: width, h: 168, pad });
  const max = niceMax(Math.max(...vals) * 1.1);
  const n = buckets.length;
  const slot = f.inner.w / n;
  const bw = Math.max(6, Math.min(34, slot - 6));
  const y = (v) => pad.t + f.inner.h - (v / max) * f.inner.h;

  const bars = buckets.map((b, i) => {
    const v = value(b);
    const cx = pad.l + slot * i + slot / 2;
    const h = Math.max(v > 0 ? 2 : 0, pad.t + f.inner.h - y(v));
    return `<rect class="bar" data-i="${i}" x="${(cx - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}"
      width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${color}"
      opacity="${v > 0 ? 1 : 0.25}"/>`;
  }).join('');

  // Label every third month so the axis stays readable at phone width.
  const labels = buckets.map((b, i) =>
    (i % 3 === n % 3 || i === n - 1)
      ? `<text x="${(pad.l + slot * i + slot / 2).toFixed(1)}" y="${f.h - 7}" fill="${FAINT}"
              font-size="10" text-anchor="middle">${esc(monthLabel(b.from))}</text>` : '').join('');

  const svg = `
  <svg viewBox="0 0 ${f.w} ${f.h}" width="100%" height="${f.h}" role="img"
       aria-label="${esc(title)}: latest ${format(value(buckets[n - 1]))} ${esc(ariaUnit)}">
    ${[0, max / 2, max].map((v) => `
      <line x1="${pad.l}" x2="${pad.l + f.inner.w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
            stroke="${GRID}" stroke-width="1"/>
      <text x="${pad.l + f.inner.w + 6}" y="${(y(v) + 3.5).toFixed(1)}" fill="${FAINT}" font-size="10">${esc(format(v))}</text>`).join('')}
    ${bars}${labels}
  </svg>`;

  return {
    html: card(title, note, svg),
    wire: (root) => wireBars(root, buckets, (b) =>
      `<b>${new Date(b.from).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b>` +
      `<span>${format(value(b))} ${esc(ariaUnit)}</span>`),
  };
}

// ── working pattern ───────────────────────────────────────────────

function patternChart(data, { jobId, now, width }) {
  const from = S.addDays(S.startOfDay(now), -180);
  const grid = S.heatmap(data, { jobId, now, from, to: now + 1 });
  const max = Math.max(...grid.flat());
  if (max <= 0) return { html: card('When you actually work', '', '<p class="empty">Nothing logged yet.</p>'), wire: null };

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const padL = 30, padT = 14, padB = 18;
  const cw = (width - padL - 4) / 24;
  const ch = 15;
  const h = padT + ch * 7 + padB;

  let cells = '';
  for (let d = 0; d < 7; d++) {
    for (let hr = 0; hr < 24; hr++) {
      const v = grid[d][hr];
      // Sequential: one hue, opacity carries magnitude, floored so an
      // occupied cell is never invisible.
      const o = v > 0 ? 0.16 + 0.84 * Math.sqrt(v / max) : 0;
      cells += `<rect class="cell" data-d="${d}" data-h="${hr}" data-v="${v.toFixed(2)}"
        x="${(padL + hr * cw + 1).toFixed(1)}" y="${padT + d * ch + 1}"
        width="${Math.max(1, cw - 2).toFixed(1)}" height="${ch - 2}" rx="2"
        fill="${v > 0 ? TIME : '#2c2a26'}" opacity="${v > 0 ? o.toFixed(2) : 1}"/>`;
    }
  }
  const rowLabels = days.map((d, i) =>
    `<text x="0" y="${padT + i * ch + 11}" fill="${FAINT}" font-size="10">${d}</text>`).join('');
  const colLabels = [0, 6, 12, 18].map((hr) =>
    `<text x="${(padL + hr * cw).toFixed(1)}" y="${h - 5}" fill="${FAINT}" font-size="10">${hr === 0 ? '12a' : hr === 12 ? '12p' : hr > 12 ? hr - 12 + 'p' : hr + 'a'}</text>`).join('');

  const svg = `<svg viewBox="0 0 ${width} ${h}" width="100%" height="${h}" role="img"
    aria-label="Hours worked by day of week and hour of day over the last 180 days">
    ${rowLabels}${cells}${colLabels}</svg>`;

  return {
    html: card('When you actually work', 'Hours logged by weekday and time of day, over the last 180 days.', svg),
    wire: (root) => wireCells(root, days),
  };
}

// ── interaction ───────────────────────────────────────────────────

function tipFor(root) {
  return { svg: root.querySelector('svg'), tip: root.querySelector('.tip'), hold: root.querySelector('.chart-hold') };
}

function place(hold, tip, px, py) {
  tip.hidden = false;
  const w = tip.offsetWidth;
  const x = Math.max(4, Math.min(hold.clientWidth - w - 4, px - w / 2));
  tip.style.transform = `translate(${x}px, ${Math.max(0, py - tip.offsetHeight - 12)}px)`;
}

function wireCrosshair(root, points, render) {
  const { svg, tip, hold } = tipFor(root);
  const capture = svg.querySelector('.capture');
  const hover = svg.querySelector('.hover');
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.dot');

  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const scale = svg.viewBox.baseVal.width / r.width;
    const mx = (e.clientX - r.left) * scale;
    let best = points[0];
    for (const p of points) if (Math.abs(p.x - mx) < Math.abs(best.x - mx)) best = p;
    hover.removeAttribute('hidden');
    cross.setAttribute('x1', best.x); cross.setAttribute('x2', best.x);
    dot.setAttribute('cx', best.x); dot.setAttribute('cy', best.y);
    tip.innerHTML = render(best);
    place(hold, tip, best.x / scale, best.y / scale);
  };
  const leave = () => { hover.setAttribute('hidden', ''); tip.hidden = true; };

  capture.addEventListener('pointermove', move);
  capture.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
}

function wireBars(root, buckets, render) {
  const { svg, tip, hold } = tipFor(root);
  svg.querySelectorAll('.bar').forEach((bar) => {
    const show = () => {
      const r = svg.getBoundingClientRect();
      const scale = svg.viewBox.baseVal.width / r.width;
      tip.innerHTML = render(buckets[+bar.dataset.i]);
      place(hold, tip, (+bar.getAttribute('x') + +bar.getAttribute('width') / 2) / scale, +bar.getAttribute('y') / scale);
      bar.style.filter = 'brightness(1.25)';
    };
    bar.addEventListener('pointerenter', show);
    bar.addEventListener('pointerdown', show);
    bar.addEventListener('pointerleave', () => { tip.hidden = true; bar.style.filter = ''; });
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
}

function wireCells(root, days) {
  const { svg, tip, hold } = tipFor(root);
  svg.querySelectorAll('.cell').forEach((cell) => {
    const show = () => {
      const v = +cell.dataset.v;
      if (v <= 0) { tip.hidden = true; return; }
      const r = svg.getBoundingClientRect();
      const scale = svg.viewBox.baseVal.width / r.width;
      const hr = +cell.dataset.h;
      tip.innerHTML = `<b>${days[+cell.dataset.d]} ${hr === 0 ? '12am' : hr === 12 ? '12pm' : hr > 12 ? hr - 12 + 'pm' : hr + 'am'}</b><span>${v.toFixed(1)}h logged</span>`;
      place(hold, tip, (+cell.getAttribute('x') + +cell.getAttribute('width') / 2) / scale, +cell.getAttribute('y') / scale);
    };
    cell.addEventListener('pointerenter', show);
    cell.addEventListener('pointerdown', show);
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
}

// ── entry point ───────────────────────────────────────────────────

let resizeBound = false;
let lastArgs = null;

export function renderCharts(container, data, { jobId, now }) {
  lastArgs = { container, data, opts: { jobId, now } };
  const width = Math.max(280, container.clientWidth || 340);

  const months = S.bucketSeries(data, { unit: 'month', count: 12, jobId, now });
  const parts = [
    rateChart(data, { jobId, now, width }),
    barChart(months, {
      width, color: TIME, title: 'Hours a month', note: 'The last twelve months.',
      value: (b) => b.hours, format: (v) => Math.round(v) + 'h', ariaUnit: 'hours',
    }),
    barChart(months, {
      width, color: MONEY, title: 'Deposits a month', note: 'When money actually landed, not when the work happened.',
      value: (b) => b.incomeCents, format: money0, ariaUnit: '',
    }),
    patternChart(data, { jobId, now, width }),
  ];

  container.innerHTML = parts.map((p) => (p.html ?? p)).join('');
  const cards = [...container.querySelectorAll('.chart')];
  parts.forEach((p, i) => { if (p.wire && cards[i]) p.wire(cards[i]); });

  if (!resizeBound) {
    resizeBound = true;
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (lastArgs && lastArgs.container.isConnected && lastArgs.container.offsetParent !== null) {
          renderCharts(lastArgs.container, lastArgs.data, lastArgs.opts);
        }
      }, 180);
    });
  }
}
