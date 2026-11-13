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
const leadFinder = require('./leadFinder');
const connect = require('./connect');
const { keepRecentTransfers } = leadFinder;
const oauth = require('./oauth');
const mcp = require('./mcp');
const push = require('./push');
const { keepRecentAiEdits } = require('./crmStore');

const app = express();
// Render sits behind a proxy; needed for correct client IPs and https URLs
app.set('trust proxy', 1);
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
  if (account.active === false) return res.status(403).json({ error: 'This login has been deactivated. Ask an admin to reactivate it.' });
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

// Admins temporarily deactivate/reactivate a login. A deactivated login is
// blocked immediately (requireAuth checks this on every request, not just at
// sign-in) and is blocked from signing back in until reactivated. The
// underlying account and its data are untouched either way.
app.patch('/api/accounts/active', requireAuth, requireAdmin, async (req, res) => {
  const { userId, active } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (req.account.userId === userId && !active) {
    return res.status(400).json({ error: "You can't deactivate your own login." });
  }
  const { rows } = await pool.query(
    'UPDATE accounts SET active = $1 WHERE user_id = $2 RETURNING user_id',
    [!!active, userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'That user has no login to deactivate.' });
  res.json({ ok: true });
});

// Admins remove a login entirely (e.g. when removing a team member).
app.delete('/api/accounts/:userId', requireAuth, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM accounts WHERE user_id = $1', [req.params.userId]);
  res.json({ ok: true });
});

app.get('/api/accounts', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT username, user_id, is_admin, active, created_at FROM accounts ORDER BY created_at');
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM crm_data WHERE id = 1 FOR UPDATE');
    keepRecentTransfers(rows[0]?.data, data);
    keepRecentAiEdits(rows[0]?.data, data);
    await client.query('UPDATE crm_data SET data = $1, updated_at = now() WHERE id = 1', [data]);
    await client.query('COMMIT');
    connect.announceWins(rows[0]?.data, data);
    push.notifyChanges(rows[0]?.data, data);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Save failed', e);
    return res.status(500).json({ error: 'Save failed' });
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

// Read-only snapshot of the blob, for background jobs that only need to look
// (push.js's periodic checks, google.js's Gmail-reply scan).
async function getData() {
  const { rows } = await pool.query('SELECT data FROM crm_data WHERE id = 1');
  return rows[0]?.data || {};
}

// Same FOR-UPDATE read-modify-write pattern as PUT /api/data above, for
// background jobs that need to write (currently just google.js logging a
// Gmail reply onto a lead). mutator gets the locked blob to edit in place;
// its return value is ignored — whatever it mutated is what gets saved.
async function mutateData(mutator) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data FROM crm_data WHERE id = 1 FOR UPDATE');
    const data = rows[0]?.data || {};
    await mutator(data);
    await client.query('UPDATE crm_data SET data = $1, updated_at = now() WHERE id = 1', [data]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Background data update failed', e);
  } finally {
    client.release();
  }
}

// One-time migration: make sure "Not Interested" exists as a lead status on
// deployments from before it was added, so existing data gets the new
// disposition's folder (folders are generated straight from cfg.disps — see
// vLeads() in public/index.html) and closed-lead handling (isLeadOpen/
// leadOpen) without anyone having to paste it into Settings → Lists by
// hand. Safe to run every boot — a no-op once the status is present.
async function ensureNotInterestedDisp() {
  const data = await getData();
  const disps = data.cfg?.disps;
  if (!Array.isArray(disps) || disps.includes('Not Interested')) return;
  await mutateData(d => {
    const list = d.cfg?.disps;
    if (!Array.isArray(list) || list.includes('Not Interested')) return;
    const lostIdx = list.indexOf('Lost');
    list.splice(lostIdx >= 0 ? lostIdx : list.length, 0, 'Not Interested');
  });
  console.log('[migrate] Added "Not Interested" lead status');
}

leadFinder.mount(app);
connect.mount(app);
oauth.mount(app);
mcp.mount(app);
push.mount(app);
require('./reporting').mount(app);

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

// Two-way email logging: actually sends through the signed-in user's own
// Gmail (reusing the same Google connection as the calendar sign-in above,
// now also scoped for gmail.send/readonly) rather than just opening a
// mailto link, so the client can log it as sent rather than "maybe sent".
// The client itself writes the S.log entry and the lead's gmailThreadId via
// the normal PUT /api/data save right after this succeeds — this endpoint
// only talks to Gmail, it doesn't touch crm_data.
app.post('/api/gmail/send', requireAuth, async (req, res) => {
  if (!google.configured()) return res.status(501).json({ error: 'Google sign-in is not set up yet' });
  const { to, subject, body } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: 'to and subject required' });
  try {
    const result = await google.sendEmail(req.account.userId, { to, subject, body: body || '' });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e && e.message) || 'Send failed' });
  }
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

app.get('/download', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'download.html')));

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

init()
  .then(() => google.initTable())
  .then(() => docusign.initTable())
  .then(() => oauth.initTables())
  .then(() => push.initTable())
  .then(() => ensureNotInterestedDisp())
  .then(() => {
    app.listen(PORT, () => console.log(`Summit CRM server listening on :${PORT}`));
    push.startPeriodicChecks(getData);
    // Separate, more frequent timer for Gmail reply logging — a reply
    // sitting unlogged for up to an hour (push.js's cadence) would make the
    // "two-way" part feel broken, so this checks every 5 minutes instead.
    // No-ops instantly whenever Google sign-in isn't configured at all.
    setInterval(() => {
      if (!google.configured()) return;
      google.syncGmailReplies(getData, mutateData, push.sendToUsers).catch(e => console.error('[gmail sync] failed:', e.message));
    }, 5 * 60 * 1000);
  })
  .catch((e) => {
    console.error('Failed to initialize database', e);
    process.exit(1);
  });
