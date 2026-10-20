const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { pool, init } = require('./db');
const { signToken, requireAuth, requireAdmin } = require('./auth');

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
  const { username, password, userId } = req.body || {};
  if (!username || !password || !userId) return res.status(400).json({ error: 'username, password and userId required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      'INSERT INTO accounts (username, password_hash, user_id, is_admin) VALUES ($1, $2, $3, $4)',
      [username.toLowerCase().trim(), hash, userId, false]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is already taken' });
    console.error(e);
    res.status(500).json({ error: 'Could not create account' });
  }
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

init()
  .then(() => {
    app.listen(PORT, () => console.log(`Summit CRM server listening on :${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize database', e);
    process.exit(1);
  });
