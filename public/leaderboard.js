// Leaderboard math for the 🏆 tab. Pure functions over the CRM document, so the
// page (window.LB) and the tests (require) share one copy. All windows are in
// the viewer's local time.
(function (root) {
const DAY = 864e5;
const WON = S => S.cfg.stages[S.cfg.stages.length - 2];
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const num = n => Number(n) || 0;
const WINDOWS = [['week', 'This week'], ['month', 'This month'], ['quarter', 'Quarter'], ['all', 'All-time']];

function winStart(win, now) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  if (win === 'week') { d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d } // weeks start Monday
  if (win === 'month') { d.setDate(1); return d }
  if (win === 'quarter') { d.setDate(1); d.setMonth(d.getMonth() - d.getMonth() % 3); return d }
  return new Date(0);
}
function winEnd(win, now) {
  const d = winStart(win, now);
  if (win === 'week') d.setDate(d.getDate() + 7);
  else if (win === 'month') d.setMonth(d.getMonth() + 1);
  else if (win === 'quarter') d.setMonth(d.getMonth() + 3);
  else return new Date(8.64e15);
  return d;
}

// When a deal was won. Deals won before wonAt was recorded fall back to the day
// their client record was created, then the latest "Stage → Won" history entry,
// then the expected close date. A deal not in the won stage has no won date.
function wonDate(S, d) {
  if (d.stage !== WON(S)) return null;
  if (d.wonAt) return new Date(d.wonAt);
  const a = (S.accts || []).find(x => x.dealId === d.id);
  if (a && a.created) return new Date(a.created + 'T12:00');
  const l = (S.log || []).find(x => x.ref === 'D' + d.id && x.text === 'Stage → ' + d.stage);
  if (l) return new Date(l.at);
  return d.close ? new Date(d.close + 'T12:00') : null;
}

const isCall = a => a.done && a.type === 'Call' && a.dt;
const isMtg = a => a.done && a.type === 'Meeting' && a.dt;

// Everything that happened between from (inclusive) and to (exclusive), per user id.
function tally(S, from, to) {
  const t = {}, get = id => t[id] = t[id] || { rev: 0, won: 0, calls: 0, mtgs: 0, leads: 0 };
  const inW = d => d && !isNaN(d) && d >= from && d < to;
  (S.deals || []).forEach(d => { if (inW(wonDate(S, d))) { const u = get(d.owner); u.rev += num(d.amount); u.won++ } });
  (S.acts || []).forEach(a => { const d = new Date(a.dt); if (isCall(a) && inW(d)) get(a.owner).calls++; if (isMtg(a) && inW(d)) get(a.owner).mtgs++ });
  (S.leads || []).forEach(l => { if (l.createdAt && inW(new Date(l.createdAt))) get(l.owner).leads++ });
  return t;
}

// Completed calls per user per local day: { uid: { 'YYYY-MM-DD': n } }
function callDays(S) {
  const m = {};
  (S.acts || []).filter(isCall).forEach(a => { const k = ymd(new Date(a.dt)), u = m[a.owner] = m[a.owner] || {}; u[k] = (u[k] || 0) + 1 });
  return m;
}

// Weekdays in a row with at least one completed call, counting back from today.
// A streak is still alive in the morning before today's first call.
function streak(days, now) {
  const d = new Date(now); d.setHours(12, 0, 0, 0);
  const work = () => { while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1) };
  work();
  if (!days[ymd(d)]) { d.setDate(d.getDate() - 1); work() }
  let n = 0;
  while (days[ymd(d)]) { n++; d.setDate(d.getDate() - 1); work() }
  return n;
}

const players = S => (S.users || []).filter(u => !((S.cfg && S.cfg.lbOut) || []).includes(u.id));
const rate = S => (S.cfg && S.cfg.commission != null ? num(S.cfg.commission) : 15) / 100;

