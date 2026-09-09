// All derived metrics. Pure functions over plain arrays so they can be tested
// without a browser, and so the Worker never has to compute anything (the free
// plan gives us 10ms of CPU per request — aggregation belongs on the client).
//
// Conventions:
//   - money is integer cents everywhere; it becomes a float only at display
//   - time is epoch ms; durations are ms until display
//   - "worked" time always excludes breaks
//   - an open shift (end_ms === null) accrues up to `now`

export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;
/** Lower bound for an unbounded window. Never divide by it. */
export const MIN_TIME = -8640000000000000;

// --- local-time boundaries -------------------------------------------------
// Deliberately local, not UTC: a work day is a wall-clock day. Constructing
// dates via the Date(y, m, d) form keeps DST transitions correct, because the
// runtime resolves the offset for that specific local date.

export const startOfDay = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

// Weeks start Monday.
export const startOfWeek = (t) => {
  const d = new Date(startOfDay(t));
  const dow = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime();
};

export const startOfMonth = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

export const startOfYear = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), 0, 1).getTime();
};

export const addDays = (t, n) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};

export const addMonths = (t, n) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
};

const overlap = (aStart, aEnd, bStart, bEnd) =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/**
 * Worked ms of one shift falling inside [from, to), excluding break time.
 * Hours are attributed to when they actually happened, so a shift spanning
 * midnight contributes to both days. (Shift-level stats use the start date;
 * that's a separate concern handled by the caller.)
 */
export function workedMsInWindow(shift, from, to, now = Date.now()) {
  const end = shift.end_ms ?? now;
  if (end <= shift.start_ms) return 0;

  let ms = overlap(shift.start_ms, end, from, to);
  if (ms === 0) return 0;

  for (const b of shift.breaks || []) {
    const bEnd = b.e ?? now;
    if (bEnd <= b.s) continue;
    // Clip the break to the shift as well, so a malformed break that extends
    // past the shift can never drive worked time negative.
    const bs = Math.max(b.s, shift.start_ms);
    const be = Math.min(bEnd, end);
    if (be > bs) ms -= overlap(bs, be, from, to);
  }
  return Math.max(0, ms);
}

/** Total worked ms of a shift, ignoring windows. */
export const shiftWorkedMs = (shift, now = Date.now()) =>
  workedMsInWindow(shift, -Infinity, Infinity, now);

/** Total break ms of a shift. */
export function shiftBreakMs(shift, now = Date.now()) {
  const end = shift.end_ms ?? now;
  let ms = 0;
  for (const b of shift.breaks || []) {
    const be = Math.min(b.e ?? now, end);
    if (be > b.s) ms += be - b.s;
  }
  return ms;
}

export const isOpen = (s) => s.end_ms === null || s.end_ms === undefined;
export const onBreak = (s) => (s.breaks || []).some((b) => b.e === null || b.e === undefined);

// --- summaries -------------------------------------------------------------

const MIN_HOURS_FOR_RATE = 5;

/**
 * Reconcile money and hours over a window by summing both sides. There is no
 * per-project attribution: at a long enough window the payment lag washes out,
 * which is exactly why short windows don't get a rate (see `allowRate`).
 */
export function summarize(data, { from, to, jobId = null, now = Date.now(), allowRate = true }) {
  const jobOk = (r) => !jobId || r.job_id === jobId;

  let workedMs = 0;
  let shiftCount = 0;
  for (const s of data.shifts) {
    if (!jobOk(s)) continue;
    const ms = workedMsInWindow(s, from, to, now);
    if (ms > 0) {
      workedMs += ms;
      shiftCount++;
    }
  }

  let incomeCents = 0;
  let setAsideCents = 0;
  let paymentCount = 0;
  for (const p of data.payments) {
    if (!jobOk(p) || p.paid_ms < from || p.paid_ms >= to) continue;
    incomeCents += p.amount_cents;
    setAsideCents += p.set_aside_cents;
    paymentCount++;
  }

  const hours = workedMs / HOUR_MS;
  const netCents = incomeCents - setAsideCents;

  // A rate is only shown when the window can support one: enough hours to
  // divide by, at least one deposit, and a window long enough that deposit
  // timing isn't the dominant term.
  const rateOk = allowRate && hours >= MIN_HOURS_FOR_RATE && paymentCount > 0;

  return {
    from,
    to,
    workedMs,
    hours,
    shiftCount,
    incomeCents,
    setAsideCents,
    netCents,
    paymentCount,
    rateCents: rateOk ? incomeCents / hours : null,
    netRateCents: rateOk ? netCents / hours : null,
    rateSuppressed: allowRate && !rateOk,
  };
}

