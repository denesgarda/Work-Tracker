import { store, newId } from './store.js';
import * as S from './stats.js';
import { renderCharts, renderMetricChart } from './charts.js';
import { initExpenses } from './expenses-view.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── formatting ────────────────────────────────────────────────────

const money = (cents) =>
  (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (cents) =>
  (cents < 0 ? '-' : '') + '$' + Math.round(Math.abs(cents) / 100).toLocaleString();
const hours = (h) => h.toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'h';

function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
function dur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
const timeOf = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dayLabel = (ms) => {
  const t = S.startOfDay(ms), today = S.startOfDay(Date.now());
  if (t === today) return 'Today';
  if (t === S.addDays(today, -1)) return 'Yesterday';
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
};

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);
const toDateInput = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// Anchored at local noon so the deposit always lands on the day you picked,
// whatever the timezone offset or DST does.
const fromDateInput = (v) => {
  if (!v) return Date.now();
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
};

// ── ui state ──────────────────────────────────────────────────────

const ui = {
  view: 'clock',
  selectedJob: localStorage.getItem('wt.job') || null,
  historyJob: '',
  historyKind: 'all',
  insightsJob: '',
  insightsRange: 'd90',
  historyLimit: 60,
  historyFrom: null,
  historyTo: null,
  dismissedLongShift: null,
};

function toast(msg, kind = 'ok', action = null) {
  const el = $('#toast');
  el.textContent = '';
  el.append(Object.assign(document.createElement('span'), { textContent: msg }));
  if (action) {
    const b = Object.assign(document.createElement('button'), { textContent: action.label, className: 'toast-action' });
    b.addEventListener('click', () => { el.hidden = true; action.run(); });
    el.append(b);
  }
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3200);
}

/**
 * Delete is one tap and there is no confirmation dialog in the way, so the
 * safety net is an undo rather than a prompt. Restoring is just a put of the
 * rows we captured before deleting.
 */
function deleteWithUndo(message, rows) {
  store.mutate(rows.map(({ type, data }) => ({ type, op: 'delete', data: { id: data.id } })));
  toast(message, 'ok', {
    label: 'Undo',
    run: () => {
      store.mutate(rows.map(({ type, data }) => ({ type, op: 'put', data })));
      toast('Restored');
    },
  });
}

// ── sheet ─────────────────────────────────────────────────────────

let sheetOnDismiss = null;

function openSheet(title, html, wire, { onDismiss = null } = {}) {
  sheetOnDismiss = onDismiss;
  $('#sheetTitle').textContent = title;
  // A fresh body element for every sheet. Editors bind listeners to their
  // root, and reusing one element let each previous editor's handlers keep
  // firing into whichever sheet opened next — reading fields that no longer
  // existed, and in the expense editor, able to delete an already-saved file.
  const old = $('#sheetBody');
  const body = old.cloneNode(false);
  old.replaceWith(body);
  body.innerHTML = html;
  $('#sheet').hidden = false;
  wire?.(body);
  const first = $('#sheetBody input, #sheetBody select');
  if (first && !('ontouchstart' in window)) first.focus();
}
// Closing after a completed action. The dismiss hook is for walking away from
// a sheet, so it must not run here.
const closeSheet = () => { sheetOnDismiss = null; $('#sheet').hidden = true; $('#sheetBody').innerHTML = ''; };
// Backdrop, the × button, or Escape: the sheet was abandoned.
function dismissSheet() {
  const fn = sheetOnDismiss;
  closeSheet();
  fn?.();
}

$('#sheet').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) dismissSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) dismissSheet(); });

// ── clock actions ─────────────────────────────────────────────────

function currentJobId() {
  const jobs = store.activeJobs.filter((j) => !j.archived);
  if (!jobs.length) return null;
  if (ui.selectedJob && jobs.some((j) => j.id === ui.selectedJob)) return ui.selectedJob;
  return jobs[0].id;
}

function clockIn() {
  const jobId = currentJobId();
  if (!jobId) { toast('Add a job first', 'error'); return; }
  if (store.openShift) return;
  store.mutate([{ type: 'shift', op: 'put', data: {
    id: newId(), job_id: jobId, start_ms: Date.now(), end_ms: null, breaks: [], note: '',
  }}]);
}

function clockOut() {
  const s = store.openShift;
  if (!s) return;
  const now = Date.now();
  // Close a break that is still running, otherwise it would swallow every
  // hour between now and whenever the shift is next touched.
  const breaks = (s.breaks || []).map((b) => (b.e == null ? { ...b, e: now } : b));
  store.mutate([{ type: 'shift', op: 'put', data: { ...s, breaks, end_ms: now } }]);
  toast(`Clocked out — ${dur(S.shiftWorkedMs({ ...s, breaks, end_ms: now }))} logged`);
}

function toggleBreak() {
  const s = store.openShift;
  if (!s) return;
  const now = Date.now();
  const breaks = [...(s.breaks || [])];
  const openIdx = breaks.findIndex((b) => b.e == null);
  if (openIdx >= 0) breaks[openIdx] = { ...breaks[openIdx], e: now };
  else breaks.push({ s: now, e: null });
  store.mutate([{ type: 'shift', op: 'put', data: { ...s, breaks } }]);
}

