const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/trophies');
const LB = require('../public/leaderboard');

const cfg = { stages: ['Working', 'Won', 'Lost'], contestPrize: 'Steak dinner', contestPrizeMonth: '2026-10' };
const at = (m, d) => new Date(2026, m, d, 12).toISOString();
const dt = (m, d, h = 10) => `2026-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`;
const calls = (who, m, days, n = 1) => days.flatMap(d => Array.from({ length: n }, (_, i) => ({ owner: who, type: 'Call', done: true, dt: dt(m, d, 9 + i) })));
const base = () => ({
  cfg: { ...cfg },
  users: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bo' }],
  deals: [
    { id: '1', owner: 'a', stage: 'Won', amount: 3000, account: 'Acme', wonAt: at(9, 5) },
    { id: '2', owner: 'b', stage: 'Won', amount: 1000, account: 'Beta', wonAt: at(9, 2) },
    { id: '3', owner: 'b', stage: 'Won', amount: 500, account: 'Gamma', wonAt: at(9, 20) },
    { id: '4', owner: 'a', stage: 'Won', amount: 9000, account: 'Delta', wonAt: at(10, 3) },   // November, still running
  ],
  acts: [...calls('a', 9, [5, 6, 7, 8, 9, 12]), ...calls('b', 9, [1, 2], 5)],
});

test('a finished month is handed out once, with the prize, ties and records', () => {
  const now = new Date(2026, 10, 18, 9);
  const data = base();
  assert.deepEqual(T.pendingMonths(data, now).map(LB.monthKey), ['2026-10']);
  T.awardMonths(data, now);
  const by = k => data.trophies.awards.filter(a => a.kind === k).map(a => a.who);
  assert.deepEqual(by('champ'), ['a']);
  assert.equal(data.trophies.awards.find(a => a.kind === 'champ').prize, 'Steak dinner');
  assert.deepEqual(by('first'), ['b']);                 // Beta on Oct 2
  assert.deepEqual(by('calls'), ['b']);                 // 10 calls vs 6
  assert.deepEqual(by('deals'), ['b']);
  assert.deepEqual(data.trophies.records.deal, { who: 'a', value: 3000, month: '2026-10', deal: 'Acme' });
  assert.equal(data.trophies.records.streak.who, 'a'); // Oct 5-9 and 12 = 6 weekdays
  assert.equal(data.trophies.records.streak.value, 6);
  assert.deepEqual(data.trophies.months, ['2026-10']);
  const n = data.trophies.awards.length;
  T.awardMonths(data, now);
  assert.equal(data.trophies.awards.length, n);       // never twice
  assert.equal(T.pendingMonths(data, now).length, 0);
});

test('later edits do not change past trophies; next month and records update', () => {
  const data = base();
  T.awardMonths(data, new Date(2026, 10, 18));
  data.deals.find(d => d.id === '1').stage = 'Working';  // October's big deal reopened
  T.awardMonths(data, new Date(2026, 11, 2));           // December 2: November ends
  const oct = data.trophies.awards.filter(a => a.month === '2026-10' && a.kind === 'champ');
  assert.equal(oct[0].who, 'a');
  const nov = data.trophies.awards.filter(a => a.month === '2026-11' && a.kind === 'champ');
  assert.equal(nov[0].who, 'a'); assert.equal(nov[0].prize, undefined); // October's prize doesn't carry over
  assert.equal(data.trophies.records.deal.value, 9000);
  assert.equal(data.trophies.records.month.month, '2026-11');
});

test('browsers cannot overwrite trophies, and an unset prize month is filled in', async () => {
  const before = { trophies: { months: ['x'], awards: [], records: {} } };
  const after = { trophies: { months: [], awards: [{ kind: 'champ', who: 'me' }] } };
  T.keepTrophies(before, after); assert.deepEqual(after.trophies, before.trophies);
  const fresh = { trophies: 'junk' }; T.keepTrophies({}, fresh); assert.equal(fresh.trophies, undefined);

  let data = { cfg: { stages: ['W', 'Won', 'L'], contestPrize: 'Lunch' }, users: [], deals: [], acts: [] }, wrote = 0;
  const now = new Date(2026, 10, 18);
  assert.equal(await T.run(async () => data, async fn => { wrote++; fn(data) }, now), true);
  assert.equal(data.cfg.contestPrizeMonth, '2026-11');
  assert.equal(await T.run(async () => data, async fn => { wrote++; fn(data) }, now), false);
  assert.equal(wrote, 1);
});

test('longest streak counts weekdays in a row across a weekend', () => {
  assert.equal(LB.longestStreak({ '2026-11-12': 1, '2026-11-13': 1, '2026-11-16': 1, '2026-11-18': 1 }), 3);
  assert.equal(LB.longestStreak({ '2026-11-12': 1, '2026-11-13': 1, '2026-11-16': 1 }, '2026-11-13'), 2);
});