/**
 * The windows offered in the UI. Week-scale windows deliberately carry
 * allowRate:false — with deposits arriving twice a month, a weekly "rate" is
 * a measure of deposit timing, not of how valuable the work was.
 */
export function ranges(now = Date.now()) {
  // Windows run to the END of today, not to `now`. A deposit is a date, not a
  // timestamp, and is stored at local noon — so a window ending at `now` would
  // drop a deposit dated today for the whole morning. Extending past `now` is
  // safe for hours: an open shift is clamped at `now` inside workedMsInWindow,
  // and a closed shift cannot end in the future.
  const endOfToday = startOfDay(now) + DAY_MS;
  return [
    { key: 'wtd',   label: 'Week to date',  from: startOfWeek(now),                  to: endOfToday, allowRate: false },
    { key: 'week',  label: 'Last 7 days',   from: addDays(startOfDay(now), -6),      to: endOfToday, allowRate: false },
    { key: 'mtd',   label: 'Month to date', from: startOfMonth(now),                 to: endOfToday, allowRate: true  },
    { key: 'd30',   label: 'Last 30 days',  from: addDays(startOfDay(now), -29),      to: endOfToday, allowRate: true  },
    { key: 'd90',   label: 'Last 90 days',  from: addDays(startOfDay(now), -89),     to: endOfToday, allowRate: true  },
    { key: 'ytd',   label: 'Year to date',  from: startOfYear(now),                  to: endOfToday, allowRate: true  },
    { key: 'y1',    label: 'Last 12 months',from: addMonths(startOfMonth(now), -11), to: endOfToday, allowRate: true  },
    { key: 'all',   label: 'All time',      from: MIN_TIME,                          to: endOfToday, allowRate: true  },
  ];
}

// --- series for charts -----------------------------------------------------

/** Fixed-width buckets of hours + income, for bar charts. */
export function bucketSeries(data, { unit = 'month', count = 12, jobId = null, now = Date.now() }) {
  const stepStart = unit === 'week' ? startOfWeek : startOfMonth;
  const back = unit === 'week' ? (t, n) => addDays(t, -7 * n) : (t, n) => addMonths(t, -n);

  const out = [];
  const anchor = stepStart(now);
  for (let i = count - 1; i >= 0; i--) {
    const from = back(anchor, i);
    const to = i === 0 ? startOfDay(now) + DAY_MS : back(anchor, i - 1);
    const s = summarize(data, { from, to, jobId, now, allowRate: false });
    out.push({ from, to, hours: s.hours, incomeCents: s.incomeCents, netCents: s.netCents });
  }
  return out;
}

/**
 * Rolling effective rate over time — the headline chart. Each point divides
 * the money received in the trailing `windowDays` by the hours worked in that
 * same span, which smooths out lumpy deposits.
 */
export function rollingRateSeries(data, { windowDays = 90, stepDays = 7, jobId = null, now = Date.now() }) {
  const first = firstActivity(data, jobId);
  if (first === null) return [];

  const out = [];
  const end = startOfDay(now) + DAY_MS;
  // Only start plotting once a full window of history exists, otherwise the
  // first points divide by a partial window and read as noise.
  let cursor = addDays(startOfDay(first), windowDays);
  if (cursor > end) return [];

  const point = (t) => {
    const s = summarize(data, { from: addDays(t, -windowDays), to: t, jobId, now, allowRate: true });
    return { t, rateCents: s.rateCents, netRateCents: s.netRateCents, hours: s.hours, incomeCents: s.incomeCents };
  };

  for (; cursor <= end; cursor = addDays(cursor, stepDays)) out.push(point(cursor));

  // Always finish on today, so the chart's last point matches the headline
  // figure instead of trailing it by up to a step.
  if (out.length && out[out.length - 1].t < end) out.push(point(end));
  return out;
}

