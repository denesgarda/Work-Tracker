import * as X from '../public/js/expenses.js';
import { crc32, makeZip } from '../public/js/zip.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra)); };
const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
const E = (o) => ({
  id: o.id, job_id: o.job ?? 'j1', category_id: o.cat ?? null, spent_ms: o.at, vendor: o.vendor ?? '',
  total_cents: o.total, business_cents: o.biz ?? null, note: o.note ?? '', attachments: o.atts ?? [], deleted: o.deleted ?? 0,
  flagged: o.flagged ?? 0, flag_note: o.flagNote ?? '',
});
const cats = [{ id: 'c1', name: 'Software' }, { id: 'c2', name: 'Equipment' }, { id: 'c3', name: 'Gone', deleted: 1 }];

console.log('\n-- business use --');
ok('unset business portion = whole total', X.businessCents(E({ id: 'a', at: at(2026, 1, 1), total: 1000 })) === 1000);
ok('split business portion is used', X.businessCents(E({ id: 'a', at: at(2026, 1, 1), total: 1000, biz: 600 })) === 600);
ok('split detected only when it differs',
  X.isSplit(E({ id: 'a', at: 0, total: 1000, biz: 600 })) &&
  !X.isSplit(E({ id: 'a', at: 0, total: 1000 })) &&
  !X.isSplit(E({ id: 'a', at: 0, total: 1000, biz: 1000 })));
ok('a zero business portion is respected, not treated as unset',
  X.businessCents(E({ id: 'a', at: 0, total: 1000, biz: 0 })) === 0);

console.log('\n-- categories --');
ok('live category resolves to its name', X.categoryName(cats, 'c1') === 'Software');
ok('deleted category reads as Uncategorized', X.categoryName(cats, 'c3') === X.UNCATEGORIZED);
ok('missing category reads as Uncategorized', X.categoryName(cats, 'nope') === X.UNCATEGORIZED);
ok('no category reads as Uncategorized', X.categoryName(cats, null) === X.UNCATEGORIZED);

console.log('\n-- filtering --');
const list = [
  E({ id: 'e1', job: 'j1', cat: 'c1', at: at(2026, 3, 1), total: 1000, atts: [{ key: 'exp/e1/a.jpg' }] }),
  E({ id: 'e2', job: 'j1', cat: 'c2', at: at(2025, 12, 31), total: 2000 }),
  E({ id: 'e3', job: 'j2', cat: 'c1', at: at(2026, 6, 1), total: 500 }),
  E({ id: 'e4', job: 'j1', cat: 'c3', at: at(2026, 4, 1), total: 300 }),
  E({ id: 'e5', job: 'j1', cat: null, at: at(2026, 5, 1), total: 700, biz: 350 }),
  E({ id: 'e6', job: 'j1', cat: 'c1', at: at(2026, 5, 2), total: 9999, deleted: 1 }),
];
const ids = (xs) => xs.map((e) => e.id).sort().join(',');
const y2026 = { from: new Date(2026, 0, 1).getTime(), to: new Date(2027, 0, 1).getTime() };
ok('per job, deleted rows excluded', ids(X.filterExpenses(list, cats, { jobId: 'j1' })) === 'e1,e2,e4,e5');
ok('per job and tax year', ids(X.filterExpenses(list, cats, { jobId: 'j1', ...y2026 })) === 'e1,e4,e5');
ok('New Year’s Eve stays in its own year', !X.filterExpenses(list, cats, { jobId: 'j1', ...y2026 }).some((e) => e.id === 'e2'));
ok('by category across jobs', ids(X.filterExpenses(list, cats, { category: 'c1' })) === 'e1,e3');
ok('uncategorized includes a deleted category', ids(X.filterExpenses(list, cats, { category: '__none' })) === 'e4,e5');

