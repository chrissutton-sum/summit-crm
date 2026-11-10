// OAuth 2.1 sign-in for AI connectors (Claude, ChatGPT). They register
// themselves (dynamic client registration), send the person here to sign in
// with their normal CRM username/password, and get a short-lived token that
// only works on /mcp. Tokens are tied to the CRM login: deactivating the
// login or changing its password cuts the connector off immediately.
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { requireAuth } = require('./auth');

const ACCESS_TTL = 3600;
const REFRESH_TTL = 60 * 86400;
const CODE_TTL = 300;
const SCOPE = 'crm';

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = () => crypto.randomBytes(32).toString('base64url');
const pwVersion = hash => sha(hash).slice(0, 16);

// Only these apps can receive sign-in codes, so a look-alike connector can't
// trick someone into handing over CRM access.
const REDIRECT_HOSTS = (process.env.MCP_REDIRECT_HOSTS || 'claude.ai,claude.com,chatgpt.com,platform.openai.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function redirectAllowed(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:' && REDIRECT_HOSTS.includes(u.hostname)) return true;
    // MCP Inspector / local testing only
    return !!process.env.MCP_ALLOW_LOCALHOST && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  } catch { return false; }
}

const baseUrl = req => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const resourceUrl = req => `${baseUrl(req)}/mcp`;

async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL DEFAULT '',
      redirect_uris JSONB NOT NULL,
      secret_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      challenge TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      grant_id TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      pw TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens (grant_id);
  `);
}

// Express 4 doesn't catch rejected promises
const safe = fn => (req, res, next) => fn(req, res, next).catch(e => {
  console.error('oauth', e);
  if (!res.headersSent) res.status(500).json({ error: 'server_error' });
});
const oauthError = (res, status, error, description) => res.status(status).json({ error, error_description: description });

// Simple per-IP lockout for the sign-in page
const failures = new Map();
const LOCK_MS = 15 * 60 * 1000;
function lockedOut(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.first > LOCK_MS) { failures.delete(ip); return false; }
  return f && f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, first: Date.now() };
  f.count++;
  failures.set(ip, f);
}

async function issueTokens(clientId, accountId, pw, grantId = rand()) {
  const access = rand(), refresh = rand();
  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, account_id, pw, expires_at) VALUES
       ($1, 'access', $3, $4, $5, $6, now() + make_interval(secs => $7)),
       ($2, 'refresh', $3, $4, $5, $6, now() + make_interval(secs => $8))`,
    [sha(access), sha(refresh), grantId, clientId, accountId, pw, ACCESS_TTL, REFRESH_TTL]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
}

async function getClient(clientId) {
  const { rows: [c] } = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [String(clientId || '')]);
  return c;
}

function clientSecretOk(client, req) {
  if (!client.secret_hash) return true; // public client, PKCE protects it
  let secret = req.body.client_secret;
  const basic = (req.headers.authorization || '').match(/^Basic (.+)$/);
  if (basic) secret = decodeURIComponent(Buffer.from(basic[1], 'base64').toString().split(':').slice(1).join(':'));
  return !!secret && sha(secret) === client.secret_hash;
}