/** Cumulative hours and earnings; the slope of this is the all-time rate. */
export function cumulativeSeries(data, { jobId = null, now = Date.now(), stepDays = 7 }) {
  const first = firstActivity(data, jobId);
  if (first === null) return [];
  const out = [];
  const end = startOfDay(now) + DAY_MS;
  for (let t = addDays(startOfDay(first), stepDays); t <= end; t = addDays(t, stepDays)) {
    const s = summarize(data, { from: MIN_TIME, to: t, jobId, now, allowRate: false });
    out.push({ t, hours: s.hours, incomeCents: s.incomeCents, netCents: s.netCents });
  }
  return out;
}

/** Worked hours by weekday (0=Mon) x hour-of-day, for the pattern heatmap. */
export function heatmap(data, { jobId = null, now = Date.now(), from = -Infinity, to = Infinity }) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const s of data.shifts) {
    if (jobId && s.job_id !== jobId) continue;
    const end = Math.min(s.end_ms ?? now, to);
    const start = Math.max(s.start_ms, from);
    if (end <= start) continue;
    // Walk hour by hour so a long shift spreads across the cells it truly spans.
    let t = start;
    while (t < end) {
      const d = new Date(t);
      const cellEnd = Math.min(
        new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime(),
        end,
      );
      const worked = workedMsInWindow(s, t, cellEnd, now);
      grid[(d.getDay() + 6) % 7][d.getHours()] += worked / HOUR_MS;
      t = cellEnd;
    }
  }
  return grid;
}

function firstActivity(data, jobId) {
  let min = Infinity;
  for (const s of data.shifts) if (!jobId || s.job_id === jobId) min = Math.min(min, s.start_ms);
  for (const p of data.payments) if (!jobId || p.job_id === jobId) min = Math.min(min, p.paid_ms);
  return Number.isFinite(min) ? min : null;
}

// ── richer insight metrics ────────────────────────────────────────
// All of these are derived from shifts and deposits alone. Nothing here asks
// for a single extra keystroke of bookkeeping.

/** Worked ms per local day inside a window. Map<dayStartMs, ms>. */
export function dailyWorkedMs(data, { from, to, jobId = null, now = Date.now() }) {
  const map = new Map();
  for (const s of data.shifts) {
    if (jobId && s.job_id !== jobId) continue;
    const end = Math.min(s.end_ms ?? now, to);
    const start = Math.max(s.start_ms, from);
    if (end <= start) continue;
    for (let t = startOfDay(start); t < end; t = addDays(t, 1)) {
      const ms = workedMsInWindow(s, Math.max(t, from), Math.min(addDays(t, 1), to), now);
      if (ms > 0) map.set(t, (map.get(t) || 0) + ms);
    }
  }
  return map;
}

/**
 * The equivalent window immediately before this one, for change-over-time.
 * Same duration rather than the same calendar unit: it is the comparison that
 * stays honest for a part-finished month.
 */
export function previousWindow({ from, to }) {
  if (!Number.isFinite(from)) return null;   // "all time" has nothing before it
  const span = to - from;
  return { from: from - span, to: from, days: Math.max(1, Math.round(span / DAY_MS)) };
}

