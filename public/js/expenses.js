// Expense logic: totals, CSV, and the tax-time export. Pure — no DOM — so the
// export is testable and comes out byte-identical on every device.

/** The business-use portion. Unset means the whole amount was for business. */
export const businessCents = (e) =>
  e.business_cents === null || e.business_cents === undefined ? e.total_cents : e.business_cents;

export const isSplit = (e) =>
  e.business_cents !== null && e.business_cents !== undefined && e.business_cents !== e.total_cents;

export const UNCATEGORIZED = 'Uncategorized';

/** A deleted or missing category reads as Uncategorized rather than vanishing. */
export function categoryName(categories, id) {
  if (!id) return UNCATEGORIZED;
  const c = categories.find((x) => x.id === id && !x.deleted);
  return c ? c.name : UNCATEGORIZED;
}

export const vendorName = (e) => (e.vendor || '').trim() || 'Unknown vendor';

/**
 * category: '' = any, '__none' = uncategorized only, otherwise a category id.
 * A deleted category counts as uncategorized, matching how it is displayed.
 */
export function filterExpenses(expenses, categories, { jobId = '', from = -Infinity, to = Infinity, category = '' } = {}) {
  const live = new Set(categories.filter((c) => !c.deleted).map((c) => c.id));
  return expenses.filter((e) => {
    if (e.deleted) return false;
    if (jobId && e.job_id !== jobId) return false;
    if (e.spent_ms < from || e.spent_ms >= to) return false;
    if (category === '__none') return !e.category_id || !live.has(e.category_id);
    if (category) return e.category_id === category;
    return true;
  });
}

function groupTotals(expenses, keyOf) {
  const m = new Map();
  for (const e of expenses) {
    const k = keyOf(e);
    const g = m.get(k) || { name: k, count: 0, totalCents: 0, businessCents: 0 };
    g.count++;
    g.totalCents += e.total_cents;
    g.businessCents += businessCents(e);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.businessCents - a.businessCents || a.name.localeCompare(b.name));
}

export function summarizeExpenses(expenses, categories) {
  let total = 0, business = 0, withReceipts = 0;
  for (const e of expenses) {
    total += e.total_cents;
    business += businessCents(e);
    if ((e.attachments || []).length) withReceipts++;
  }
  return {
    count: expenses.length,
    totalCents: total,
    businessCents: business,
    withReceipts,
    byCategory: groupTotals(expenses, (e) => categoryName(categories, e.category_id)),
    byVendor: groupTotals(expenses, vendorName),
  };
}

export function yearsWithExpenses(expenses, now = Date.now()) {
  const ys = new Set([new Date(now).getFullYear()]);
  for (const e of expenses) if (!e.deleted) ys.add(new Date(e.spent_ms).getFullYear());
  return [...ys].sort((a, b) => b - a);
}

// ── CSV ───────────────────────────────────────────────────────────

// A cell starting with one of these is executed as a formula by Excel and
// Sheets. Vendor names and notes are typed by hand, so neutralise them.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v) {
  let s = String(v ?? '');
  if (FORMULA_START.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Plain decimals, no currency symbol, so spreadsheets can sum the column.
const dec = (cents) => (cents / 100).toFixed(2);
const pad2 = (n) => String(n).padStart(2, '0');
export const isoDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Safe for a filename on every OS: ASCII letters, digits, dots and dashes. */
export function safePart(s, max = 40) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9.]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, max)
    .replace(/[-.]+$/, '') || 'x';
}

const extOf = (key) => (String(key).match(/\.([a-z0-9]+)$/i)?.[1] || 'bin').toLowerCase();

/**
 * Everything for one job's tax-time archive. Returns the text files ready to
 * zip, plus the list of receipts to fetch and where each should be placed.
 */
