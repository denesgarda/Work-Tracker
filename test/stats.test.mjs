import * as S from '../public/js/stats.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { cond ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra)); };
const near = (a, b, tol=1) => Math.abs(a-b) <= tol;
const H = S.HOUR_MS;
const at = (y,m,d,hh=0,mm=0) => new Date(y,m-1,d,hh,mm).getTime();

console.log('\n-- workedMsInWindow --');
const plain = { start_ms: at(2026,9,1,9), end_ms: at(2026,9,1,17), breaks: [] };
ok('8h shift', near(S.shiftWorkedMs(plain), 8*H));

const withBreak = { ...plain, breaks: [{ s: at(2026,9,1,12), e: at(2026,9,1,12,30) }] };
ok('break subtracted', near(S.shiftWorkedMs(withBreak), 7.5*H));
ok('break time reported', near(S.shiftBreakMs(withBreak), 0.5*H));

const now = at(2026,9,1,15);
const open = { start_ms: at(2026,9,1,9), end_ms: null, breaks: [] };
ok('open shift accrues to now', near(S.shiftWorkedMs(open, now), 6*H));

const openBreak = { start_ms: at(2026,9,1,9), end_ms: null, breaks: [{ s: at(2026,9,1,14), e: null }] };
ok('open break subtracted to now', near(S.shiftWorkedMs(openBreak, now), 5*H));

console.log('\n-- window clipping --');
ok('half in window', near(S.workedMsInWindow(plain, at(2026,9,1,13), at(2026,9,1,21)), 4*H));
ok('fully outside', S.workedMsInWindow(plain, at(2026,9,2), at(2026,9,3)) === 0);
ok('break outside window not subtracted',
   near(S.workedMsInWindow(withBreak, at(2026,9,1,13), at(2026,9,1,17)), 4*H));

console.log('\n-- midnight spanning --');
const overnight = { start_ms: at(2026,9,1,22), end_ms: at(2026,9,2,2), breaks: [] };
const d1 = S.workedMsInWindow(overnight, at(2026,9,1), at(2026,9,2));
const d2 = S.workedMsInWindow(overnight, at(2026,9,2), at(2026,9,3));
ok('2h lands on day 1', near(d1, 2*H));
ok('2h lands on day 2', near(d2, 2*H));
ok('total preserved', near(d1+d2, S.shiftWorkedMs(overnight)));

console.log('\n-- malformed input --');
const bad = { start_ms: at(2026,9,1,9), end_ms: at(2026,9,1,10), breaks: [{ s: at(2026,9,1,8), e: at(2026,9,1,20) }] };
ok('over-long break cannot go negative', S.shiftWorkedMs(bad) === 0);
const inverted = { start_ms: at(2026,9,1,17), end_ms: at(2026,9,1,9), breaks: [] };
ok('inverted shift is zero', S.shiftWorkedMs(inverted) === 0);

console.log('\n-- DST (America/New_York) --');
ok('spring-forward day is 23h', near(S.addDays(at(2025,3,9),1) - at(2025,3,9), 23*H));
ok('fall-back day is 25h', near(S.addDays(at(2025,11,2),1) - at(2025,11,2), 25*H));
const dstShift = { start_ms: at(2025,3,9,0), end_ms: at(2025,3,9,6), breaks: [] };
ok('shift across spring-forward is 5 wall-clock-adjusted h', near(S.shiftWorkedMs(dstShift), 5*H));

console.log('\n-- rate gating --');
const mk = (shifts, payments) => ({ shifts, payments });
const bigShift = { job_id:'j', start_ms: at(2026,9,1,9), end_ms: at(2026,9,1,19), breaks: [] };
const pay = { job_id:'j', paid_ms: at(2026,9,1,12), amount_cents: 50000, set_aside_cents: 15000 };

