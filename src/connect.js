// SCG Connect integration. Connect looks up leads/deals with a shared key
// (CONNECT_KEY), and the CRM tells Connect when a deal is won so it can be
// announced in the Wins channel (CONNECT_URL + the same key).
const crypto = require('crypto');
const { pool } = require('./db');

const stagesOf = data => data.cfg?.stages || ['Qualification', 'Audit & Discovery', 'Proposal / Pitch', 'Negotiation', 'Closed Won', 'Closed Lost'];
const wonStage = data => stagesOf(data).at(-2);
const lostStage = data => stagesOf(data).at(-1);
const norm = s => String(s || '').toLowerCase();

function requireKey(req, res, next) {
  const key = process.env.CONNECT_KEY;
  const given = String(req.headers['x-integration-key'] || '');
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return res.status(401).json({ error: 'Bad integration key' });
  }
  next();
}

function ownerName(data, id) {
  return (data.users || []).find(u => u.id === id)?.name || '';
}

function dealCard(data, d) {
  const stages = stagesOf(data);
  return {
    type: 'deal', id: d.id, name: d.name || '', account: d.account || '', amount: Number(d.amount) || 0,
    stage: d.stage || '', stage_index: stages.indexOf(d.stage), stage_count: stages.length - 2,
    won: d.stage === wonStage(data), lost: d.stage === lostStage(data),
    close: d.close || '', owner: ownerName(data, d.owner), services: d.services || [],
  };
}

function leadCard(data, l) {
  return {
    type: 'lead', id: l.id, name: l.company || l.contact || '', contact: l.contact || '', phone: l.phone || '',
    email: l.email || '', status: l.disposition || '', value: Number(l.value) || 0, source: l.source || '',
    owner: ownerName(data, l.owner), services: l.services || [],
  };
}

async function readData() {
  const { rows } = await pool.query('SELECT data FROM crm_data WHERE id = 1');
  return rows[0]?.data || {};
}

const safe = fn => (req, res) => fn(req, res).catch(e => {
  console.error('connect integration', e);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
});

function mount(app) {
  // ?q=acme&type=deal|lead -> up to 10 matches, newest first
  app.get('/api/integrations/connect/search', requireKey, safe(async (req, res) => {
    const data = await readData();
    const q = norm(req.query.q).trim();
    const type = req.query.type;
    const out = [];
    if (type !== 'lead') {
      for (const d of data.deals || []) {
        if (!q || norm(d.name).includes(q) || norm(d.account).includes(q)) out.push(dealCard(data, d));
      }
    }
    if (type !== 'deal') {
      for (const l of data.leads || []) {
        if (!q || norm(l.company).includes(q) || norm(l.contact).includes(q)) out.push(leadCard(data, l));
      }
    }
    res.json(out.slice(0, 10));
  }));

  app.get('/api/integrations/connect/record/:type/:id', requireKey, safe(async (req, res) => {
    const data = await readData();
    const list = req.params.type === 'deal' ? data.deals : req.params.type === 'lead' ? data.leads : null;
    const rec = (list || []).find(r => String(r.id) === req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json(req.params.type === 'deal' ? dealCard(data, rec) : leadCard(data, rec));
  }));
}

// Called after every save: any deal that just moved into the won stage gets announced.
function announceWins(before, after) {
  const url = process.env.CONNECT_URL, key = process.env.CONNECT_KEY;
  if (!url || !key || !after) return;
  const won = wonStage(after);
  const prev = new Map((before?.deals || []).map(d => [d.id, d.stage]));
  const fresh = (after.deals || []).filter(d => d.stage === won && prev.has(d.id) && prev.get(d.id) !== won);
  for (const d of fresh) {
    fetch(`${url.replace(/\/$/, '')}/api/integrations/crm/deal-won`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-integration-key': key },
      body: JSON.stringify(dealCard(after, d)),
      signal: AbortSignal.timeout(8000),
    }).catch(e => console.error('Could not tell Connect about a won deal:', e.message));
  }
}

module.exports = { mount, announceWins, dealCard, leadCard };
