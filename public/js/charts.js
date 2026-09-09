// Charts. Two hues carry the whole system: gold is money, aqua is time.
// Both were validated against the card surface (#24221f) for the dark
// lightness band, chroma floor, CVD separation and >=3:1 contrast.
//
// The after-tax rate is deliberately NOT a third hue: it is the same measure
// at a lower level, so it is drawn as the same gold, dashed, with the gap
// between the two filled. That shows the tax bite as an area and avoids
// spending a categorical slot on something that isn't a separate entity.
//
// Time-series charts own their own span control. The page-level range picker
// drives the stat tiles only — clipping a trend line to 90 days would destroy
// the thing the trend line is for.

import * as S from './stats.js';

const MONEY = '#c98500';
const TIME = '#199e70';
const GRID = '#3a3733';
const INK = '#9b958a';
const FAINT = '#6f6a61';
const SURFACE = '#24221f';

const money0 = (c) => '$' + Math.round(c / 100).toLocaleString();
const money2 = (c) => '$' + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const monthLabel = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short' });
const dateLabel = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil((v / mag) * 2) / 2 * mag;
}

// ── chart options, remembered between visits ──────────────────────

const DEFAULTS = { roll: 90, bucket: 'month', heat: 180 };
let opts = { ...DEFAULTS };
try { opts = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('wt.charts') || '{}') }; } catch {}
const setOpt = (k, v) => {
  opts[k] = v;
  try { localStorage.setItem('wt.charts', JSON.stringify(opts)); } catch {}
};

const seg = (key, choices) => `<div class="chart-ctrl" data-opt="${key}">` +
  choices.map(([v, label]) =>
    `<button type="button" data-v="${v}" class="${String(opts[key]) === String(v) ? 'is-active' : ''}">${esc(label)}</button>`).join('') +
  '</div>';

function card(title, note, body, { legend = '', controls = '' } = {}) {
  return `<div class="card chart">
    <div class="chart-head">
      <div><h2 class="card-title">${esc(title)}</h2>${note ? `<p class="chart-note">${esc(note)}</p>` : ''}</div>
      ${controls}
    </div>
    ${legend}
    <div class="chart-hold">${body}<div class="tip" hidden></div></div>
  </div>`;
}

const empty = (msg) => `<p class="empty">${esc(msg)}</p>`;

// ── rolling effective rate ────────────────────────────────────────

