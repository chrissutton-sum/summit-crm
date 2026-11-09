// Endpoints for SCG Lead Finder. It authenticates with a shared key
// (LEAD_FINDER_KEY) instead of a user login, so it can check for existing
// leads/clients/contacts and drop new leads in without a person signed in.
const crypto = require('crypto');
const { pool } = require('./db');

const normCompany = s => (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Last 10 digits so "+1 (208) 555-0101" and "208-555-0101" match.
const normPhone = s => (s || '').replace(/\D+/g, '').slice(-10);
const uid = () => Math.random().toString(36).slice(2, 10);

function requireKey(req, res, next) {
  const key = process.env.LEAD_FINDER_KEY;
  const given = req.headers['x-integration-key'] || '';
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) {
    return res.status(401).json({ error: 'Bad integration key' });
  }
  next();
}

// Build lookup maps once per request over leads, clients and contacts.
function buildIndex(data) {
  const users = Object.fromEntries((data.users || []).map(u => [u.id, u.name]));
  const byPhone = new Map();
  const byName = new Map();
  const add = (type, rec, name, phone, status) => {
    const m = { type, id: rec.id, company: name, status: status || '', owner: users[rec.owner] || '' };
    const p = normPhone(phone);
    const n = normCompany(name);
    if (p.length === 10 && !byPhone.has(p)) byPhone.set(p, m);
    if (n && !byName.has(n)) byName.set(n, m);
  };
  // Clients first so a business that's already a client shows as one.
  (data.accts || []).forEach(a => add('client', a, a.name, a.phone, a.status));
  (data.leads || []).forEach(l => add('lead', l, l.company, l.phone, l.disposition));
  (data.contacts || []).forEach(k => add('contact', k, k.company || k.name, k.phone, ''));
  return { byPhone, byName };
}

function findMatch(index, b) {
  const p = normPhone(b.phone);
  return (p.length === 10 && index.byPhone.get(p)) || index.byName.get(normCompany(b.name)) || null;
}

// Express 4 doesn't catch rejected promises; an uncaught one would crash the server.
const safe = fn => (req, res) => fn(req, res).catch(e => {
  console.error('lead-finder', e);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
});

function mount(app) {
  app.get('/api/integrations/lead-finder/users', requireKey, safe(async (req, res) => {
    const { rows } = await pool.query('SELECT data FROM crm_data WHERE id = 1');
    res.json((rows[0]?.data.users || []).map(u => ({ id: u.id, name: u.name })));
  }));

  // { businesses: [{ place_id, name, phone }] } -> { matches: { place_id: match|null } }
  app.post('/api/integrations/lead-finder/match', requireKey, safe(async (req, res) => {
    const list = Array.isArray(req.body?.businesses) ? req.body.businesses : [];
    const { rows } = await pool.query('SELECT data FROM crm_data WHERE id = 1');
    const index = buildIndex(rows[0]?.data || {});
    const matches = {};
    for (const b of list) matches[b.place_id] = findMatch(index, b);
    res.json({ matches });
  }));

  // Adds one lead. Row-locks crm_data so two transfers can't clobber each other.
  app.post('/api/integrations/lead-finder/leads', requireKey, safe(async (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT data FROM crm_data WHERE id = 1 FOR UPDATE');
      const data = rows[0].data;
      data.leads = data.leads || [];
      data.log = data.log || [];

      const existing = findMatch(buildIndex(data), b);
      if (existing) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Already in the CRM', match: existing });
      }

      const users = data.users || [];
      const owner = users.find(u => u.id === b.ownerId) || users[0];
      const notes = [
        `From SCG Lead Finder — ${b.websiteStatus === 'social' ? 'social/listing page only' : 'no website'}.`,
        b.address && `Address: ${b.address}`,
        b.website && `Current link: ${b.website}`,
        b.mapsUrl && `Google Maps: ${b.mapsUrl}`,
        b.notes,
      ].filter(Boolean).join('\n');

      const lead = {
        id: uid(),
        company: b.name,
        contact: '',
        phone: b.phone || '',
        email: '',
        source: 'Cold outreach',
        disposition: data.cfg?.disps?.[0] || 'New Lead',
        value: 0,
        services: [],
        notes,
        owner: owner?.id || '',
        lfPlaceId: b.placeId || '',
        lfAddedAt: new Date().toISOString(),
      };
      data.leads.unshift(lead);
      data.log.unshift({ id: uid(), ref: 'L' + lead.id, text: '🎯 Added from SCG Lead Finder' + (b.by ? ' by ' + b.by : ''), by: 'Lead Finder', at: lead.lfAddedAt });
      data.log = data.log.slice(0, 600);

      await client.query('UPDATE crm_data SET data = $1, updated_at = now() WHERE id = 1', [data]);
      await client.query('COMMIT');
      res.json({ match: { type: 'lead', id: lead.id, company: lead.company, status: lead.disposition, owner: owner?.name || '' } });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('lead-finder transfer failed', e);
      res.status(500).json({ error: 'Could not add the lead' });
    } finally {
      client.release();
    }
  }));
}

// Browsers save the whole CRM blob. A tab that loaded before a Lead Finder
// transfer (e.g. with an edit form open) would drop the new lead on its next
// save. Put back any Lead Finder lead added in the last 15 minutes that the
// incoming save is missing.
const KEEP_MS = 15 * 60 * 1000;
function keepRecentTransfers(current, incoming) {
  if (!Array.isArray(incoming.leads) || !Array.isArray(current?.leads)) return incoming;
  const have = new Set(incoming.leads.map(l => l.id));
  const missing = current.leads.filter(l =>
    l.lfAddedAt && !have.has(l.id) && Date.now() - Date.parse(l.lfAddedAt) < KEEP_MS);
  if (missing.length) incoming.leads = [...missing, ...incoming.leads];
  return incoming;
}

module.exports = { mount, keepRecentTransfers, buildIndex, findMatch };
