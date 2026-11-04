const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { requireAuth } = require('./auth');

const AUDIENCE = 'scg-insights';
const SCOPE = 'reports:read';
const SESSION_SECONDS = 3600;
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;

function passwordVersion(hash) {
  return crypto.createHash('sha256').update(hash).digest('hex');
}

function rows(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
}

// Report current ownership and state. Existing records do not reliably contain
// completion/close timestamps, so these totals must not be presented as period activity.
function buildReport(data, now = new Date()) {
  data = data && typeof data === 'object' ? data : {};
  const stages = Array.isArray(data.cfg?.stages) ? data.cfg.stages : [];
  const won = stages.at(-2) || 'Closed Won';
  const lost = stages.at(-1) || 'Closed Lost';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const people = new Map();
  function person(id, name, role) {
    const key = id == null ? '' : String(id);
    if (!people.has(key)) {
      people.set(key, {
        id: key, name: name || (key ? 'Former or unknown user (' + key + ')' : 'Unassigned'), role: role || '',
        leads: 0, openDeals: 0, pipeline: 0, wonDeals: 0, wonValue: 0, lostDeals: 0,
        openTasks: 0, doneTasks: 0, overdueTasks: 0, openDeliverables: 0,
        openActivities: 0, doneActivities: 0, doneCalls: 0,
      });
    }
    return people.get(key);
  }
  for (const user of rows(data.users)) person(user.id, user.name, user.role);
  for (const lead of rows(data.leads)) person(lead.owner).leads++;
  for (const deal of rows(data.deals)) {
    const user = person(deal.owner);
    const amount = Number(deal.amount);
    const value = Number.isFinite(amount) ? amount : 0;
    if (deal.stage === won) { user.wonDeals++; user.wonValue += value; }
    else if (deal.stage === lost) user.lostDeals++;
    else { user.openDeals++; user.pipeline += value; }
  }
  for (const task of rows(data.tasks)) {
    const user = person(task.owner);
    if (task.done) user.doneTasks++;
    else {
      user.openTasks++;
      if (typeof task.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.due) && task.due < today) user.overdueTasks++;
    }
  }
  for (const delivery of rows(data.deliv)) {
    if (!delivery.done) person(delivery.owner).openDeliverables++;
  }
  for (const activity of rows(data.acts)) {
    const user = person(activity.owner);
    if (activity.done) {
      user.doneActivities++;
      if (activity.type === 'Call') user.doneCalls++;
    } else user.openActivities++;
  }
  return {
    schemaVersion: 1, generatedAt: now.toISOString(), timeZone: 'America/Denver',
    basis: 'Current record ownership and status',
    users: [...people.values()],
  };
}

function sendSession(res, account) {
  const token = jwt.sign({
    accountId: account.id, scope: SCOPE, passwordVersion: passwordVersion(account.password_hash),
  }, process.env.JWT_SECRET, { audience: AUDIENCE, issuer: 'summit-crm', expiresIn: SESSION_SECONDS, algorithm: 'HS256' });
  res.json({ token, expiresIn: SESSION_SECONDS, username: account.username });
}

function mount(app) {
  app.use('/api/reporting', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.post('/api/reporting/session', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' ||
        !username.trim() || username.length > 200 || !password || password.length > 1024) {
      return res.status(400).json({ error: 'Enter your CRM username and password.' });
    }
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    const key = username.toLowerCase().trim();
    const attempt = attempts.get(key) || { count: 0, until: now + WINDOW_MS };
    if (attempt.count >= 10 || (!attempts.has(key) && attempts.size >= 10000)) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    }
    attempt.count++;
    attempts.set(key, attempt);
    try {
      const { rows: accounts } = await pool.query('SELECT id, username, password_hash, active, is_admin FROM accounts WHERE username = $1', [key]);
      const account = accounts[0];
      if (!account || account.active === false || !account.is_admin || !await bcrypt.compare(password, account.password_hash)) {
        return res.status(401).json({ error: 'Sign in with an active CRM administrator account.' });
      }
      attempts.delete(key);
      sendSession(res, account);
    } catch (error) {
      console.error('Reporting sign-in failed:', error.message);
      res.status(500).json({ error: 'CRM reporting is temporarily unavailable.' });
    }
  });
  app.post('/api/reporting/session/crm', requireAuth, async (req, res) => {
    try {
      const { rows: accounts } = await pool.query(
        'SELECT id, username, password_hash, active, is_admin FROM accounts WHERE id = $1',
        [req.account.accountId]
      );
      const account = accounts[0];
      if (!account || !account.active || !account.is_admin) {
        return res.status(403).json({ error: 'Reporting access requires an active CRM administrator account.' });
      }
      sendSession(res, account);
    } catch (error) {
      console.error('CRM reporting session failed:', error.message);
      res.status(500).json({ error: 'CRM reporting is temporarily unavailable.' });
    }
  });
  app.get('/api/reporting/users', async (req, res) => {
    const header = req.headers.authorization || '';
    let payload;
    try {
      payload = jwt.verify(header.startsWith('Bearer ') ? header.slice(7) : '', process.env.JWT_SECRET, {
        audience: AUDIENCE, issuer: 'summit-crm', algorithms: ['HS256'],
      });
      if (payload.scope !== SCOPE) throw Error('Wrong scope');
    } catch {
      return res.status(401).json({ error: 'Your reporting session has expired. Sign in again.' });
    }
    try {
      const { rows: accounts } = await pool.query('SELECT active, is_admin, password_hash FROM accounts WHERE id = $1', [payload.accountId]);
      const account = accounts[0];
      if (!account || account.active === false || !account.is_admin || passwordVersion(account.password_hash) !== payload.passwordVersion) {
        return res.status(403).json({ error: 'Reporting access requires an active CRM administrator account.' });
      }
      const { rows: snapshots } = await pool.query('SELECT data, updated_at FROM crm_data WHERE id = 1');
      const snapshot = snapshots[0];
      res.json({ ...buildReport(snapshot?.data), dataUpdatedAt: snapshot?.updated_at || null });
    } catch (error) {
      console.error('Reporting read failed:', error.message);
      res.status(500).json({ error: 'Could not read CRM reports. Try again.' });
    }
  });
}

module.exports = { mount, buildReport };
