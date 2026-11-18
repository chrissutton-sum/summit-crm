// Records when each deal entered the won stage (deal.wonAt), so the leaderboard
// can count closes by week and month. Runs on every PUT /api/data. Browsers save
// whole sections from a possibly stale copy, so the saved copy is trusted only
// for the stage: an existing wonAt is kept from the database, a deal that just
// moved into won is stamped now, and a deal that left won loses its stamp.
// Deals already won before this existed keep no stamp (the leaderboard falls
// back to the client record's created date for those).
function stampWonAt(before, after, now = new Date().toISOString()) {
  if (!after || !Array.isArray(after.deals)) return;
  const stages = after.cfg?.stages || [];
  const won = stages[stages.length - 2];
  const prev = new Map((before?.deals || []).map(d => [d.id, d]));
  for (const d of after.deals) {
    if (!d || typeof d !== 'object') continue;
    if (d.stage !== won) { delete d.wonAt; continue }
    const p = prev.get(d.id);
    if (p && p.stage === won) { if (p.wonAt) d.wonAt = p.wonAt; else delete d.wonAt }
    else d.wonAt = d.wonAt || now;
  }
}
module.exports = { stampWonAt };