// ---- Sign-in page

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function appLabel(client) {
  const host = (() => { try { return new URL(client.redirect_uris[0]).hostname; } catch { return ''; } })();
  if (/claude\.(ai|com)$/.test(host)) return 'Claude';
  if (/(chatgpt\.com|openai\.com)$/.test(host)) return 'ChatGPT';
  return client.client_name || 'An AI app';
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · SCG CRM</title><style>
:root{--bg:#000b19;--card:#0a2649;--sunk:#000f22;--ink:#e8ebf0;--muted:#9ca8b8;--line:#1c3e68;--accent:#00e0f5;--blue:#0b74b8;--bad:#ef4444;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-top:3px solid var(--blue);border-radius:14px;padding:26px;display:grid;gap:14px}
h1{font-size:21px;margin:0}p{margin:0;color:var(--muted);font-size:14px}ul{margin:0;padding-left:18px;color:var(--muted);font-size:14px}
label{display:grid;gap:4px;font-size:13px;color:var(--muted)}input{font:15px inherit;color:var(--ink);background:var(--sunk);border:1px solid var(--line);border-radius:8px;padding:10px}
.row{display:flex;gap:10px}button{flex:1;font:600 15px inherit;border-radius:8px;padding:10px;cursor:pointer;border:1px solid var(--line);background:var(--sunk);color:var(--ink)}
button.go{background:var(--blue);border-color:var(--accent);color:#fff}.err{color:var(--bad);font-size:14px}b{color:var(--ink)}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function signInPage(client, params, error = '') {
  const app = appLabel(client);
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map(k => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join('');
  return page(`Connect ${app}`, `
    <h1>Connect ${esc(app)} to SCG CRM</h1>
    <p>Sign in with your CRM login. ${esc(app)} will be able to:</p>
    <ul><li>View and search leads, contacts and deals</li><li>Create and edit leads, contacts and deals</li><li>Add notes</li></ul>
    <p>It <b>can't delete anything</b> or see invoices, settings or team logins. Disconnect it anytime from CRM Settings.</p>
    <form method="post" action="/oauth/authorize" style="display:grid;gap:12px">${hidden}
      <label>Username<input name="username" autocomplete="username" required autofocus></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <div class="row"><button type="submit" name="action" value="deny">Cancel</button><button class="go" type="submit" name="action" value="allow">Allow</button></div>
    </form>`);
}

// Checks shared by GET and POST /oauth/authorize. Returns { client } or { error }.
async function checkAuthorizeParams(p) {
  const client = await getClient(p.client_id);
  if (!client) return { error: 'This connector is not registered. Remove it and add it again.' };
  if (!client.redirect_uris.includes(p.redirect_uri) || !redirectAllowed(p.redirect_uri)) return { error: 'This connector’s return address isn’t allowed.' };
  if (p.response_type && p.response_type !== 'code') return { error: 'Unsupported response type.' };
  if (!p.code_challenge || (p.code_challenge_method || 'plain') !== 'S256') return { error: 'This connector must use PKCE (S256).' };
  return { client };
}

function redirectWith(res, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  res.redirect(302, u.toString());
}

function mount(app) {
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
    res.json({
      resource: resourceUrl(req),
      authorization_servers: [baseUrl(req)],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'SCG CRM',
    });
  });

  app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'], (req, res) => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE],
    });
  });

  app.post('/oauth/register', safe(async (req, res) => {
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every(redirectAllowed)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'Only Claude and ChatGPT can connect to this CRM.');
    }
    const method = ['client_secret_post', 'client_secret_basic'].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : 'none';
    const clientId = rand();
    const secret = method === 'none' ? null : rand();
    await pool.query('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, secret_hash) VALUES ($1, $2, $3, $4)',
      [clientId, String(b.client_name || '').slice(0, 100), JSON.stringify(uris), secret && sha(secret)]);
    res.status(201).json({
      client_id: clientId,
      ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: b.client_name || '',
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: SCOPE,
    });
  }));

  app.get('/oauth/authorize', safe(async (req, res) => {
    const { client, error } = await checkAuthorizeParams(req.query);
    if (error) return res.status(400).send(page('Can’t connect', `<h1>Can’t connect</h1><p>${esc(error)}</p>`));
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'");
    res.send(signInPage(client, req.query));
  }));

  app.post('/oauth/authorize', express.urlencoded({ extended: false }), safe(async (req, res) => {
    const p = req.body || {};
    const { client, error } = await checkAuthorizeParams(p);
    if (error) return res.status(400).send(page('Can’t connect', `<h1>Can’t connect</h1><p>${esc(error)}</p>`));
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'");
    if (p.action !== 'allow') return redirectWith(res, p.redirect_uri, { error: 'access_denied', state: p.state });

    if (lockedOut(req.ip)) return res.status(429).send(signInPage(client, p, 'Too many attempts. Try again in 15 minutes.'));
    const { rows: [account] } = await pool.query('SELECT * FROM accounts WHERE username = $1', [String(p.username || '').toLowerCase().trim()]);
    const ok = account && await bcrypt.compare(String(p.password || ''), account.password_hash);
    if (!ok) { recordFailure(req.ip); return res.status(401).send(signInPage(client, p, 'Username or password is incorrect.')); }
    if (account.active === false) return res.status(403).send(signInPage(client, p, 'This login has been deactivated.'));

    const code = rand();
    await pool.query(`INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, challenge, expires_at)
                      VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [sha(code), client.client_id, account.id, p.redirect_uri, p.code_challenge, CODE_TTL]);
    redirectWith(res, p.redirect_uri, { code, state: p.state });
  }));

  app.post('/oauth/token', express.urlencoded({ extended: false }), safe(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    let clientId = b.client_id;
    const basic = (req.headers.authorization || '').match(/^Basic (.+)$/);
    if (!clientId && basic) clientId = decodeURIComponent(Buffer.from(basic[1], 'base64').toString().split(':')[0]);
    const client = await getClient(clientId);
    if (!client || !clientSecretOk(client, req)) return oauthError(res, 401, 'invalid_client', 'Unknown client');

    if (b.grant_type === 'authorization_code') {
      const { rows: [code] } = await pool.query('DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING *', [sha(b.code || '')]);
      if (!code || code.client_id !== client.client_id || code.expires_at < new Date()) return oauthError(res, 400, 'invalid_grant', 'Code is invalid or expired');
      if (b.redirect_uri && b.redirect_uri !== code.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
      const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
      if (challenge !== code.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE check failed');
      const { rows: [account] } = await pool.query('SELECT * FROM accounts WHERE id = $1', [code.account_id]);
      if (!account || account.active === false) return oauthError(res, 400, 'invalid_grant', 'Login is deactivated');
      return res.json(await issueTokens(client.client_id, account.id, pwVersion(account.password_hash)));
    }

    if (b.grant_type === 'refresh_token') {
      // Rotate: each refresh token works once
      const { rows: [old] } = await pool.query(
        `DELETE FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' RETURNING *`, [sha(b.refresh_token || '')]);
      if (!old || old.client_id !== client.client_id || old.expires_at < new Date()) return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
      const { rows: [account] } = await pool.query('SELECT * FROM accounts WHERE id = $1', [old.account_id]);
      if (!account || account.active === false || pwVersion(account.password_hash) !== old.pw) {
        await pool.query('DELETE FROM oauth_tokens WHERE grant_id = $1', [old.grant_id]);
        return oauthError(res, 400, 'invalid_grant', 'Sign in again');
      }
      await pool.query(`DELETE FROM oauth_tokens WHERE grant_id = $1 AND kind = 'access'`, [old.grant_id]);
      return res.json(await issueTokens(client.client_id, account.id, old.pw, old.grant_id));
    }

    oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  }));

  app.post('/oauth/revoke', express.urlencoded({ extended: false }), safe(async (req, res) => {
    const { rows: [t] } = await pool.query('SELECT grant_id FROM oauth_tokens WHERE token_hash = $1', [sha(req.body?.token || '')]);
    if (t) await pool.query('DELETE FROM oauth_tokens WHERE grant_id = $1', [t.grant_id]);
    res.status(200).end();
  }));

  // ---- Connected AI apps, shown in CRM Settings. Admins see everyone's.
  app.get('/api/ai-connections', requireAuth, safe(async (req, res) => {
    const { rows } = await pool.query(`
      SELECT t.grant_id, c.client_name, c.redirect_uris, a.username, a.user_id,
             min(t.created_at) AS connected_at, max(t.last_used_at) AS last_used_at
      FROM oauth_tokens t JOIN oauth_clients c USING (client_id) JOIN accounts a ON a.id = t.account_id
      WHERE t.expires_at > now() AND ($1 OR a.id = $2)
      GROUP BY 1, 2, 3, 4, 5 ORDER BY max(t.last_used_at) DESC NULLS LAST`, [!!req.account.isAdmin, req.account.accountId]);
    res.json(rows.map(r => ({
      id: r.grant_id, app: appLabel(r), username: r.username, userId: r.user_id,
      connectedAt: r.connected_at, lastUsedAt: r.last_used_at,
    })));
  }));

  app.delete('/api/ai-connections/:id', requireAuth, safe(async (req, res) => {
    const { rowCount } = await pool.query(
      'DELETE FROM oauth_tokens WHERE grant_id = $1 AND ($2 OR account_id = $3)', [req.params.id, !!req.account.isAdmin, req.account.accountId]);
    res.json({ ok: rowCount > 0 });
  }));
}

