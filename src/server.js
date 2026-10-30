const path = require('path');
const dns = require('dns').promises;
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { pool, init } = require('./db');
const { signToken, requireAuth, requireAdmin } = require('./auth');
const { fetchAndParseICS } = require('./ics');
const google = require('./google');
const docusign = require('./docusign');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;

// ---- Auth ----
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const { rows } = await pool.query('SELECT * FROM accounts WHERE username = $1', [username.toLowerCase().trim()]);
  const account = rows[0];
  if (!account) return res.status(401).json({ error: 'Invalid username or password' });
  const ok = await bcrypt.compare(password, account.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({
    token: signToken(account),
    username: account.username,
    userId: account.user_id,
    isAdmin: account.is_admin,
  });
});

app.post('/api/me/password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const { rows } = await pool.query('SELECT * FROM accounts WHERE id = $1', [req.account.accountId]);
  const account = rows[0];
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const ok = await bcrypt.compare(oldPassword, account.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is wrong' });
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [hash, account.id]);
  res.json({ ok: true });
});

// Admins create a login for a new (or existing) team member.
app.post('/api/accounts', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, userId, isAdmin } = req.body || {};
  if (!username || !password || !userId) return res.status(400).json({ error: 'username, password and userId required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      'INSERT INTO accounts (username, password_hash, user_id, is_admin) VALUES ($1, $2, $3, $4)',
      [username.toLowerCase().trim(), hash, userId, !!isAdmin]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is already taken' });
    console.error(e);
    res.status(500).json({ error: 'Could not create account' });
  }
});

// Admins promote/demote an existing login's admin flag (e.g. after changing a
// team member's role in Settings). No-ops quietly if that user has no login yet.
app.patch('/api/accounts/admin', requireAuth, requireAdmin, async (req, res) => {
  const { userId, isAdmin } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await pool.query('UPDATE accounts SET is_admin = $1 WHERE user_id = $2', [!!isAdmin, userId]);
  res.json({ ok: true });
});

// Admins remove a login entirely (e.g. when removing a team member).
app.delete('/api/accounts/:userId', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [req.params.userId]);
  res.json({ ok: true });
});

app.get('/api/accounts', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT username, user_id, is_admin, created_at FROM accounts ORDER BY created_at');
  res.json(rows);
});

// ---- CRM data (single shared JSON blob, same shape the old claude.ai db doc used) ----
app.get('/api/data', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT data FROM crm_data WHERE id = 1');
  res.json(rows[0] ? rows[0].data : {});
});

app.put('/api/data', requireAuth, async (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Invalid payload' });
  await pool.query('UPDATE crm_data SET data = $1, updated_at = now() WHERE id = 1', [data]);
  res.json({ ok: true });
});

// ---- Calendar sync: each team member can paste their calendar's private
// iCal (.ics) feed URL (Google Calendar → Settings → "Secret address in
// iCal format"; Outlook/Apple have similar "Subscribe"/public ics links).
// We fetch+parse that feed server-side (so the browser never hits CORS, and
// the URL itself — which usually contains a secret token — never has to be
// embedded in frontend code) and hand back plain events for the Shared
// Calendar view. ----
function isBlockedHost(hostname, ip) {
  const h = (hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (!ip) return false;
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
  const [a, b] = parts;
  return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const feedCache = new Map(); // url -> { at, events, error }
const FEED_TTL_MS = 10 * 60 * 1000;

app.get('/api/calendar-feed', requireAuth, async (req, res) => {
  const raw = (req.query.url || '').toString().trim();
  if (!raw) return res.status(400).json({ error: 'url required' });
  let parsed;
  try { parsed = new URL(raw); } catch (e) { return res.status(400).json({ error: 'Not a valid URL' }); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'Calendar URL must be http(s)' });

  const cached = feedCache.get(raw);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) {
    if (cached.error) return res.status(502).json({ error: cached.error });
    return res.json({ events: cached.events, cached: true });
  }

  try {
    let addr;
    try {
      const lookup = await dns.lookup(parsed.hostname);
      addr = lookup.address;
    } catch (e) {
      throw new Error('Could not resolve that calendar host');
    }
    if (isBlockedHost(parsed.hostname, addr)) throw new Error('That calendar URL points at a blocked address');

    const now = Date.now();
    const windowStart = now - 7 * 86400000;
    const windowEnd = now + 60 * 86400000;
    const events = await fetchAndParseICS(raw, windowStart, windowEnd);
    feedCache.set(raw, { at: Date.now(), events, error: null });
    res.json({ events, cached: false });
  } catch (e) {
    const msg = e && e.message ? e.message : 'Could not load that calendar';
    feedCache.set(raw, { at: Date.now(), events: [], error: msg });
    res.status(502).json({ error: msg });
  }
});

// ---- Google Calendar sign-in (OAuth) ----
// Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI env
// vars, set up once in Google Cloud Console. Until configured, these routes
// report that plainly rather than erroring, so the frontend can show a clear
// "not set up yet" state instead of a broken button.
app.get('/api/google/auth-url', requireAuth, (req, res) => {
  if (!google.configured()) return res.status(501).json({ error: 'Google sign-in is not set up yet' });
  res.json({ url: google.buildAuthUrl(req.account.userId) });
});