/** Time-shaped stats: how the hours were actually distributed. */
export function activityStats(data, { from, to, jobId = null, now = Date.now() }) {
  const daily = dailyWorkedMs(data, { from, to, jobId, now });
  let workedMs = 0;
  for (const ms of daily.values()) workedMs += ms;

  let breakMs = 0, longestMs = 0, shiftCount = 0, shiftMsTotal = 0;
  for (const s of data.shifts) {
    if (jobId && s.job_id !== jobId) continue;
    if (workedMsInWindow(s, from, to, now) <= 0) continue;
    shiftCount++;
    const w = shiftWorkedMs(s, now);
    shiftMsTotal += w;
    if (w > longestMs) longestMs = w;
    breakMs += shiftBreakMs(s, now);
  }

  // An unbounded window has no start date to measure against, so fall back to
  // the first day with any activity. Measuring against the sentinel produced
  // "188 of 100020705".
  const lo = from <= MIN_TIME ? (firstActivityAt(data, jobId) ?? now) : from;
  const spanDays = Math.max(1, Math.round((Math.min(to, now + DAY_MS) - lo) / DAY_MS));

  return {
    workedMs,
    daysWorked: daily.size,
    spanDays,
    avgMsPerWorkingDay: daily.size ? workedMs / daily.size : 0,
    avgShiftMs: shiftCount ? shiftMsTotal / shiftCount : 0,
    longestShiftMs: longestMs,
    breakMs,
    breakPct: workedMs + breakMs > 0 ? breakMs / (workedMs + breakMs) : 0,
    shiftCount,
  };
}

/** Money-shaped stats: the rhythm and size of what lands. */
export function depositStats(data, { from, to, jobId = null, now = Date.now() }) {
  const inWindow = data.payments
    .filter((p) => (!jobId || p.job_id === jobId) && p.paid_ms >= from && p.paid_ms < to)
    .sort((a, b) => a.paid_ms - b.paid_ms);

  let total = 0, largest = 0;
  for (const p of inWindow) { total += p.amount_cents; largest = Math.max(largest, p.amount_cents); }

  let gapSum = 0;
  for (let i = 1; i < inWindow.length; i++) gapSum += inWindow[i].paid_ms - inWindow[i - 1].paid_ms;

  // "Days since last" looks at every deposit, not just this window — otherwise
  // a short window would report a misleading silence.
  const everySorted = data.payments
    .filter((p) => !jobId || p.job_id === jobId)
    .sort((a, b) => b.paid_ms - a.paid_ms);
  const last = everySorted[0];

  return {
    count: inWindow.length,
    totalCents: total,
    avgCents: inWindow.length ? total / inWindow.length : 0,
    largestCents: largest,
    avgGapDays: inWindow.length > 1 ? gapSum / (inWindow.length - 1) / DAY_MS : null,
    daysSinceLast: last ? Math.floor((now - last.paid_ms) / DAY_MS) : null,
  };
}

/** When the work happens, rather than how much of it there is. */
export function patternStats(data, { from, to, jobId = null, now = Date.now() }) {
  const byWeekday = new Array(7).fill(0);
  const starts = [];
  let weekendMs = 0, lateMs = 0, total = 0;

  for (const s of data.shifts) {
    if (jobId && s.job_id !== jobId) continue;
    const ms = workedMsInWindow(s, from, to, now);
    if (ms <= 0) continue;
    const d = new Date(s.start_ms);
    const dow = (d.getDay() + 6) % 7;          // 0 = Monday
    byWeekday[dow] += ms;
    starts.push(d.getHours() * 60 + d.getMinutes());
    total += ms;
    if (dow >= 5) weekendMs += ms;
    const h = d.getHours();
    if (h >= 22 || h < 5) lateMs += ms;
  }

  starts.sort((a, b) => a - b);
  const median = starts.length ? starts[Math.floor(starts.length / 2)] : null;
  let busiest = -1;
  for (let i = 0; i < 7; i++) if (byWeekday[i] > (byWeekday[busiest] ?? -1)) busiest = i;

  return {
    byWeekday,
    busiestWeekday: total > 0 ? busiest : null,
    medianStartMinutes: median,
    weekendPct: total ? weekendMs / total : 0,
    lateNightPct: total ? lateMs / total : 0,
  };
}

const LENGTH_BUCKETS = [
  { label: '<1h', min: 0, max: 1 },
  { label: '1–2h', min: 1, max: 2 },
  { label: '2–3h', min: 2, max: 3 },
  { label: '3–4h', min: 3, max: 4 },
  { label: '4–6h', min: 4, max: 6 },
  { label: '6–8h', min: 6, max: 8 },
  { label: '8h+', min: 8, max: Infinity },
];