// Guards /mcp. On success sets req.mcp = { account, clientName }.
async function requireMcpAuth(req, res, next) {
  const challenge = () => res.set('WWW-Authenticate',
    `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`);
  const token = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
  if (!token) { challenge(); return res.status(401).json({ error: 'Sign in required' }); }
  try {
    const { rows: [t] } = await pool.query(`
      SELECT t.*, c.client_name, c.redirect_uris, a.username, a.user_id, a.is_admin, a.active, a.password_hash
      FROM oauth_tokens t JOIN oauth_clients c USING (client_id) JOIN accounts a ON a.id = t.account_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > now()`, [sha(token)]);
    if (!t || t.active === false || pwVersion(t.password_hash) !== t.pw) {
      res.set('WWW-Authenticate', `Bearer error="invalid_token", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp"`);
      return res.status(401).json({ error: 'Token is invalid or expired' });
    }
    if (!t.last_used_at || Date.now() - t.last_used_at > 60000) {
      pool.query('UPDATE oauth_tokens SET last_used_at = now() WHERE grant_id = $1', [t.grant_id]).catch(() => {});
    }
    req.mcp = {
      account: { id: t.account_id, username: t.username, userId: t.user_id, isAdmin: t.is_admin },
      clientName: appLabel(t),
    };
    next();
  } catch (e) {
    console.error('mcp auth', e);
    res.status(500).json({ error: 'Could not verify token' });
  }
}

module.exports = { mount, initTables, requireMcpAuth, redirectAllowed };