app.get('/api/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?gcal=error&msg=' + encodeURIComponent(String(error)));
  try {
    if (!google.configured()) throw new Error('Google sign-in is not set up yet');
    const userId = google.verifyState(String(state || ''));
    await google.connect(userId, String(code || ''));
    res.redirect('/?gcal=ok');
  } catch (e) {
    res.redirect('/?gcal=error&msg=' + encodeURIComponent((e && e.message) || 'Could not connect Google Calendar'));
  }
});

app.post('/api/google/disconnect', requireAuth, async (req, res) => {
  await google.disconnect(req.account.userId);
  res.json({ ok: true });
});

app.get('/api/google/status-all', requireAuth, async (req, res) => {
  res.json({ configured: google.configured(), connected: await google.statusAll() });
});

const gcalCache = new Map(); // userId -> { at, events, error }
app.get('/api/calendar-feed/google', requireAuth, async (req, res) => {
  const ownerId = String(req.query.ownerId || '');
  if (!ownerId) return res.status(400).json({ error: 'ownerId required' });
  const cached = gcalCache.get(ownerId);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) {
    if (cached.error) return res.status(502).json({ error: cached.error });
    return res.json({ events: cached.events, cached: true });
  }
  try {
    const now = Date.now();
    const events = await google.fetchEvents(ownerId, now - 7 * 86400000, now + 60 * 86400000);
    gcalCache.set(ownerId, { at: Date.now(), events, error: null });
    res.json({ events, cached: false });
  } catch (e) {
    const msg = (e && e.message) || 'Could not load this calendar';
    gcalCache.set(ownerId, { at: Date.now(), events: [], error: msg });
    res.status(502).json({ error: msg });
  }
});

// ---- DocuSign e-signature (one shared company account, connected once by an
// admin from Settings; any team member can then send a proposal for
// signature from the CRM). ----
app.get('/api/docusign/auth-url', requireAuth, requireAdmin, (req, res) => {
  if (!docusign.configured()) return res.status(501).json({ error: 'DocuSign is not set up yet' });
  res.json({ url: docusign.buildAuthUrl() });
});

app.get('/api/docusign/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?ds=error&msg=' + encodeURIComponent(String(error)));
  try {
    if (!docusign.configured()) throw new Error('DocuSign is not set up yet');
    docusign.verifyState(String(state || ''));
    await docusign.connect(String(code || ''));
    res.redirect('/?ds=ok');
  } catch (e) {
    res.redirect('/?ds=error&msg=' + encodeURIComponent((e && e.message) || 'Could not connect DocuSign'));
  }
});

app.post('/api/docusign/disconnect', requireAuth, requireAdmin, async (req, res) => {
  await docusign.disconnect();
  res.json({ ok: true });
});

app.get('/api/docusign/status', requireAuth, async (req, res) => {
  res.json({ configured: docusign.configured(), ...(await docusign.status()) });
});

app.post('/api/docusign/send', requireAuth, async (req, res) => {
  const { proposal, recipientEmail, recipientName } = req.body || {};
  if (!proposal) return res.status(400).json({ error: 'proposal required' });
  try {
    const result = await docusign.sendForSignature(proposal, recipientEmail, recipientName);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || 'Could not send for signature' });
  }
});

app.get('/api/docusign/envelope/:id', requireAuth, async (req, res) => {
  try {
    res.json(await docusign.getEnvelopeStatus(req.params.id));
  } catch (e) {
    res.status(502).json({ error: (e && e.message) || 'Could not check envelope status' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// One-off: reassign Rachel Bowers' leads to Chris Sutton. Idempotent (only
// moves leads still owned by Rachel, so a second boot is a harmless no-op).
// Remove this block once confirmed via the deploy logs.
async function migrateRachelLeadsToChris() {
  const { rows } = await pool.query('SELECT data FROM crm_data WHERE id = 1');
  const data = rows[0] ? rows[0].data : null;
  if (!data) return;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const rachel = (data.users || []).find((u) => norm(u.name).includes('rachelbowers'));
  const chris = (data.users || []).find((u) => norm(u.name).includes('chrissutton'));
  if (!rachel || !chris) {
    console.log('MIGRATE rachel->chris: could not find both users', {
      rachelFound: !!rachel,
      chrisFound: !!chris,
      allUsers: (data.users || []).map((u) => ({ id: u.id, name: u.name })),
    });
    return;
  }
  const leads = data.leads || [];
  let moved = 0;
  leads.forEach((l) => {
    if (l.owner === rachel.id) {
      l.owner = chris.id;
      moved += 1;
    }
  });
  if (moved > 0) {
    await pool.query('UPDATE crm_data SET data = $1, updated_at = now() WHERE id = 1', [data]);
  }
  console.log(`MIGRATE rachel->chris: moved ${moved} lead(s) from ${rachel.name} (${rachel.id}) to ${chris.name} (${chris.id})`);
}

init()
  .then(() => google.initTable())
  .then(() => docusign.initTable())
  .then(() => migrateRachelLeadsToChris())
  .then(() => {
    app.listen(PORT, () => console.log(`Summit CRM server listening on :${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize database', e);
    process.exit(1);
  });