// ── clock view ────────────────────────────────────────────────────

function renderClock() {
  const jobs = store.activeJobs.filter((j) => !j.archived);
  const open = store.openShift;
  const now = Date.now();

  $('#jobRow').innerHTML = jobs.length
    ? jobs.map((j) => `
        <button class="jobchip ${j.id === (open ? open.job_id : currentJobId()) ? 'is-active' : ''}"
                data-job="${esc(j.id)}" ${open ? 'disabled' : ''} type="button">
          <span class="swatch" style="background:${esc(j.color)}"></span>${esc(j.name)}
        </button>`).join('')
    : '<p class="empty" style="padding:6px 2px">No jobs yet. Add one in Setup to start tracking.</p>';

  const pip = $('#clockPip');
  const elapsed = $('#elapsed');
  const punch = $('#punchBtn');
  const brk = $('#breakBtn');

  if (open) {
    const paused = S.onBreak(open);
    const job = store.job(open.job_id);
    pip.dataset.state = paused ? 'break' : 'on';
    $('#clockStatus').textContent = paused ? `On a break — ${esc(job?.name ?? '')}` : `Working — ${job?.name ?? ''}`;
    $('#clockSince').textContent = 'since ' + timeOf(open.start_ms);
    elapsed.className = 'elapsed' + (paused ? ' is-break' : '');
    punch.textContent = 'Clock out';
    punch.dataset.mode = 'out';
    punch.disabled = false;
    brk.hidden = false;
    brk.textContent = paused ? 'Resume' : 'Take a break';
  } else {
    pip.dataset.state = 'off';
    $('#clockStatus').textContent = 'Clocked out';
    $('#clockSince').textContent = '';
    elapsed.className = 'elapsed is-idle';
    elapsed.textContent = '0:00:00';
    $('#elapsedSub').textContent = jobs.length ? 'Not on the clock' : '';
    punch.textContent = 'Clock in';
    punch.dataset.mode = 'in';
    punch.disabled = !jobs.length;
    brk.hidden = true;
  }

  $('#punchcardEdit').disabled = !open;
  renderLongShift(open, now);
  tick();
  renderTodayTiles(now);
  renderLedger($('#recentShifts'), recentEntries(6), { compact: true });
}

const LONG_SHIFT_MS = 12 * S.HOUR_MS;

/**
 * Forgetting to clock out is the likeliest way this data goes wrong, and it is
 * silent. Surface it when you next open the app, while you can still remember
 * when you actually stopped.
 */
function renderLongShift(open, now) {
  const banner = $('#longShift');
  const stale = open && !S.onBreak(open) && now - open.start_ms > LONG_SHIFT_MS && ui.dismissedLongShift !== open.id;
  banner.hidden = !stale;
  if (stale) {
    $('#longShiftText').textContent =
      `This shift has been running ${dur(now - open.start_ms)}. Did you forget to clock out?`;
  }
}

$('#longShiftOut').addEventListener('click', () => clockOut());
$('#longShiftFix').addEventListener('click', () => { const o = store.openShift; if (o) editShift(o); });
$('#longShiftKeep').addEventListener('click', () => {
  ui.dismissedLongShift = store.openShift?.id ?? null;
  renderClock();
});

// Ticks the running clock without re-rendering the view, so the timer stays
// smooth and never steals focus from anything.
function tick() {
  const open = store.openShift;
  if (!open) return;
  const now = Date.now();
  const worked = S.shiftWorkedMs(open, now);
  $('#elapsed').textContent = clock(worked);

  const brkMs = S.shiftBreakMs(open, now);
  const parts = [];
  if (S.onBreak(open)) parts.push('Paused — the clock is not counting');
  if (brkMs > 30000) parts.push(`${dur(brkMs)} on break`);
  if (now - open.start_ms > 16 * S.HOUR_MS) parts.push('running over 16h — forgot to clock out?');
  $('#elapsedSub').textContent = parts.join(' · ') || 'Counting';
}

function renderTodayTiles(now) {
  const d0 = S.startOfDay(now);
  const endOfToday = d0 + S.DAY_MS;
  const today = S.summarize(store.data, { from: d0, to: endOfToday, now, allowRate: false });
  const week = S.summarize(store.data, { from: S.startOfWeek(now), to: endOfToday, now, allowRate: false });
  $('#todayTiles').innerHTML = `
    <div class="tile"><div class="k">Today</div><div class="v hours">${hours(today.hours)}</div></div>
    <div class="tile"><div class="k">This week</div><div class="v hours">${hours(week.hours)}</div>
      <div class="sub">${week.shiftCount} shift${week.shiftCount === 1 ? '' : 's'}</div></div>`;
}

// ── ledger ────────────────────────────────────────────────────────

