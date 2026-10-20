const jwt = require('jsonwebtoken');

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

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.account = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.account || !req.account.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { signToken, requireAuth, requireAdmin };