console.log('\n-- totals --');
const s = X.summarizeExpenses(X.filterExpenses(list, cats, { jobId: 'j1', ...y2026 }), cats);
ok('total paid', s.totalCents === 2000, s.totalCents);
ok('business use honours the split', s.businessCents === 1650, s.businessCents);
ok('receipts counted', s.withReceipts === 1 && s.count === 3);
ok('deleted and missing categories merge into one Uncategorized group',
  s.byCategory.filter((g) => g.name === X.UNCATEGORIZED).length === 1 &&
  s.byCategory.find((g) => g.name === X.UNCATEGORIZED).businessCents === 650);
ok('groups sorted by business use', s.byCategory[0].name === 'Software');

console.log('\n-- CSV safety --');
ok('formula is neutralised', X.csvCell('=SUM(A1)') === "'=SUM(A1)");
ok('leading minus is neutralised', X.csvCell('-5 promo') === "'-5 promo");
ok('comma is quoted', X.csvCell('a,b') === '"a,b"');
ok('quotes are doubled', X.csvCell('say "hi"') === '"say ""hi"""');
ok('newline is quoted', X.csvCell('a\nb') === '"a\nb"');
ok('plain text untouched', X.csvCell('Adobe') === 'Adobe');

console.log('\n-- filenames --');
ok('accents and slashes stripped', X.safePart('Café / Déjà vu') === 'Cafe-Deja-vu', X.safePart('Café / Déjà vu'));
ok('path traversal cannot survive', !X.safePart('../../etc/passwd').includes('..') && !X.safePart('../../etc/passwd').includes('/'));
ok('empty becomes a placeholder', X.safePart('') === 'x' && X.safePart('///') === 'x');
ok('length capped', X.safePart('a'.repeat(100), 20).length === 20);

console.log('\n-- export --');
const exp = [
  E({ id: 'x1', cat: 'c1', at: at(2026, 3, 14), vendor: 'Adobe', total: 5499, atts: [{ key: 'exp/x1/a.jpg' }] }),
  E({ id: 'x2', cat: 'c1', at: at(2026, 3, 14), vendor: 'Adobe', total: 5499, atts: [{ key: 'exp/x2/b.jpg' }] }),
  E({ id: 'x3', cat: 'c2', at: at(2026, 4, 2), vendor: 'B&H Photo', total: 20000, biz: 12000,
      atts: [{ key: 'exp/x3/c.jpg' }, { key: 'exp/x3/d.pdf' }] }),
  E({ id: 'x4', cat: null, at: at(2026, 5, 9), vendor: '=cmd', total: 2310, note: 'uber, to shoot' }),
];
const out = X.buildExport({ expenses: exp, categories: cats, jobName: 'UGC', periodLabel: '2026', now: at(2026, 9, 11) });
const names = out.receipts.map((r) => r.path.split('/').pop());
ok('every receipt gets a distinct name', new Set(names).size === names.length, names.join(' | '));
ok('identical transactions do not overwrite each other', names.includes('2026-03-14_Adobe_Software_54.99.jpg') && names.includes('2026-03-14_Adobe_Software_54.99-2.jpg'), names.join(' | '));
ok('multi-file expenses are numbered, and use the business amount', names.includes('2026-04-02_B-H-Photo_Equipment_120.00_1.jpg') && names.includes('2026-04-02_B-H-Photo_Equipment_120.00_2.pdf'), names.join(' | '));
ok('receipts live under the job folder', out.receipts.every((r) => r.path.startsWith(out.folder + '/receipts/')));
const csv = out.files.find((f) => f.name.endsWith('/expenses.csv')).data.trim().split('\r\n');
ok('expenses.csv: header plus one row per transaction', csv.length === 5 && csv[0].startsWith('Date,Vendor,Category'));
ok('expenses.csv: split shows total, business use and percentage', csv.some((l) => l.includes('200.00,120.00,60%')), csv.join('\n'));
ok('expenses.csv: hand-typed vendor cannot inject a formula', csv.some((l) => l.includes(",'=cmd,")));
const byCat = out.files.find((f) => f.name.endsWith('/by-category.csv')).data.trim().split('\r\n');
ok('by-category.csv ends with a correct total', byCat[byCat.length - 1] === 'Total,4,333.08,253.08', byCat[byCat.length - 1]);
const summary = out.files.find((f) => f.name.endsWith('/summary.txt')).data;
ok('summary flags the transaction with no receipt', summary.includes('MISSING RECEIPTS (1)') && summary.includes('=cmd'));