function allEntries({ jobId = '', kind = 'all', from = null, to = null } = {}) {
  const d = store.data;
  const out = [];
  const inSpan = (t) => (from === null || t >= from) && (to === null || t < to);
  if (kind !== 'payment') {
    for (const s of d.shifts) {
      if (jobId && s.job_id !== jobId) continue;
      if (!inSpan(s.start_ms)) continue;
      out.push({ kind: 'shift', t: s.start_ms, row: s });
    }
  }
  if (kind !== 'shift') {
    for (const p of d.payments) {
      if (jobId && p.job_id !== jobId) continue;
      if (!inSpan(p.paid_ms)) continue;
      out.push({ kind: 'payment', t: p.paid_ms, row: p });
    }
  }
  return out.sort((a, b) => b.t - a.t);
}

const recentEntries = (n) => allEntries({ kind: 'shift' }).slice(0, n);

function renderLedger(container, entries, { compact = false } = {}) {
  if (!entries.length) {
    container.innerHTML = `<p class="empty">${compact ? 'No shifts yet.' : 'Nothing here yet.'}</p>`;
    return;
  }
  const now = Date.now();
  const groups = new Map();
  for (const e of entries) {
    const k = S.startOfDay(e.t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  let html = '';
  for (const [day, list] of groups) {
    let dayMs = 0, dayCents = 0;
    for (const e of list) {
      if (e.kind === 'shift') dayMs += S.workedMsInWindow(e.row, day, S.addDays(day, 1), now);
      else dayCents += e.row.amount_cents;
    }
    const tot = [dayMs > 0 ? dur(dayMs) : null, dayCents ? money0(dayCents) : null].filter(Boolean).join('  ·  ');

    html += `<div class="daygroup"><div class="daygroup-head"><span>${esc(dayLabel(day))}</span><span class="tot">${esc(tot)}</span></div>`;
    for (const e of list) {
      const job = store.job(e.row.job_id);
      const color = job?.color || 'var(--muted)';
      if (e.kind === 'shift') {
        const s = e.row;
        const isOpen = S.isOpen(s);
        const worked = S.shiftWorkedMs(s, now);
        const brk = S.shiftBreakMs(s, now);
        const range = `${timeOf(s.start_ms)} – ${isOpen ? 'now' : timeOf(s.end_ms)}`;
        html += `
          <button class="entry ${isOpen ? 'is-open' : ''}" data-edit="shift" data-id="${esc(s.id)}" type="button">
            <span class="bar" style="background:${esc(color)}"></span>
            <span class="main">
              <span class="t1">${esc(job?.name ?? 'Unknown job')}</span>
              <span class="t2">${esc(range)}${brk > 30000 ? ` · ${dur(brk)} break` : ''}${s.note ? ' · ' + esc(s.note) : ''}</span>
            </span>
            <span class="amt">${dur(worked)}</span>
          </button>`;
      } else {
        const p = e.row;
        html += `
          <button class="entry payment" data-edit="payment" data-id="${esc(p.id)}" type="button">
            <span class="bar" style="background:${esc(color)}"></span>
            <span class="main">
              <span class="t1">Deposit — ${esc(job?.name ?? 'Unknown job')}</span>
              <span class="t2">${p.set_aside_cents ? `${money(p.set_aside_cents)} set aside for tax` : 'No tax set aside'}${p.note ? ' · ' + esc(p.note) : ''}</span>
            </span>
            <span class="amt">${money(p.amount_cents)}${p.set_aside_cents ? `<span class="s">${money(p.amount_cents - p.set_aside_cents)} net</span>` : ''}</span>
          </button>`;
      }
    }
    html += '</div>';
  }
  container.innerHTML = html;
}

// ── history view ──────────────────────────────────────────────────

function renderHistory() {
  fillJobSelect($('#historyJob'), ui.historyJob, 'All jobs');
  $$('#historyKind .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.kind === ui.historyKind));

  const span = $('#historySpan');
  if (ui.historyFrom !== null) {
    const d = new Date(ui.historyFrom);
    const sameMonth = new Date(ui.historyTo - 1).getMonth() === d.getMonth();
    span.hidden = false;
    span.querySelector('span').textContent = sameMonth
      ? d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} onwards`;
  } else {
    span.hidden = true;
  }

  const all = allEntries({ jobId: ui.historyJob, kind: ui.historyKind, from: ui.historyFrom, to: ui.historyTo });
  const shown = all.slice(0, ui.historyLimit);
  renderLedger($('#historyList'), shown);

  const more = all.length - shown.length;
  $('#historyMore').hidden = more <= 0;
  if (more > 0) $('#historyMore').textContent = `Show ${Math.min(more, 60)} more (${more} older)`;
}

function fillJobSelect(sel, value, allLabel) {
  const jobs = store.activeJobs;
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>` +
    jobs.map((j) => `<option value="${esc(j.id)}"${j.id === value ? ' selected' : ''}>${esc(j.name)}${j.archived ? ' (archived)' : ''}</option>`).join('');
}

// ── editors ───────────────────────────────────────────────────────

function jobOptions(selected) {
  return store.activeJobs.filter((j) => !j.archived || j.id === selected)
    .map((j) => `<option value="${esc(j.id)}"${j.id === selected ? ' selected' : ''}>${esc(j.name)}</option>`).join('');
}

function breakRowsHtml(breaks) {
  return (breaks || []).map((b, i) => `
    <div class="breakrow" data-i="${i}">
      <input class="input" type="datetime-local" data-bs value="${b.s ? toLocalInput(b.s) : ''}">
      <input class="input" type="datetime-local" data-be value="${b.e ? toLocalInput(b.e) : ''}">
      <button class="icon-btn" data-rmbreak type="button" aria-label="Remove break">&times;</button>
    </div>`).join('');
}

function editShift(shift) {
  const isNew = !shift;
  const now = Date.now();
  const s = shift || {
    id: newId(), job_id: currentJobId(), breaks: [], note: '',
    start_ms: S.addDays(S.startOfDay(now), 0) + 9 * S.HOUR_MS,
    end_ms: S.addDays(S.startOfDay(now), 0) + 12 * S.HOUR_MS,
  };

  openSheet(isNew ? 'Add a past shift' : 'Edit shift', `
    <div class="field"><label for="f-job">Job</label>
      <select class="select" id="f-job">${jobOptions(s.job_id)}</select></div>
    <div class="field-row">
      <div class="field"><label for="f-start">Started</label>
        <input class="input" type="datetime-local" id="f-start" value="${toLocalInput(s.start_ms)}"></div>
      <div class="field"><label for="f-end">Ended</label>
        <input class="input" type="datetime-local" id="f-end" value="${s.end_ms ? toLocalInput(s.end_ms) : ''}">
        ${S.isOpen(s) && !isNew ? '<p class="field-hint">Leave empty to keep it running.</p>' : ''}</div>
    </div>
    <div class="field"><label>Breaks</label>
      <div class="breaklist" id="f-breaks">${breakRowsHtml(s.breaks)}</div>
      <button class="btn btn-quiet" id="f-addbreak" type="button" style="margin-top:8px">Add a break</button>
      <p class="field-hint">Break time is subtracted from the hours this shift contributes.</p></div>
    <div class="field"><label for="f-note">Note</label>
      <input class="input" type="text" id="f-note" value="${esc(s.note)}" placeholder="Optional"></div>
    <p class="field-hint" id="f-preview"></p>
    <div class="row-actions" style="margin-top:14px">
      <button class="btn btn-primary btn-block" id="f-save" type="button">${isNew ? 'Add shift' : 'Save changes'}</button>
    </div>
    ${isNew ? '' : '<div class="row-actions" style="margin-top:8px"><button class="btn btn-danger btn-block" id="f-del" type="button">Delete shift</button></div>'}
  `, (root) => {
    const read = () => ({
      ...s,
      job_id: $('#f-job', root).value,
      start_ms: fromLocalInput($('#f-start', root).value),
      end_ms: fromLocalInput($('#f-end', root).value),
      note: $('#f-note', root).value,
      breaks: $$('.breakrow', root).map((r) => ({
        s: fromLocalInput($('[data-bs]', r).value),
        e: fromLocalInput($('[data-be]', r).value),
      })).filter((b) => b.s),
    });

    const preview = () => {
      const d = read();
      if (!d.start_ms) { $('#f-preview', root).textContent = ''; return; }
      if (d.end_ms && d.end_ms <= d.start_ms) {
        $('#f-preview', root).textContent = 'The end time is before the start time.';
        return;
      }
      $('#f-preview', root).textContent = `Counts as ${dur(S.shiftWorkedMs(d, Date.now()))} of worked time.`;
    };
    root.addEventListener('input', preview);
    preview();

    $('#f-addbreak', root).addEventListener('click', () => {
      const d = read();
      const base = d.start_ms || Date.now();
      $('#f-breaks', root).insertAdjacentHTML('beforeend',
        breakRowsHtml([{ s: base + S.HOUR_MS * 3, e: base + S.HOUR_MS * 3.5 }]));
      preview();
    });
    root.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-rmbreak')) { e.target.closest('.breakrow').remove(); preview(); }
    });

    $('#f-save', root).addEventListener('click', () => {
      const d = read();
      if (!d.job_id) return toast('Pick a job', 'error');
      if (!d.start_ms) return toast('A start time is required', 'error');
      if (d.end_ms && d.end_ms <= d.start_ms) return toast('The end time must come after the start', 'error');
      if (!d.end_ms && store.openShift && store.openShift.id !== d.id) {
        return toast('Another shift is still running — close that one first', 'error');
      }
      store.mutate([{ type: 'shift', op: 'put', data: d }]);
      closeSheet();
      toast(isNew ? 'Shift added' : 'Shift saved');
    });

    $('#f-del', root)?.addEventListener('click', () => {
      closeSheet();
      deleteWithUndo('Shift deleted', [{ type: 'shift', data: s }]);
    });
  });
}

function editPayment(payment) {
  const isNew = !payment;
  const p = payment || { id: newId(), job_id: currentJobId(), paid_ms: Date.now(), amount_cents: 0, set_aside_cents: 0, note: '' };

  openSheet(isNew ? 'Log a deposit' : 'Edit deposit', `
    <div class="field"><label for="f-job">Job</label>
      <select class="select" id="f-job">${jobOptions(p.job_id)}</select></div>
    <div class="field"><label for="f-date">Date it landed</label>
      <input class="input" type="date" id="f-date" value="${toDateInput(p.paid_ms)}"></div>
    <div class="field-row">
      <div class="field"><label for="f-amt">Amount</label>
        <input class="input" type="number" inputmode="decimal" step="0.01" id="f-amt"
               value="${p.amount_cents ? (p.amount_cents / 100).toFixed(2) : ''}" placeholder="0.00"></div>
      <div class="field"><label for="f-aside">Moved to tax</label>
        <input class="input" type="number" inputmode="decimal" step="0.01" id="f-aside"
               value="${p.set_aside_cents ? (p.set_aside_cents / 100).toFixed(2) : ''}" placeholder="0.00"></div>
    </div>
    <div class="row-actions" id="f-quick"></div>
    <p class="field-hint" id="f-net"></p>
    <div class="field" style="margin-top:12px"><label for="f-note">Note</label>
      <input class="input" type="text" id="f-note" value="${esc(p.note)}" placeholder="Optional"></div>
    <div class="row-actions" style="margin-top:14px">
      <button class="btn btn-primary btn-block" id="f-save" type="button">${isNew ? 'Log deposit' : 'Save changes'}</button>
    </div>
    ${isNew ? '' : '<div class="row-actions" style="margin-top:8px"><button class="btn btn-danger btn-block" id="f-del" type="button">Delete deposit</button></div>'}
  `, (root) => {
    const cents = (v) => Math.round((parseFloat(v) || 0) * 100);
    const amtEl = $('#f-amt', root), asideEl = $('#f-aside', root);

    $('#f-quick', root).innerHTML = [20, 25, 30, 35].map((pct) =>
      `<button class="btn btn-quiet" data-pct="${pct}" type="button">${pct}%</button>`).join('');
    $('#f-quick', root).addEventListener('click', (e) => {
      const pct = e.target.dataset.pct;
      if (!pct) return;
      asideEl.value = ((cents(amtEl.value) * pct) / 100 / 100).toFixed(2);
      net();
    });

    const net = () => {
      const a = cents(amtEl.value), sa = cents(asideEl.value);
      $('#f-net', root).textContent = a
        ? `${money(a - sa)} left after tax${a ? ` · ${((sa / a) * 100).toFixed(0)}% set aside` : ''}`
        : '';
    };
    root.addEventListener('input', net);
    net();

    $('#f-save', root).addEventListener('click', () => {
      const amount = cents(amtEl.value);
      const aside = cents(asideEl.value);
      const jobId = $('#f-job', root).value;
      if (!jobId) return toast('Pick a job', 'error');
      if (amount <= 0) return toast('Enter an amount', 'error');
      if (aside > amount) return toast('The tax amount is more than the deposit', 'error');
      store.mutate([{ type: 'payment', op: 'put', data: {
        ...p, job_id: jobId, paid_ms: fromDateInput($('#f-date', root).value),
        amount_cents: amount, set_aside_cents: aside, note: $('#f-note', root).value,
      }}]);
      closeSheet();
      toast(isNew ? 'Deposit logged' : 'Deposit saved');
    });

    $('#f-del', root)?.addEventListener('click', () => {
      closeSheet();
      deleteWithUndo('Deposit deleted', [{ type: 'payment', data: p }]);
    });
  });
}

const PALETTE = ['#6a9c5f', '#d2a24c', '#c97a3d', '#7f9bb5', '#a97fb5', '#c0553d', '#5fa397', '#b58a5f'];

function editJob(job) {
  const isNew = !job;
  const j = job || { id: newId(), name: '', color: PALETTE[store.activeJobs.length % PALETTE.length], archived: 0, created_ms: Date.now() };
  const counts = (() => {
    const d = store.data;
    return {
      shifts: d.shifts.filter((s) => s.job_id === j.id).length,
      payments: d.payments.filter((p) => p.job_id === j.id).length,
      expenses: d.expenses.filter((x) => x.job_id === j.id).length,
    };
  })();

  openSheet(isNew ? 'Add a job' : 'Edit job', `
    <div class="field"><label for="f-name">Name</label>
      <input class="input" type="text" id="f-name" value="${esc(j.name)}" placeholder="e.g. UGC" maxlength="60"></div>
    <div class="field"><label>Colour</label>
      <div class="jobrow" id="f-colors">${PALETTE.map((c) => `
        <button class="jobchip ${c === j.color ? 'is-active' : ''}" data-color="${c}" type="button">
          <span class="swatch" style="background:${c}"></span></button>`).join('')}</div></div>
    ${isNew ? '' : `
      <div class="field"><label for="f-arch">Status</label>
        <select class="select" id="f-arch">
          <option value="0"${j.archived ? '' : ' selected'}>Active</option>
          <option value="1"${j.archived ? ' selected' : ''}>Archived — hidden from the clock, history kept</option>
        </select></div>`}
    <div class="row-actions" style="margin-top:14px">
      <button class="btn btn-primary btn-block" id="f-save" type="button">${isNew ? 'Add job' : 'Save changes'}</button>
    </div>
    ${isNew ? '' : `
      <div class="row-actions" style="margin-top:8px">
        <button class="btn btn-danger btn-block" id="f-del" type="button">Delete job</button>
      </div>
      <p class="field-hint">Deleting removes ${counts.shifts} shift${counts.shifts === 1 ? '' : 's'}, ${counts.payments} deposit${counts.payments === 1 ? '' : 's'} and ${counts.expenses} expense${counts.expenses === 1 ? '' : 's'} with it. Archive instead to keep the history.</p>`}
  `, (root) => {
    let color = j.color;
    $('#f-colors', root).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-color]');
      if (!btn) return;
      color = btn.dataset.color;
      $$('#f-colors .jobchip', root).forEach((b) => b.classList.toggle('is-active', b === btn));
    });

    $('#f-save', root).addEventListener('click', () => {
      const name = $('#f-name', root).value.trim();
      if (!name) return toast('Give the job a name', 'error');
      const archived = Number($('#f-arch', root)?.value ?? 0);
      store.mutate([{ type: 'job', op: 'put', data: { ...j, name, color, archived, created_ms: j.created_ms } }]);
      closeSheet();
      toast(isNew ? 'Job added' : 'Job saved');
    });

    $('#f-del', root)?.addEventListener('click', () => {
      if (!confirm(`Delete "${j.name}" and its ${counts.shifts} shift(s), ${counts.payments} deposit(s) and ${counts.expenses} expense(s)?`)) return;
      const d = store.data;
      const rows = [{ type: 'job', data: j }];
      for (const sh of d.shifts) if (sh.job_id === j.id) rows.push({ type: 'shift', data: sh });
      for (const pm of d.payments) if (pm.job_id === j.id) rows.push({ type: 'payment', data: pm });
      for (const ex of d.expenses) if (ex.job_id === j.id) rows.push({ type: 'expense', data: ex });
      closeSheet();
      deleteWithUndo(`Deleted "${j.name}"`, rows);
    });
  });
}

