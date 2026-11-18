const test = require('node:test');
const assert = require('node:assert/strict');
const LB = require('../public/leaderboard');
const { stampWonAt } = require('../src/wonAt');

const cfg = { stages: ['Working', 'Proposal', 'Won', 'Lost'] };
const now = new Date(2026, 10, 18, 15, 0); // Wed Nov 18 2026, local time
const at = (m, d, h = 12) => new Date(2026, m, d, h).toISOString();
const dt = (m, d, h = 10) => `2026-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`;

test('windows start on Monday, the 1st and the quarter start', () => {
  assert.equal(LB.ymd(LB.winStart('week', now)), '2026-11-16');
  assert.equal(LB.ymd(LB.winStart('month', now)), '2026-11-01');
  assert.equal(LB.ymd(LB.winStart('quarter', now)), '2026-10-01');
  assert.equal(LB.ymd(LB.winEnd('quarter', now)), '2027-01-01');
});

test('won date prefers wonAt, then the client record, then history, then expected close', () => {
  const S = { cfg, accts: [{ dealId: 'b', created: '2026-11-03' }], log: [{ ref: 'Dc', text: 'Stage → Won', at: at(10, 5) }] };
  assert.equal(LB.wonDate(S, { id: 'a', stage: 'Won', wonAt: at(10, 2) }).getDate(), 2);
  assert.equal(LB.wonDate(S, { id: 'b', stage: 'Won' }).getDate(), 3);
  assert.equal(LB.wonDate(S, { id: 'c', stage: 'Won' }).getDate(), 5);
  assert.equal(LB.wonDate(S, { id: 'd', stage: 'Won', close: '2026-11-07' }).getDate(), 7);
  assert.equal(LB.wonDate(S, { id: 'e', stage: 'Proposal', wonAt: at(10, 2) }), null);
});

test('board ranks by closed revenue in the window and counts activity', () => {
  const S = {
    cfg: { ...cfg, commission: 10, lbOut: ['boss'] },
    users: [{ id: 'u1', name: 'Pat Lee' }, { id: 'u2', name: 'Sam Roe' }, { id: 'boss', name: 'Owner' }],
    deals: [
      { id: '1', owner: 'u1', stage: 'Won', amount: 1000, wonAt: at(10, 17) },
      { id: '2', owner: 'u2', stage: 'Won', amount: '2500', wonAt: at(10, 3) },
      { id: '3', owner: 'u2', stage: 'Won', amount: 900, wonAt: at(9, 20) },   // last month
      { id: '4', owner: 'u1', stage: 'Proposal', amount: 9999 },
      { id: '5', owner: 'boss', stage: 'Won', amount: 50000, wonAt: at(10, 10) },
    ],
    acts: [
      ...[1, 2, 3, 4, 5].map(h => ({ owner: 'u1', type: 'Call', done: true, dt: dt(10, 17, 8 + h) })),
      { owner: 'u1', type: 'Call', done: false, dt: dt(10, 17) },
      { owner: 'u1', type: 'Meeting', done: true, dt: dt(10, 18) },
      { owner: 'u2', type: 'Call', done: true, dt: dt(11, 2) },               // next month: not this month
    ],
    leads: [{ owner: 'u2', createdAt: at(10, 16) }, { owner: 'u2', createdAt: at(9, 1) }],
  };
  const m = LB.board(S, 'month', now);
  assert.deepEqual(m.rows.map(r => r.name), ['Sam Roe', 'Pat Lee']);
  const [sam, pat] = m.rows;
  assert.equal(sam.rev, 2500); assert.equal(sam.comm, 250); assert.equal(sam.leads, 1); assert.equal(sam.calls, 0);
  assert.equal(pat.gap, 1500); assert.equal(pat.calls, 5); assert.equal(pat.mtgs, 1); assert.equal(pat.fiveDays, 1);
  assert.equal(m.total, 3500);

  const w = LB.board(S, 'week', now);
  assert.equal(w.rows[0].name, 'Pat Lee');
  assert.equal(LB.board(S, 'all', now).rows[0].rev, 3400);

  const x = LB.extras(S, now);
  assert.equal(x.first.d.id, '2'); // the owner's 50k deal is off the board
  assert.equal(x.daysLeft, 13);
  assert.ok(x.feed.some(f => f.kind === 'five' && f.who === 'u1'));
});

test('calling streak skips weekends and survives until today’s first call', () => {
  const days = { '2026-11-13': 1, '2026-11-16': 2, '2026-11-17': 1 }; // Fri, Mon, Tue
  assert.equal(LB.streak(days, now), 3);
  assert.equal(LB.streak({ ...days, '2026-11-18': 1 }, now), 4);
  assert.equal(LB.streak({ '2026-11-12': 1 }, now), 0);
});

test('trend and activity-vs-results profiles', () => {
  const S = {
    cfg, users: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    deals: [{ id: 'x', owner: 'b', stage: 'Won', amount: 5000, wonAt: at(10, 17) }],
    acts: Array.from({ length: 6 }, (_, i) => ({ owner: 'a', type: 'Call', done: true, dt: dt(10, 9 + i) })),
  };
  const t = LB.trend(S, 'b', now, 8);
  assert.equal(t.length, 8); assert.equal(t[7].rev, 5000); assert.equal(t[6].rev, 0);
  const p = LB.profiles(S, now).rows;
  assert.equal(p.find(r => r.id === 'a').tag, 'Grinding, not closing');
  assert.equal(p.find(r => r.id === 'b').tag, 'Closing without grinding');
  assert.equal(p.find(r => r.id === 'c').tag, 'No activity yet');
});

test('stampWonAt: new wins get stamped, old stamps survive stale saves, leaving won clears it', () => {
  const before = { deals: [
    { id: 'move', stage: 'Proposal' },
    { id: 'kept', stage: 'Won', wonAt: 'T1' },
    { id: 'old', stage: 'Won' },
    { id: 'back', stage: 'Won', wonAt: 'T2' },
  ] };
  const after = { cfg, deals: [
    { id: 'move', stage: 'Won' },
    { id: 'kept', stage: 'Won' },                 // stale browser copy without the stamp
    { id: 'old', stage: 'Won', wonAt: 'bogus' },  // won before stamps existed: no fake date
    { id: 'back', stage: 'Proposal', wonAt: 'T2' },
    { id: 'new', stage: 'Won' },
  ] };
  stampWonAt(before, after, 'NOW');
  const by = Object.fromEntries(after.deals.map(d => [d.id, d.wonAt]));
  assert.deepEqual(by, { move: 'NOW', kept: 'T1', old: undefined, back: undefined, new: 'NOW' });
  stampWonAt(null, null);
});

test('commission defaults to 12% when no rate is set', () => {
  const S = { cfg, users: [{ id: 'u', name: 'U' }], deals: [{ id: 'd', owner: 'u', stage: 'Won', amount: 1000, wonAt: at(10, 17) }] };
  assert.equal(LB.board(S, 'month', now).rows[0].comm, 120);
});