/** How long a typical session runs. */
export function shiftLengthHistogram(data, { from, to, jobId = null, now = Date.now() }) {
  const out = LENGTH_BUCKETS.map((b) => ({ ...b, count: 0 }));
  for (const s of data.shifts) {
    if (jobId && s.job_id !== jobId) continue;
    if (workedMsInWindow(s, from, to, now) <= 0) continue;
    const h = shiftWorkedMs(s, now) / HOUR_MS;
    const b = out.find((x) => h >= x.min && h < x.max);
    if (b) b.count++;
  }
  return out;
}

/** Cumulative earnings plotted against cumulative hours: the slope is the rate. */
export function cumulativeByHours(data, { jobId = null, now = Date.now(), stepDays = 7 }) {
  const first = firstActivityAt(data, jobId);
  if (first === null) return [];
  const out = [];
  const end = startOfDay(now) + DAY_MS;
  for (let t = addDays(startOfDay(first), stepDays); t <= end; t = addDays(t, stepDays)) {
    const s = summarize(data, { from: MIN_TIME, to: t, jobId, now, allowRate: false });
    out.push({ t, hours: s.hours, incomeCents: s.incomeCents, netCents: s.netCents });
  }
  return out;
}

/** Deposit events inside a span, for marking on a time axis. */
export function depositEvents(data, { from, to, jobId = null }) {
  return data.payments
    .filter((p) => (!jobId || p.job_id === jobId) && p.paid_ms >= from && p.paid_ms < to)
    .map((p) => ({ t: p.paid_ms, cents: p.amount_cents }))
    .sort((a, b) => a.t - b.t);
}

function firstActivityAt(data, jobId) {
  let min = Infinity;
  for (const s of data.shifts) if (!jobId || s.job_id === jobId) min = Math.min(min, s.start_ms);
  for (const p of data.payments) if (!jobId || p.job_id === jobId) min = Math.min(min, p.paid_ms);
  return Number.isFinite(min) ? min : null;
}

// ── metric registry ───────────────────────────────────────────────
// Every figure the Insights tab shows is declared here, so any of them can be
// charted over time with the same machinery. `kind` tells the UI how to format
// a value; the stats layer stays free of presentation.

export const METRICS = {
  rate:          { label: 'Effective rate',         kind: 'rate',     get: (d, w) => summarize(d, { ...w, allowRate: true }).rateCents },
  netRate:       { label: 'Rate after tax',         kind: 'rate',     get: (d, w) => summarize(d, { ...w, allowRate: true }).netRateCents },
  hours:         { label: 'Hours',                  kind: 'hours',    get: (d, w) => summarize(d, w).hours },
  income:        { label: 'Deposits received',      kind: 'money',    get: (d, w) => summarize(d, w).incomeCents },
  setAside:      { label: 'Set aside for tax',      kind: 'money',    get: (d, w) => summarize(d, w).setAsideCents },
  kept:          { label: 'Kept after tax',         kind: 'money',    get: (d, w) => summarize(d, w).netCents },
  shifts:        { label: 'Shifts',                 kind: 'count',    get: (d, w) => summarize(d, w).shiftCount },
  depositCount:  { label: 'Number of deposits',     kind: 'count',    get: (d, w) => depositStats(d, w).count },
  avgDeposit:    { label: 'Average deposit',        kind: 'money',    get: (d, w) => depositStats(d, w).avgCents || null },
  largestDeposit:{ label: 'Largest deposit',        kind: 'money',    get: (d, w) => depositStats(d, w).largestCents || null },
  gap:           { label: 'Gap between deposits',   kind: 'days',     get: (d, w) => depositStats(d, w).avgGapDays },
  hoursPer1k:    { label: 'Hours per $1,000',       kind: 'hours',    get: (d, w) => {
                     const s = summarize(d, w);
                     return s.incomeCents > 0 ? s.hours / (s.incomeCents / 100000) : null; } },
  perDayWorked:  { label: 'Earned per day worked',  kind: 'money',    get: (d, w) => {
                     const s = summarize(d, w), a = activityStats(d, w);
                     return a.daysWorked ? s.incomeCents / a.daysWorked : null; } },
  daysWorked:    { label: 'Days worked',            kind: 'count',    get: (d, w) => activityStats(d, w).daysWorked },
  hoursPerDay:   { label: 'Hours on a working day', kind: 'duration', get: (d, w) => activityStats(d, w).avgMsPerWorkingDay || null },
  avgShift:      { label: 'Average shift',          kind: 'duration', get: (d, w) => activityStats(d, w).avgShiftMs || null },
  longestShift:  { label: 'Longest shift',          kind: 'duration', get: (d, w) => activityStats(d, w).longestShiftMs || null },
  breakTime:     { label: 'Time on breaks',         kind: 'duration', get: (d, w) => activityStats(d, w).breakMs || null },
  weekendPct:    { label: 'Worked at weekends',     kind: 'pct',      get: (d, w) => patternStats(d, w).weekendPct },
  lateNightPct:  { label: 'Worked after 10pm',      kind: 'pct',      get: (d, w) => patternStats(d, w).lateNightPct },
};