// ── insights ──────────────────────────────────────────────────────

function renderInsights() {
  const now = Date.now();
  fillJobSelect($('#insightsJob'), ui.insightsJob, 'All jobs');

  const rs = S.ranges(now);
  $('#insightsRange').innerHTML = rs.map((r) =>
    `<option value="${r.key}"${r.key === ui.insightsRange ? ' selected' : ''}>${esc(r.label)}</option>`).join('');

  const r = rs.find((x) => x.key === ui.insightsRange) || rs[3];
  const jobId = ui.insightsJob || null;
  const data = store.data;
  const win = { from: r.from, to: r.to, jobId, now };
  const s0 = S.summarize(data, { ...win, allowRate: r.allowRate });

  // The same window immediately before this one, for change-over-time.
  const prevWin = S.previousWindow(r);
  const p0 = prevWin ? S.summarize(data, { from: prevWin.from, to: prevWin.to, jobId, now, allowRate: r.allowRate }) : null;
  const since = prevWin ? `the previous ${prevWin.days} days` : null;

  const delta = (cur, prev, fmt) => {
    if (!since || cur == null || prev == null || prev === 0) return '';
    const d = cur - prev;
    if (Math.abs(d) < 0.0001) return `level with ${since}`;
    return `${d > 0 ? 'up' : 'down'} ${fmt(Math.abs(d))} from ${since}`;
  };

  const rateTile = s0.rateCents !== null
    ? `<button class="tile lead" type="button" data-metric="rate">
         <div class="k">Effective rate — ${esc(r.label.toLowerCase())}</div>
         <div class="v money">${money(s0.rateCents)}<span class="unit">/hr</span></div>
         <div class="sub">${money(s0.netRateCents)}/hr after tax${
           p0 && p0.rateCents !== null ? ' · ' + delta(s0.rateCents, p0.rateCents, (v) => money(v)) : ''}</div>
       </button>`
    : `<div class="tile lead">
         <div class="k">Effective rate — ${esc(r.label.toLowerCase())}</div>
         <div class="v none">${esc(rateExplanation(r, s0))}</div>
       </div>`;

  $('#insightTiles').innerHTML = `
    ${rateTile}
    <button class="tile" type="button" data-metric="hours"><div class="k">Hours</div><div class="v hours">${hours(s0.hours)}</div>
      <div class="sub">${p0 ? esc(delta(s0.hours, p0.hours, (v) => hours(v))) : `${s0.shiftCount} shifts`}</div></button>
    <button class="tile" type="button" data-metric="income"><div class="k">Deposits</div><div class="v money">${money0(s0.incomeCents)}</div>
      <div class="sub">${p0 ? esc(delta(s0.incomeCents, p0.incomeCents, (v) => money0(v))) : `${s0.paymentCount} payments`}</div></button>
    <button class="tile" type="button" data-metric="kept"><div class="k">Kept after tax</div><div class="v money">${money0(s0.netCents)}</div>
      <div class="sub">${s0.incomeCents ? ((s0.setAsideCents / s0.incomeCents) * 100).toFixed(0) + '% set aside' : '—'}</div></button>`;

  const act = S.activityStats(data, win);
  const dep = S.depositStats(data, win);
  const pat = S.patternStats(data, win);

  const hoursPer1k = s0.incomeCents > 0 ? s0.hours / (s0.incomeCents / 100000) : null;
  const perWorkingDay = act.daysWorked ? s0.incomeCents / act.daysWorked : null;
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const clockOf = (mins) => {
    if (mins == null) return '—';
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  };
  const pct = (x) => (x * 100).toFixed(0) + '%';

  $('#statSections').innerHTML = `
    <div class="card">
      <h2 class="card-title">Money</h2>
      ${statList([
        ['Total received', dep.count ? money(dep.totalCents) : '—', 'income'],
        ['Number of deposits', String(dep.count), 'depositCount'],
        ['Average deposit', dep.count ? money(dep.avgCents) : '—', 'avgDeposit'],
        ['Largest deposit', dep.count ? money(dep.largestCents) : '—', 'largestDeposit'],
        ['Set aside for tax', money(s0.setAsideCents), 'setAside'],
        ['Hours per $1,000', hoursPer1k !== null ? hoursPer1k.toFixed(1) + 'h' : '—', 'hoursPer1k'],
        ['Earned per day worked', perWorkingDay !== null ? money(perWorkingDay) : '—', 'perDayWorked'],
        ['Typical gap between deposits', dep.avgGapDays !== null ? Math.round(dep.avgGapDays) + ' days' : '—', 'gap'],
        ['Since your last deposit', dep.daysSinceLast !== null
          ? `${dep.daysSinceLast} day${dep.daysSinceLast === 1 ? '' : 's'}` +
            (dep.avgGapDays !== null && dep.daysSinceLast > dep.avgGapDays * 1.5 ? ' — longer than usual' : '')
          : '—'],
      ])}
    </div>

    <div class="card">
      <h2 class="card-title">Time</h2>
      ${statList([
        ['Days worked', act.spanDays ? `${act.daysWorked} of ${act.spanDays}` : String(act.daysWorked), 'daysWorked'],
        ['Shifts', String(act.shiftCount), 'shifts'],
        ['Hours on a working day', act.daysWorked ? dur(act.avgMsPerWorkingDay) : '—', 'hoursPerDay'],
        ['Average shift', act.shiftCount ? dur(act.avgShiftMs) : '—', 'avgShift'],
        ['Longest shift', act.longestShiftMs ? dur(act.longestShiftMs) : '—', 'longestShift'],
        ['Time on breaks', act.breakMs ? `${dur(act.breakMs)} · ${pct(act.breakPct)} of clocked time` : 'None logged', 'breakTime'],
      ])}
    </div>

    <div class="card">
      <h2 class="card-title">Patterns</h2>
      ${statList([
        ['Busiest day', pat.busiestWeekday !== null ? DAYS[pat.busiestWeekday] : '—'],
        ['Typical start', clockOf(pat.medianStartMinutes)],
        ['Worked at weekends', pct(pat.weekendPct), 'weekendPct'],
        ['Worked after 10pm', pct(pat.lateNightPct), 'lateNightPct'],
      ])}
    </div>`;

  renderCharts($('#charts'), data, {
    jobId, now, from: r.from, to: r.to,
    // Tapping a bar takes you to the entries behind it.
    onDrill: (bucket) => {
      ui.historyFrom = bucket.from;
      ui.historyTo = bucket.to;
      ui.historyJob = ui.insightsJob;
      ui.historyLimit = 60;
      switchTo('history');
    },
  });
}