export function buildExport({ expenses, categories, jobName, periodLabel, now = Date.now() }) {
  const folder = safePart(`${jobName} ${periodLabel} expenses`, 70);
  const sorted = [...expenses].sort((a, b) => a.spent_ms - b.spent_ms || String(a.id).localeCompare(String(b.id)));

  const used = new Set();
  const receipts = [];
  const fileNames = new Map();
  for (const e of sorted) {
    const base = [
      isoDate(e.spent_ms),
      safePart(vendorName(e), 30),
      safePart(categoryName(categories, e.category_id), 30),
      dec(businessCents(e)),
    ].join('_');
    const atts = e.attachments || [];
    const names = atts.map((a, i) => {
      const ext = extOf(a.key);
      const stem = atts.length > 1 ? `${base}_${i + 1}` : base;
      let name = `${stem}.${ext}`;
      for (let n = 2; used.has(name); n++) name = `${stem}-${n}.${ext}`;
      used.add(name);
      receipts.push({ key: a.key, path: `${folder}/receipts/${name}`, date: new Date(e.spent_ms) });
      return name;
    });
    fileNames.set(e.id, names);
  }

  const lines = (header, rows) => [header.join(','), ...rows.map((r) => r.join(','))].join('\r\n') + '\r\n';

  const expensesCsv = lines(
    ['Date', 'Vendor', 'Category', 'Total paid', 'Business use', 'Business %', 'Note', 'Receipt files'],
    sorted.map((e) => {
      const biz = businessCents(e);
      return [
        isoDate(e.spent_ms), csvCell(e.vendor), csvCell(categoryName(categories, e.category_id)),
        dec(e.total_cents), dec(biz),
        e.total_cents ? Math.round((biz / e.total_cents) * 100) + '%' : '',
        csvCell(e.note), csvCell(fileNames.get(e.id).join('; ')),
      ];
    }),
  );

  const sum = summarizeExpenses(sorted, categories);
  const totalsCsv = (label, groups) => lines(
    [label, 'Transactions', 'Total paid', 'Business use'],
    [
      ...groups.map((g) => [csvCell(g.name), g.count, dec(g.totalCents), dec(g.businessCents)]),
      ['Total', sum.count, dec(sum.totalCents), dec(sum.businessCents)],
    ],
  );

  const missing = sorted.filter((e) => !(e.attachments || []).length);
  const w = Math.max(12, ...sum.byCategory.map((g) => g.name.length)) + 2;
  const summary = [
    `${jobName} — business expenses, ${periodLabel}`,
    `Generated ${new Date(now).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} by Work Tracker`,
    '',
    `Business use     ${usd(sum.businessCents)}`,
    `Total paid       ${usd(sum.totalCents)}`,
    `Transactions     ${sum.count}`,
    `With receipts    ${sum.withReceipts} of ${sum.count}`,
    '',
    'BY CATEGORY (business use)',
    ...sum.byCategory.map((g) => `  ${g.name.padEnd(w)}${usd(g.businessCents).padStart(14)}   ${g.count}`),
    '',
    'BY VENDOR (business use)',
    ...sum.byVendor.map((g) => `  ${g.name.slice(0, 40).padEnd(Math.max(w, 42))}${usd(g.businessCents).padStart(14)}   ${g.count}`),
    ...(missing.length
      ? ['', `MISSING RECEIPTS (${missing.length})`,
         ...missing.map((e) => `  ${isoDate(e.spent_ms)}  ${vendorName(e).slice(0, 36).padEnd(38)}${usd(businessCents(e)).padStart(12)}`)]
      : ['', 'Every transaction has a receipt attached.']),
    '',
  ].join('\r\n');

  return {
    folder,
    files: [
      { name: `${folder}/summary.txt`, data: summary },
      { name: `${folder}/expenses.csv`, data: expensesCsv },
      { name: `${folder}/by-category.csv`, data: totalsCsv('Category', sum.byCategory) },
      { name: `${folder}/by-vendor.csv`, data: totalsCsv('Vendor', sum.byVendor) },
    ],
    receipts,
  };
}
