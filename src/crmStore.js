// Server-side reads/writes of the shared CRM document, for the AI connector.
const { pool } = require('./db');

async function readData() {
  const { rows } = await pool.query('SELECT data FROM crm_data WHERE id = 1');
  return rows[0]?.data || {};
}

// Row-locks the document so connector writes can't clobber a browser save in flight.
async function mutate(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM crm_data WHERE id = 1 FOR UPDATE');
    const data = rows[0].data;
    const before = { deals: (data.deals || []).map(d => ({ id: d.id, stage: d.stage })) };
    const result = fn(data);
    await client.query('UPDATE crm_data SET data = $1, updated_at = now() WHERE id = 1', [data]);
    await client.query('COMMIT');
    require('./connect').announceWins(before, data);
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Browsers save whole sections of the CRM at once, from whatever copy they
// had loaded. A tab that loaded just before an AI edit (or has an edit form
// open) would otherwise put the old version back on its next save.
// Records the connector touched carry aiAt; for 15 minutes the server keeps
// the connector's version unless the incoming copy already has it.
const KEEP_MS = 15 * 60 * 1000;
const GUARDED = ['leads', 'deals', 'contacts', 'accts', 'log'];

function keepRecentAiEdits(current, incoming) {
  if (!current || !incoming) return incoming;
  const now = Date.now();
  for (const key of GUARDED) {
    const cur = current[key], inc = incoming[key];
    if (!Array.isArray(cur) || !Array.isArray(inc)) continue;
    const recent = cur.filter(r => r?.aiAt && now - Date.parse(r.aiAt) < KEEP_MS);
    if (!recent.length) continue;
    const pos = new Map(inc.map((r, i) => [r?.id, i]));
    const missing = [];
    for (const r of recent) {
      if (!pos.has(r.id)) { if (r.aiNew) missing.push(r); }
      else if (inc[pos.get(r.id)].aiAt !== r.aiAt) inc[pos.get(r.id)] = r;
    }
    if (missing.length) {
      incoming[key] = [...missing, ...inc];
      if (key === 'log') incoming.log.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    }
  }
  return incoming;
}

module.exports = { readData, mutate, keepRecentAiEdits };
