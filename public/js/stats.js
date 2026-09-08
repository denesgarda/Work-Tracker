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
    { key: 'd90',   label: 'Last 90 days',  from: addDays(startOfDay(now), -89),     to: endOfToday, allowRate: true  },
    { key: 'ytd',   label: 'Year to date',  from: startOfYear(now),                  to: endOfToday, allowRate: true  },
    { key: 'y1',    label: 'Last 12 months',from: addMonths(startOfMonth(now), -11), to: endOfToday, allowRate: true  },
    { key: 'all',   label: 'All time',      from: -8640000000000000,                 to: endOfToday, allowRate: true  },
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
    const s = summarize(data, { from: -8640000000000000, to: t, jobId, now, allowRate: false });
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