export const startOfQuarter = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime();
};

const UNIT_START = { week: startOfWeek, month: startOfMonth, quarter: startOfQuarter, year: startOfYear };
const UNIT_NEXT = {
  week: (t) => addDays(t, 7),
  month: (t) => addMonths(t, 1),
  quarter: (t) => addMonths(t, 3),
  year: (t) => new Date(new Date(t).getFullYear() + 1, 0, 1).getTime(),
};

function unitLabel(t, unit) {
  const d = new Date(t);
  if (unit === 'week') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (unit === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  if (unit === 'quarter') return `Q${Math.floor(d.getMonth() / 3) + 1} ’${String(d.getFullYear()).slice(2)}`;
  return String(d.getFullYear());
}

/**
 * One metric across consecutive blocks, covering the whole history so the
 * chart can be scrolled. `block` is either a calendar unit or 'range', which
 * repeats the width of the selected range so you compare like with like.
 */
export function metricSeries(data, key, { range, block = 'range', jobId = null, now = Date.now(), cap = 400 }) {
  const metric = METRICS[key];
  if (!metric) return null;

  const first = firstActivityAt(data, jobId);
  if (first === null) return { metric, points: [], block };

  const points = [];
  const useRange = block === 'range' && range && range.from > MIN_TIME;

  if (useRange) {
    const span = range.to - range.from;
    for (let to = range.to; points.length < cap; to -= span) {
      points.unshift({ from: to - span, to, label: labelForSpan(to - span, span) });
      if (to - span <= first) break;
    }
  } else {
    const unit = block === 'range' ? 'year' : block;
    const step = UNIT_NEXT[unit];
    const endOfToday = startOfDay(now) + DAY_MS;
    for (let from = UNIT_START[unit](first); from < endOfToday && points.length < cap; from = step(from)) {
      points.push({ from, to: Math.min(step(from), endOfToday), label: unitLabel(from, unit) });
    }
  }

  for (const p of points) p.value = metric.get(data, { from: p.from, to: p.to, jobId, now });
  return { metric, points, block: useRange ? 'range' : (block === 'range' ? 'year' : block) };
}

function labelForSpan(from, span) {
  const d = new Date(from);
  if (span >= 300 * DAY_MS) return String(d.getFullYear());
  if (span >= 25 * DAY_MS) return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** How many whole buckets of `unit` fit between the first activity and now. */
export function periodsSinceStart(data, { unit, jobId = null, now = Date.now(), cap = 60 }) {
  const first = firstActivityAt(data, jobId);
  if (first === null) return 1;
  const n = unit === 'week'
    ? Math.floor((startOfWeek(now) - startOfWeek(first)) / (7 * DAY_MS)) + 1
    : (new Date(now).getFullYear() - new Date(first).getFullYear()) * 12
      + (new Date(now).getMonth() - new Date(first).getMonth()) + 1;
  return Math.max(1, Math.min(cap, n));
}