function board(S, win, now) {
  now = now || new Date();
  const from = winStart(win, now), to = winEnd(win, now);
  const t = tally(S, from, to), cd = callDays(S), r = rate(S), fromK = ymd(from), toK = ymd(to);
  const rows = players(S).map(u => {
    const x = t[u.id] || { rev: 0, won: 0, calls: 0, mtgs: 0, leads: 0 }, days = cd[u.id] || {};
    return { id: u.id, name: u.name, ...x, comm: x.rev * r,
      fiveDays: Object.entries(days).filter(([k, n]) => n >= 5 && k >= fromK && (win === 'all' || k < toK)).length,
      streak: streak(days, now) };
  }).sort((a, b) => b.rev - a.rev || b.won - a.won || b.calls - a.calls || a.name.localeCompare(b.name));
  rows.forEach((x, i) => { x.rank = i + 1; x.gap = i ? rows[i - 1].rev - x.rev : 0; x.above = i ? rows[i - 1] : null });
  return { win, from, rows, total: rows.reduce((s, x) => s + x.rev, 0) };
}

// Monthly contest and the badge feed.
function extras(S, now) {
  now = now || new Date();
  const mFrom = winStart('month', now), ids = new Set(players(S).map(u => u.id));
  const wins = (S.deals || []).map(d => ({ d, at: wonDate(S, d) })).filter(x => x.at && !isNaN(x.at) && ids.has(x.d.owner)).sort((a, b) => a.at - b.at);
  const first = wins.find(x => x.at >= mFrom) || null;
  const end = new Date(mFrom); end.setMonth(end.getMonth() + 1);
  const feed = [];
  const since = new Date(+now - 14 * DAY);
  wins.filter(x => x.at >= since).forEach(x => feed.push({ at: x.at, who: x.d.owner, kind: 'win', text: 'Closed ' + (x.d.account || x.d.name), amount: num(x.d.amount) }));
  if (first) feed.push({ at: first.at, who: first.d.owner, kind: 'first', text: 'First close of the month' });
  Object.entries(callDays(S)).forEach(([who, days]) => ids.has(who) && Object.entries(days).forEach(([k, n]) => {
    const at = new Date(Math.min(+new Date(k + 'T18:00'), +now)); if (n >= 5 && at >= since) feed.push({ at, who, kind: 'five', text: n + '-call day' });
  }));
  feed.sort((a, b) => b.at - a.at);
  return { first, daysLeft: Math.max(0, Math.ceil((end - now) / DAY)), feed: feed.slice(0, 8), month: board(S, 'month', now) };
}

// Manager view: last n weeks (oldest first) of revenue and calls for one user,
// plus where they sit against the team on activity vs results this quarter.
function trend(S, id, now, n) {
  now = now || new Date(); n = n || 8;
  const wk = winStart('week', now), out = [];
  for (let i = n - 1; i >= 0; i--) {
    const from = new Date(wk); from.setDate(from.getDate() - 7 * i);
    const to = new Date(from); to.setDate(to.getDate() + 7);
    const x = tally(S, from, to)[id] || { rev: 0, calls: 0 };
    out.push({ from, rev: x.rev, calls: x.calls });
  }
  return out;
}

function profiles(S, now) {
  const b = board(S, 'quarter', now), act = b.rows.filter(x => x.rev || x.calls || x.mtgs);
  const avgC = act.length ? act.reduce((s, x) => s + x.calls, 0) / act.length : 0;
  const avgR = act.length ? act.reduce((s, x) => s + x.rev, 0) / act.length : 0;
  const tag = x => !(x.rev || x.calls || x.mtgs) ? 'No activity yet'
    : x.calls >= avgC ? (x.rev >= avgR ? 'Grinding and closing' : 'Grinding, not closing')
    : (x.rev >= avgR ? 'Closing without grinding' : 'Low on both');
  return { avgC, avgR, rows: b.rows.map(x => ({ ...x, tag: tag(x), cpc: x.won ? x.calls / x.won : null, rpc: x.calls ? x.rev / x.calls : null })) };
}

const LB = { WINDOWS, winStart, winEnd, wonDate, tally, streak, board, extras, trend, profiles, ymd };
if (typeof module !== 'undefined' && module.exports) module.exports = LB; else root.LB = LB;
})(typeof window !== 'undefined' ? window : globalThis);
