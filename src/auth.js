const jwt = require('jsonwebtoken');
const { pool } = require('./db');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Set it to a long random string.');
  process.exit(1);
}

const SECRET = process.env.JWT_SECRET;

function signToken(account) {
  return jwt.sign(
    { accountId: account.id, username: account.username, userId: account.user_id, isAdmin: account.is_admin },
    SECRET,
    { expiresIn: '30d' }
  );
}

// Deactivating a user needs to take effect immediately — not just block the
// next login — so this checks the accounts table's `active` flag on every
// request, not only at sign-in. A token that already exists for a
// deactivated account is rejected here even though the JWT itself is still
// cryptographically valid.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const { rows } = await pool.query('SELECT active FROM accounts WHERE id = $1', [payload.accountId]);
    if (!rows[0] || rows[0].active === false) {
      return res.status(403).json({ error: 'This login has been deactivated.' });
    }
  } catch (e) {
    console.error('requireAuth: could not verify account is active', e);
    return res.status(500).json({ error: 'Could not verify account' });
  }
  req.account = payload;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.account || !req.account.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { signToken, requireAuth, requireAdmin };