function statList(rows) {
  return '<dl class="statlist">' + rows.map(([k, v, metric]) => metric
    ? `<div><button class="statrow" type="button" data-metric="${esc(metric)}">
         <dt>${esc(k)}</dt><dd>${esc(v)}</dd></button></div>`
    : `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('') + '</dl>';
}

// ── metric breakdown ──────────────────────────────────────────────

const money0Fmt = (v) => money0(v);
const FORMATTERS = {
  money: money0Fmt,
  rate: (v) => money(v) + '/hr',
  hours: (v) => hours(v),
  count: (v) => String(Math.round(v)),
  pct: (v) => (v * 100).toFixed(0) + '%',
  days: (v) => Math.round(v) + ' days',
  duration: (v) => dur(v),
};
const TONE = { money: 'gold', rate: 'gold', days: 'gold' };

/**
 * Tapping any figure opens it as a row of blocks the width of the current
 * range, so "last 90 days" becomes 90-day blocks compared side by side.
 */
function openMetricSheet(key) {
  const spec = S.METRICS[key];
  if (!spec) return;
  const now = Date.now();
  const range = S.ranges(now).find((x) => x.key === ui.insightsRange) || S.ranges(now)[0];
  const jobId = ui.insightsJob || null;
  const fmt = FORMATTERS[spec.kind] || String;
  const current = spec.get(store.data, { from: range.from, to: range.to, jobId, now });
  const gold = TONE[spec.kind] === 'gold';

  openSheet(spec.label, `
    <div class="metric-now">
      <div class="v ${gold ? 'money' : 'hours'}">${current == null ? '—' : esc(fmt(current))}</div>
      <div class="k">${esc(range.label)}${ui.insightsJob ? ' · ' + esc(store.job(ui.insightsJob)?.name ?? '') : ''}</div>
    </div>
    <div id="metricChart"></div>
  `, (root) => {
    renderMetricChart($('#metricChart', root), {
      data: store.data, key, range, jobId, now,
      format: fmt,
      color: gold ? '#c98500' : '#199e70',
    });
  });
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-metric]');
  if (el) openMetricSheet(el.dataset.metric);
});

// An empty rate should say why it is empty. "—" teaches nothing.
function rateExplanation(range, s) {
  if (!range.allowRate) return 'Not shown for a window this short — deposit timing would dominate';
  if (s.paymentCount === 0) return 'No deposits landed in this window yet';
  if (s.hours < 5) return 'Not enough hours logged in this window yet';
  return 'Not enough data yet';
}

// ── setup ─────────────────────────────────────────────────────────

function renderSetup() {
  const now = Date.now();
  const jobs = store.activeJobs;
  $('#jobList').innerHTML = jobs.length ? jobs.map((j) => {
    const s = S.summarize(store.data, { from: S.MIN_TIME, to: S.startOfDay(now) + S.DAY_MS, jobId: j.id, now, allowRate: false });
    return `<div class="jobitem ${j.archived ? 'archived' : ''}">
      <span class="swatch" style="background:${esc(j.color)}"></span>
      <span class="nm">${esc(j.name)}${j.archived ? ' · archived' : ''}</span>
      <span class="meta">${hours(s.hours)} · ${money0(s.incomeCents)}</span>
      <button class="btn btn-quiet" data-editjob="${esc(j.id)}" type="button">Edit</button>
    </div>`;
  }).join('') : '<p class="empty">No jobs yet.</p>';
  expenseView.renderCategories();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── wiring ────────────────────────────────────────────────────────

function switchTo(view) {
  ui.view = view;
  $$('.tab').forEach((x) => x.classList.toggle('is-active', x.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  window.scrollTo({ top: 0 });
  render();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTo(t.dataset.view)));

$('#punchBtn').addEventListener('click', () => (store.openShift ? clockOut() : clockIn()));

// Clocking in late is the common case; make fixing it one tap from here
// rather than a trip through History.
$('#punchcardEdit').addEventListener('click', () => {
  const open = store.openShift;
  if (open) editShift(open);
});
$('#breakBtn').addEventListener('click', toggleBreak);

$('#jobRow').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-job]');
  if (!btn || btn.disabled) return;
  ui.selectedJob = btn.dataset.job;
  localStorage.setItem('wt.job', ui.selectedJob);
  renderClock();
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.edit === 'shift') editShift(store.shifts.get(id));
  else editPayment(store.payments.get(id));
});

$('#addShiftBtn').addEventListener('click', () => editShift(null));
$('#addPaymentBtn').addEventListener('click', () => editPayment(null));
$('#addJobBtn').addEventListener('click', () => editJob(null));
$('#jobList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-editjob]')?.dataset.editjob;
  if (id) editJob(store.job(id));
});

$('#historyJob').addEventListener('change', (e) => { ui.historyJob = e.target.value; ui.historyLimit = 60; renderHistory(); });
$('#historyMore').addEventListener('click', () => { ui.historyLimit += 60; renderHistory(); });
$('#historySpan').addEventListener('click', () => {
  ui.historyFrom = ui.historyTo = null;
  ui.historyLimit = 60;
  renderHistory();
});
$('#historyKind').addEventListener('click', (e) => {
  const k = e.target.dataset.kind;
  if (!k) return;
  ui.historyKind = k;
  ui.historyLimit = 60;
  renderHistory();
});
$('#insightsJob').addEventListener('change', (e) => { ui.insightsJob = e.target.value; renderInsights(); });
$('#insightsRange').addEventListener('change', (e) => { ui.insightsRange = e.target.value; renderInsights(); });

$('#exportCsvBtn').addEventListener('click', () =>
  download(`work-tracker-${toDateInput(Date.now())}.csv`, store.exportCsv(), 'text/csv'));
$('#exportJsonBtn').addEventListener('click', () =>
  download(`work-tracker-${toDateInput(Date.now())}.json`, store.exportJson(), 'application/json'));

$('#syncPill').addEventListener('click', () => store.pull());

// ── expenses ──────────────────────────────────────────────────────

const expenseView = initExpenses({
  store, newId, $, $$, esc, money, money0, openSheet, closeSheet, toast, deleteWithUndo,
  toDateInput, fromDateInput, currentJobId, jobOptions, fillJobSelect, download,
});

// ── render loop ───────────────────────────────────────────────────

function renderSync() {
  const pill = $('#syncPill');
  pill.dataset.status = store.status;
  $('#syncText').textContent =
    store.status === 'live' ? 'Live' : store.status === 'offline' ? 'Offline' : 'Connecting';
  pill.title = store.lastError || 'Synced across your devices';
}

function render() {
  renderSync();
  if (ui.view === 'clock') renderClock();
  else if (ui.view === 'history') renderHistory();
  else if (ui.view === 'insights') renderInsights();
  else if (ui.view === 'expenses') expenseView.render();
  else if (ui.view === 'setup') renderSetup();
}

store.subscribe(render);
setInterval(() => { if (ui.view === 'clock') tick(); }, 500);
// Keeps "Today"/"This week" honest across midnight without a reload.
setInterval(() => { if (!document.hidden) render(); }, 60000);

$('#boot').hidden = true;
$('#shell').hidden = false;
render();
store.connect();
