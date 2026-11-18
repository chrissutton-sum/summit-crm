// Trophy case. When a month ends, its leaderboard winners are saved for good in
// data.trophies, so later edits to deals or calls can't rewrite history:
//   { months: ['2026-10', ...],            months already handed out
//     awards: [{ month, kind, who, value, prize? }],
//     records: { deal, month, streak: { who, value, month } } }
// kinds: champ (most closed revenue, the monthly contest), first (first close),
// calls (most completed calls), deals (most deals won). Ties share calls/deals.
// The server owns this key; browsers can't write it (keepTrophies).
const LB = require('../public/leaderboard');

const empty = () => ({ months: [], awards: [], records: {} });

// Months that have ended, have activity and haven't been handed out, oldest first.
function pendingMonths(data, now = new Date()) {
  const T = data.trophies || empty(), done = new Set(T.months || []);
  let first = null;
  const see = d => { if (d && !isNaN(d) && (!first || d < first)) first = d };
  (data.deals || []).forEach(d => see(LB.wonDate(data, d)));
  (data.acts || []).forEach(a => a.done && (a.type === 'Call' || a.type === 'Meeting') && a.dt && see(new Date(a.dt)));
  if (!first || !data.cfg?.stages) return [];
  const out = [], cur = LB.monthKey(now), d = new Date(first.getFullYear(), first.getMonth(), 15, 12);
  while (LB.monthKey(d) < cur) { if (!done.has(LB.monthKey(d))) out.push(new Date(d)); d.setMonth(d.getMonth() + 1) }
  return out;
}

// A prize set before months were tracked belongs to the month it was set in.
const needsPrizeMonth = data => !!(data.cfg?.contestPrize && !data.cfg.contestPrizeMonth);

function needsWork(data, now) { return needsPrizeMonth(data) || pendingMonths(data, now).length > 0 }

function awardMonths(data, now = new Date()) {
  if (needsPrizeMonth(data)) data.cfg.contestPrizeMonth = LB.monthKey(now);
  const T = data.trophies = { ...empty(), ...(data.trophies || {}) };
  const R = T.records = { ...(T.records || {}) };
  const ids = new Set(LB.players(data).map(u => u.id)), cd = LB.callDays(data);
  for (const mid of pendingMonths(data, now)) {
    const month = LB.monthKey(mid), B = LB.board(data, 'month', mid), rows = B.rows, end = LB.winEnd('month', mid);
    const add = (kind, who, value, extra) => T.awards.push({ month, kind, who, value, ...extra });
    const top = rows[0];
    if (top && top.rev > 0) {
      add('champ', top.id, top.rev, data.cfg.contestPrizeMonth === month && data.cfg.contestPrize ? { prize: data.cfg.contestPrize } : {});
      if (!R.month || top.rev > R.month.value) R.month = { who: top.id, value: top.rev, month };
    }
    const fc = LB.extras(data, mid).first;
    if (fc) add('first', fc.d.owner, Number(fc.d.amount) || 0, { deal: fc.d.account || fc.d.name || '' });
    for (const [kind, key] of [['calls', 'calls'], ['deals', 'won']]) {
      const best = Math.max(0, ...rows.map(r => r[key]));
      if (best > 0) rows.filter(r => r[key] === best).forEach(r => add(kind, r.id, best));
    }
    for (const d of data.deals || []) {
      const at = LB.wonDate(data, d), amt = Number(d.amount) || 0;
      if (at && at >= LB.winStart('month', mid) && at < end && ids.has(d.owner) && amt > 0 && (!R.deal || amt > R.deal.value))
        R.deal = { who: d.owner, value: amt, month, deal: d.account || d.name || '' };
    }
    const last = LB.ymd(new Date(+end - 1));
    for (const id of ids) {
      const n = LB.longestStreak(cd[id] || {}, last);
      if (n > 1 && (!R.streak || n > R.streak.value)) R.streak = { who: id, value: n, month };
    }
    T.months.push(month);
  }
  return T;
}

// Browsers send the whole document from their own copy; trophies always come from the database.
function keepTrophies(before, after) {
  if (!after || typeof after !== 'object') return;
  if (before && before.trophies) after.trophies = before.trophies; else delete after.trophies;
}

// Hand out any finished months. Reads first so the hourly check is free when there's nothing to do.
async function run(getData, mutate, now) {
  if (!needsWork(await getData(), now)) return false;
  await mutate(data => { if (needsWork(data, now)) awardMonths(data, now) });
  return true;
}

module.exports = { pendingMonths, awardMonths, keepTrophies, run };