let s = S.summarize(mk([bigShift],[pay]), { from: at(2026,9,1), to: at(2026,9,2), now });
ok('rate computed with enough data', s.rateCents !== null && near(s.rateCents, 50000/10, 0.01));
ok('net rate uses post-set-aside', near(s.netRateCents, 35000/10, 0.01));
ok('net cents correct', s.netCents === 35000);

s = S.summarize(mk([bigShift],[]), { from: at(2026,9,1), to: at(2026,9,2), now });
ok('no payments -> no rate', s.rateCents === null && s.rateSuppressed === true);

const tiny = { job_id:'j', start_ms: at(2026,9,1,9), end_ms: at(2026,9,1,11), breaks: [] };
s = S.summarize(mk([tiny],[pay]), { from: at(2026,9,1), to: at(2026,9,2), now });
ok('under 5h -> no rate', s.rateCents === null);

s = S.summarize(mk([bigShift],[pay]), { from: at(2026,9,1), to: at(2026,9,2), now, allowRate: false });
ok('allowRate:false -> no rate, not flagged as suppressed', s.rateCents === null && s.rateSuppressed === false);

console.log('\n-- job filtering --');
const other = { job_id:'other', start_ms: at(2026,9,1,9), end_ms: at(2026,9,1,19), breaks: [] };
s = S.summarize(mk([bigShift, other],[pay]), { from: at(2026,9,1), to: at(2026,9,2), now, jobId: 'j' });
ok('filters shifts by job', near(s.hours, 10));
ok('filters payments by job', s.incomeCents === 50000);

console.log('\n-- ranges --');
const r = S.ranges(now);
ok('week ranges suppress rate', r.filter(x=>['wtd','week'].includes(x.key)).every(x=>x.allowRate===false));
ok('month+ ranges allow rate', r.filter(x=>['mtd','d90','ytd','y1','all'].includes(x.key)).every(x=>x.allowRate===true));
ok('all-time covers old data', S.summarize(mk([{job_id:'j',start_ms:at(1999,1,1,9),end_ms:at(1999,1,1,17),breaks:[]}],[]), {...r.find(x=>x.key==='all'), now}).hours === 8);

console.log('\n-- heatmap --');
const grid = S.heatmap(mk([overnight],[]), { now });
ok('overnight spreads across cells', near(grid[1][22]+grid[1][23], 2, 0.01) && near(grid[2][0]+grid[2][1], 2, 0.01));

console.log('\n-- deposit dated today (regression) --');
// The date picker stores a deposit at local noon. Windows must run to the end
// of today, or a deposit dated today vanishes from every stat until midday.
{
  const nowAM = at(2026,9,15,9,0);          // 9am
  const todayNoon = at(2026,9,15,12,0);     // how "today" is stored
  const d = mk(
    [{ job_id:'j', start_ms: at(2026,9,14,9), end_ms: at(2026,9,14,19), breaks: [] }],
    [{ job_id:'j', paid_ms: todayNoon, amount_cents: 50000, set_aside_cents: 0 }],
  );
  for (const key of ['mtd','d90','ytd','y1','all']) {
    const r = S.ranges(nowAM).find(x => x.key === key);
    const su = S.summarize(d, { from: r.from, to: r.to, now: nowAM, allowRate: r.allowRate });
    ok(`today's deposit counts in ${key}`, su.incomeCents === 50000, su.incomeCents);
  }
  const b = S.bucketSeries(d, { unit:'month', count:3, now: nowAM });
  ok('today\'s deposit counts in the current month bucket', b[b.length-1].incomeCents === 50000);

  // The window now extends past `now`; hours must not follow it into the future.
  const openNow = mk([{ job_id:'j', start_ms: at(2026,9,15,8), end_ms: null, breaks: [] }], []);
  const r = S.ranges(nowAM).find(x => x.key === 'mtd');
  const su = S.summarize(openNow, { from: r.from, to: r.to, now: nowAM, allowRate: false });
  ok('an open shift still accrues only to now, not to end of day', near(su.hours, 1, 0.001), su.hours);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