function rateChart(data, { jobId, now, width }) {
  const win = opts.roll;
  const controls = seg('roll', [[30, '30d'], [60, '60d'], [90, '90d']]);
  const series = S.rollingRateSeries(data, { windowDays: win, stepDays: 7, jobId, now })
    .filter((p) => p.rateCents !== null);

  if (series.length < 2) {
    return { html: card('Effective rate over time',
      `Appears once there are ${win} days of hours with at least one deposit inside the window.`,
      empty('Not enough history yet.'), { controls }) };
  }

  const pad = { t: 14, r: 58, b: 30, l: 8 };
  const h = 196;
  const inner = { w: width - pad.l - pad.r, h: h - pad.t - pad.b };
  const max = niceMax(Math.max(...series.map((p) => p.rateCents)) * 1.12);
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * inner.w;
  const y = (c) => pad.t + inner.h - (c / max) * inner.h;

  const line = (key) => series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const band = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.rateCents).toFixed(1)}`).join('') +
    series.slice().reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.netRateCents).toFixed(1)}`).join('') + 'Z';

  // Deposits are what move this line. Marking them turns a jump into a cause.
  const marks = S.depositEvents(data, { from: t0, to: t1 + 1, jobId })
    .map((d) => `<line x1="${x(d.t).toFixed(1)}" x2="${x(d.t).toFixed(1)}"
       y1="${pad.t + inner.h}" y2="${pad.t + inner.h + 5}" stroke="${MONEY}" stroke-width="1.5" opacity=".55"/>`).join('');

  const last = series[series.length - 1];
  const svg = `
  <svg viewBox="0 0 ${width} ${h}" width="100%" height="${h}" role="img"
       aria-label="Rolling ${win}-day effective rate, currently ${money2(last.rateCents)} per hour">
    ${[0, max / 2, max].map((v) => `
      <line x1="${pad.l}" x2="${pad.l + inner.w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>
      <text x="${pad.l + inner.w + 6}" y="${(y(v) + 3.5).toFixed(1)}" fill="${FAINT}" font-size="10">${money0(v)}</text>`).join('')}
    <path d="${band}" fill="${MONEY}" opacity="0.09"/>
    <path d="${line('netRateCents')}" fill="none" stroke="${MONEY}" stroke-width="2" stroke-dasharray="3 3" opacity="0.75"/>
    <path d="${line('rateCents')}" fill="none" stroke="${MONEY}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${marks}
    <circle cx="${x(last.t).toFixed(1)}" cy="${y(last.rateCents).toFixed(1)}" r="4" fill="${MONEY}" stroke="${SURFACE}" stroke-width="2"/>
    <text x="${pad.l}" y="${h - 8}" fill="${FAINT}" font-size="10">${esc(dateLabel(t0))}</text>
    <text x="${pad.l + inner.w}" y="${h - 8}" fill="${FAINT}" font-size="10" text-anchor="end">${esc(dateLabel(t1))}</text>
    <g class="hover" hidden>
      <line class="cross" y1="${pad.t}" y2="${pad.t + inner.h}" stroke="${INK}" stroke-width="1" opacity=".5"/>
      <circle class="dot" r="4.5" fill="${MONEY}" stroke="${SURFACE}" stroke-width="2"/>
    </g>
    <rect class="capture" x="${pad.l}" y="${pad.t}" width="${inner.w}" height="${inner.h}" fill="transparent"/>
  </svg>`;

  const legend = `<div class="legend">
    <span><i style="background:${MONEY}"></i>Effective rate</span>
    <span><i class="dash" style="background:${MONEY}"></i>After the tax you set aside</span>
    <span><i class="tick" style="background:${MONEY}"></i>A deposit landed</span>
  </div>`;

  const points = series.map((p) => ({ x: x(p.t), y: y(p.rateCents), t: p.t, p }));
  return {
    html: card('Effective rate over time',
      `Each point divides the deposits of the previous ${win} days by the hours worked in the same span.`,
      svg, { legend, controls }),
    wire: (root) => wireCrosshair(root, points, (p) =>
      `<b>${dateLabel(p.t)}</b><span>${money2(p.p.rateCents)}/hr</span>` +
      `<span class="dim">${money2(p.p.netRateCents)}/hr after tax</span>` +
      `<span class="dim">${p.p.hours.toFixed(1)}h · ${money0(p.p.incomeCents)} in the window</span>`),
  };
}

// ── bucketed bars ─────────────────────────────────────────────────

function barChart(buckets, { width, title, note, color, value, format, unit, controls = '', drill }) {
  const vals = buckets.map(value);
  if (!vals.some((v) => v > 0)) return { html: card(title, note, empty('Nothing logged yet.'), { controls }) };

  const pad = { t: 12, r: 52, b: 24, l: 8 };
  const h = 168;
  const inner = { w: width - pad.l - pad.r, h: h - pad.t - pad.b };
  const max = niceMax(Math.max(...vals) * 1.1);
  const n = buckets.length;
  const slot = inner.w / n;
  const bw = Math.max(5, Math.min(34, slot - 6));
  const y = (v) => pad.t + inner.h - (v / max) * inner.h;

  const bars = buckets.map((b, i) => {
    const v = value(b);
    const cx = pad.l + slot * i + slot / 2;
    return `<rect class="bar" data-i="${i}" x="${(cx - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}"
      width="${bw.toFixed(1)}" height="${Math.max(v > 0 ? 2 : 0, pad.t + inner.h - y(v)).toFixed(1)}"
      rx="4" fill="${color}" opacity="${v > 0 ? 1 : 0.25}"/>`;
  }).join('');

  const every = n > 16 ? 4 : 3;
  const labels = buckets.map((b, i) => (i % every === n % every || i === n - 1)
    ? `<text x="${(pad.l + slot * i + slot / 2).toFixed(1)}" y="${h - 7}" fill="${FAINT}" font-size="10" text-anchor="middle">${esc(monthLabel(b.from))}</text>` : '').join('');

  const svg = `<svg viewBox="0 0 ${width} ${h}" width="100%" height="${h}" role="img"
      aria-label="${esc(title)}: most recent ${esc(format(value(buckets[n - 1])))} ${esc(unit)}">
    ${[0, max / 2, max].map((v) => `
      <line x1="${pad.l}" x2="${pad.l + inner.w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>
      <text x="${pad.l + inner.w + 6}" y="${(y(v) + 3.5).toFixed(1)}" fill="${FAINT}" font-size="10">${esc(format(v))}</text>`).join('')}
    ${bars}${labels}</svg>`;

  return {
    html: card(title, note, svg, { controls }),
    wire: (root) => wireBars(root, buckets, (b) => {
      const when = new Date(b.from).toLocaleDateString(undefined,
        opts.bucket === 'week' ? { month: 'short', day: 'numeric' } : { month: 'long', year: 'numeric' });
      return `<b>${esc(when)}</b><span>${esc(format(value(b)))} ${esc(unit)}</span>` +
             (drill ? '<span class="dim">Tap to see it in History</span>' : '');
    }, drill),
  };
}