console.log('\n-- zip --');
ok('crc32 matches the standard check value', crc32(new TextEncoder().encode('123456789')) === 0xcbf43926);
const zipBytes = makeZip([
  ...out.files,
  { name: `${out.folder}/receipts/${names[0]}`, data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
]);
let haveUnzip = true;
try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { haveUnzip = false; }
if (haveUnzip) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-zip-'));
  const path = join(dir, 'export.zip');
  writeFileSync(path, zipBytes);
  let tested = true;
  try { execFileSync('unzip', ['-tq', path], { stdio: 'pipe' }); } catch { tested = false; }
  ok('archive passes unzip -t integrity check', tested);
  const listing = execFileSync('unzip', ['-Z1', path]).toString().trim().split('\n');
  ok('archive holds all four text files and the receipt, in folders', listing.length === 5 && listing.every((n) => n.startsWith(out.folder + '/')), listing.join(' | '));
  const back = execFileSync('unzip', ['-p', path, `${out.folder}/summary.txt`]).toString();
  ok('a file comes back out byte-for-byte', back === summary);
} else {
  console.log('  (unzip not installed — structural zip checks skipped)');
}

console.log('\n-- flags --');
const fl = [
  E({ id: 'f1', at: at(2026, 2, 1), vendor: 'Uber', total: 2310, flagged: 1, flagNote: 'Needs review', atts: [{ key: 'exp/f1/a.jpg' }] }),
  E({ id: 'f2', at: at(2026, 2, 2), vendor: 'Sephora', total: 4500, flagged: 1, flagNote: '=HYPERLINK("x")' }),
  E({ id: 'f3', at: at(2026, 2, 3), vendor: 'Adobe', total: 5499, atts: [{ key: 'exp/f3/a.jpg' }] }),
  E({ id: 'f4', at: at(2026, 2, 4), vendor: 'Target', total: 900, flagged: 1 }),
];
ok('status filter: flagged only', ids(X.filterExpenses(fl, cats, { status: 'flagged' })) === 'f1,f2,f4');
ok('status filter: missing a receipt', ids(X.filterExpenses(fl, cats, { status: 'noreceipt' })) === 'f2,f4');
ok('flagged counted in the summary', X.summarizeExpenses(fl, cats).flagged === 3);
const fx = X.buildExport({ expenses: fl, categories: cats, jobName: 'UGC', periodLabel: '2026' });
const fcsv = fx.files.find((f) => f.name.endsWith('/expenses.csv')).data.trim().split('\r\n');
ok('CSV gains Flagged and Flag reason columns', fcsv[0].includes('Business %,Flagged,Flag reason,Note'));
ok('a flagged row carries its reason', fcsv.some((l) => l.includes(',Yes,Needs review,')), fcsv.join('\n'));
ok('an unflagged row leaves both flag cells empty', fcsv.find((l) => l.includes('Adobe')).includes('%,,,'));
ok('a hand-typed flag reason cannot inject a formula', fcsv.some((l) => l.includes(`,Yes,"'=HYPERLINK(""x"")",`)), fcsv.join('\n'));
const fsum = fx.files.find((f) => f.name.endsWith('/summary.txt')).data;
ok('summary lists every flagged transaction with its reason', fsum.includes('FLAGGED FOR REVIEW (3)') && fsum.includes('Needs review'));
ok('a flag with no reason says so rather than printing nothing', fsum.includes('No reason given'));
ok('flagged items come before the breakdowns', fsum.indexOf('FLAGGED FOR REVIEW') < fsum.indexOf('BY CATEGORY'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