// ── cumulative: earnings against hours ────────────────────────────

function cumulativeChart(data, { jobId, now, width }) {
  const series = S.cumulativeByHours(data, { jobId, now, stepDays: 7 }).filter((p) => p.hours > 0);
  const title = 'Earnings against hours';
  const note = 'Every hour worked moves the line right; every deposit moves it up. The steeper it climbs, the better your time is paying.';
  if (series.length < 3 || series[series.length - 1].incomeCents <= 0) {
    return { html: card(title, note, empty('Not enough history yet.')) };
  }

  const pad = { t: 14, r: 56, b: 28, l: 8 };
  const h = 200;
  const inner = { w: width - pad.l - pad.r, h: h - pad.t - pad.b };
  const last = series[series.length - 1];
  const maxH = niceMax(last.hours * 1.05);
  const maxC = niceMax(last.incomeCents * 1.05);
  const x = (hh) => pad.l + (hh / maxH) * inner.w;
  const y = (c) => pad.t + inner.h - (c / maxC) * inner.h;

  const path = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.hours).toFixed(1)},${y(p.incomeCents).toFixed(1)}`).join('');
  // Straight line from the origin to today = the lifetime average rate. Where
  // the real curve sits above it, you were doing better than your average.
  const guide = `<line x1="${x(0)}" y1="${y(0)}" x2="${x(last.hours).toFixed(1)}" y2="${y(last.incomeCents).toFixed(1)}"
      stroke="${INK}" stroke-width="1" stroke-dasharray="4 4" opacity=".4"/>`;

  const svg = `<svg viewBox="0 0 ${width} ${h}" width="100%" height="${h}" role="img"
      aria-label="Cumulative earnings plotted against cumulative hours worked">
    ${[0, maxC / 2, maxC].map((v) => `
      <line x1="${pad.l}" x2="${pad.l + inner.w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>
      <text x="${pad.l + inner.w + 6}" y="${(y(v) + 3.5).toFixed(1)}" fill="${FAINT}" font-size="10">${money0(v)}</text>`).join('')}
    ${guide}
    <path d="${path}" fill="none" stroke="${MONEY}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(last.hours).toFixed(1)}" cy="${y(last.incomeCents).toFixed(1)}" r="4" fill="${MONEY}" stroke="${SURFACE}" stroke-width="2"/>
    <text x="${pad.l}" y="${h - 7}" fill="${FAINT}" font-size="10">0h</text>
    <text x="${pad.l + inner.w}" y="${h - 7}" fill="${FAINT}" font-size="10" text-anchor="end">${Math.round(maxH)}h worked</text>
    <g class="hover" hidden>
      <line class="cross" y1="${pad.t}" y2="${pad.t + inner.h}" stroke="${INK}" stroke-width="1" opacity=".5"/>
      <circle class="dot" r="4.5" fill="${MONEY}" stroke="${SURFACE}" stroke-width="2"/>
    </g>
    <rect class="capture" x="${pad.l}" y="${pad.t}" width="${inner.w}" height="${inner.h}" fill="transparent"/>
  </svg>`;

  const points = series.map((p) => ({ x: x(p.hours), y: y(p.incomeCents), p }));
  return {
    html: card(title, note, svg, {
      legend: `<div class="legend"><span><i style="background:${MONEY}"></i>Your path</span>
               <span><i class="dash" style="background:${INK}"></i>Lifetime average pace</span></div>`,
    }),
    wire: (root) => wireCrosshair(root, points, (p) =>
      `<b>${dateLabel(p.p.t)}</b><span>${p.p.hours.toFixed(0)}h · ${money0(p.p.incomeCents)}</span>` +
      `<span class="dim">${p.p.hours > 0 ? money2(p.p.incomeCents / p.p.hours) + '/hr to date' : ''}</span>`),
  };
}

// ── shift length distribution ─────────────────────────────────────

function lengthChart(data, { jobId, now, from, to, width }) {
  const buckets = S.shiftLengthHistogram(data, { from, to, jobId, now });
  const title = 'How long a session runs';
  if (!buckets.some((b) => b.count > 0)) return { html: card(title, '', empty('Nothing logged yet.')) };

  const pad = { t: 10, r: 8, b: 30, l: 8 };
  const h = 132;
  const inner = { w: width - pad.l - pad.r, h: h - pad.t - pad.b };
  const max = Math.max(...buckets.map((b) => b.count));
  const slot = inner.w / buckets.length;
  const bw = Math.min(40, slot - 8);

  const bars = buckets.map((b, i) => {
    const bh = max ? (b.count / max) * inner.h : 0;
    const cx = pad.l + slot * i + slot / 2;
    return `<rect class="cell" data-v="${b.count}" data-label="${esc(b.label)}"
        x="${(cx - bw / 2).toFixed(1)}" y="${(pad.t + inner.h - bh).toFixed(1)}"
        width="${bw.toFixed(1)}" height="${Math.max(b.count ? 2 : 0, bh).toFixed(1)}" rx="4"
        fill="${TIME}" opacity="${b.count ? 1 : 0.2}"/>
      <text x="${cx.toFixed(1)}" y="${h - 14}" fill="${FAINT}" font-size="10" text-anchor="middle">${esc(b.label)}</text>
      <text x="${cx.toFixed(1)}" y="${h - 3}" fill="${b.count ? INK : FAINT}" font-size="10" text-anchor="middle">${b.count || ''}</text>`;
  }).join('');

  return {
    html: card(title, 'Number of shifts by length, for the selected range.',
      `<svg viewBox="0 0 ${width} ${h}" width="100%" height="${h}" role="img"
         aria-label="Distribution of shift lengths">${bars}</svg>`),
  };
}

// ── working pattern ───────────────────────────────────────────────

function patternChart(data, { jobId, now, width }) {
  const span = opts.heat;
  const controls = seg('heat', [[90, '90d'], [180, '180d'], [365, '1y']]);
  const from = S.addDays(S.startOfDay(now), -(span - 1));
  const grid = S.heatmap(data, { jobId, now, from, to: now + 1 });
  const max = Math.max(...grid.flat());
  const title = 'When you actually work';
  if (max <= 0) return { html: card(title, '', empty('Nothing logged yet.'), { controls }) };

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const padL = 30, padT = 12, padB = 18, ch = 15;
  const cw = (width - padL - 4) / 24;
  const h = padT + ch * 7 + padB;

  let cells = '';
  for (let d = 0; d < 7; d++) {
    for (let hr = 0; hr < 24; hr++) {
      const v = grid[d][hr];
      const o = v > 0 ? 0.16 + 0.84 * Math.sqrt(v / max) : 0;
      cells += `<rect class="cell" data-d="${d}" data-h="${hr}" data-v="${v.toFixed(2)}"
        x="${(padL + hr * cw + 1).toFixed(1)}" y="${padT + d * ch + 1}"
        width="${Math.max(1, cw - 2).toFixed(1)}" height="${ch - 2}" rx="2"
        fill="${v > 0 ? TIME : '#2c2a26'}" opacity="${v > 0 ? o.toFixed(2) : 1}"/>`;
    }
  }
  const rowLabels = days.map((d, i) => `<text x="0" y="${padT + i * ch + 11}" fill="${FAINT}" font-size="10">${d}</text>`).join('');
  const colLabels = [0, 6, 12, 18].map((hr) =>
    `<text x="${(padL + hr * cw).toFixed(1)}" y="${h - 5}" fill="${FAINT}" font-size="10">${hr === 0 ? '12a' : hr === 12 ? '12p' : hr > 12 ? hr - 12 + 'p' : hr + 'a'}</text>`).join('');

  return {
    html: card(title, `Hours by weekday and time of day, over the last ${span} days.`,
      `<svg viewBox="0 0 ${width} ${h}" width="100%" height="${h}" role="img"
         aria-label="Hours worked by day of week and hour of day">${rowLabels}${cells}${colLabels}</svg>`,
      { controls }),
    wire: (root) => wireCells(root, days),
  };
}

// ── interaction ───────────────────────────────────────────────────

const tipFor = (root) => ({
  svg: root.querySelector('svg'),
  tip: root.querySelector('.tip'),
  hold: root.querySelector('.chart-hold'),
});

function place(hold, tip, px, py) {
  tip.hidden = false;
  const w = tip.offsetWidth;
  tip.style.transform = `translate(${Math.max(4, Math.min(hold.clientWidth - w - 4, px - w / 2))}px, ${Math.max(0, py - tip.offsetHeight - 12)}px)`;
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
  capture.addEventListener('pointermove', move);
  capture.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', () => { hover.setAttribute('hidden', ''); tip.hidden = true; });
}

function wireBars(root, buckets, render, drill) {
  const { svg, tip, hold } = tipFor(root);
  svg.querySelectorAll('.bar').forEach((bar) => {
    const b = buckets[+bar.dataset.i];
    if (drill) bar.style.cursor = 'pointer';
    const show = () => {
      const r = svg.getBoundingClientRect();
      const scale = svg.viewBox.baseVal.width / r.width;
      tip.innerHTML = render(b);
      place(hold, tip, (+bar.getAttribute('x') + +bar.getAttribute('width') / 2) / scale, +bar.getAttribute('y') / scale);
      bar.style.filter = 'brightness(1.25)';
    };
    bar.addEventListener('pointerenter', show);
    bar.addEventListener('pointerdown', show);
    bar.addEventListener('pointerleave', () => { tip.hidden = true; bar.style.filter = ''; });
    if (drill) bar.addEventListener('click', () => drill(b));
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
      if (cell.dataset.label !== undefined) {
        tip.innerHTML = `<b>${esc(cell.dataset.label)}</b><span>${v} shift${v === 1 ? '' : 's'}</span>`;
      } else {
        const hr = +cell.dataset.h;
        tip.innerHTML = `<b>${days[+cell.dataset.d]} ${hr === 0 ? '12am' : hr === 12 ? '12pm' : hr > 12 ? hr - 12 + 'pm' : hr + 'am'}</b><span>${v.toFixed(1)}h logged</span>`;
      }
      place(hold, tip, (+cell.getAttribute('x') + +cell.getAttribute('width') / 2) / scale, +cell.getAttribute('y') / scale);
    };
    cell.addEventListener('pointerenter', show);
    cell.addEventListener('pointerdown', show);
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
}

// ── entry point ───────────────────────────────────────────────────

let bound = false;
let lastArgs = null;

export function renderCharts(container, data, { jobId, now, from, to, onDrill }) {
  lastArgs = { container, data, opts: { jobId, now, from, to, onDrill } };
  const width = Math.max(280, container.clientWidth || 340);
  const byWeek = opts.bucket === 'week';
  const bucketCtrl = seg('bucket', [['week', 'Weekly'], ['month', 'Monthly']]);
  const buckets = S.bucketSeries(data, { unit: opts.bucket, count: byWeek ? 16 : 12, jobId, now });

  const parts = [
    rateChart(data, { jobId, now, width }),
    barChart(buckets, {
      width, color: TIME, controls: bucketCtrl, drill: onDrill,
      title: byWeek ? 'Hours a week' : 'Hours a month',
      note: byWeek ? 'The last sixteen weeks.' : 'The last twelve months.',
      value: (b) => b.hours, format: (v) => Math.round(v) + 'h', unit: 'worked',
    }),
    barChart(buckets, {
      width, color: MONEY, controls: bucketCtrl, drill: onDrill,
      title: byWeek ? 'Deposits a week' : 'Deposits a month',
      note: 'When money actually landed, not when the work happened.',
      value: (b) => b.incomeCents, format: money0, unit: 'received',
    }),
    cumulativeChart(data, { jobId, now, width }),
    lengthChart(data, { jobId, now, from, to, width }),
    patternChart(data, { jobId, now, width }),
  ];

  container.innerHTML = parts.map((p) => p.html).join('');
  const cards = [...container.querySelectorAll('.chart')];
  parts.forEach((p, i) => p.wire && cards[i] && p.wire(cards[i]));

  container.querySelectorAll('.chart-ctrl').forEach((ctrl) => {
    ctrl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      const raw = btn.dataset.v;
      setOpt(ctrl.dataset.opt, /^\d+$/.test(raw) ? Number(raw) : raw);
      renderCharts(container, data, lastArgs.opts);
    });
  });

  if (!bound) {
    bound = true;
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (lastArgs?.container.isConnected && lastArgs.container.offsetParent !== null) {
          renderCharts(lastArgs.container, lastArgs.data, lastArgs.opts);
        }
      }, 180);
    });
  }
}
