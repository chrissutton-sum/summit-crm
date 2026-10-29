// DocuSign e-signature integration: one shared company DocuSign account sends
// every envelope, regardless of which team member clicks "Send for Signature"
// in the CRM (the CRM's own audit log — not DocuSign's sender field — is what
// records which teammate triggered it). An admin connects the account once
// from Settings (OAuth Authorization Code Grant); the refresh token is stored
// server-side only, the browser never sees it. Requires DOCUSIGN_INTEGRATION_KEY
// / DOCUSIGN_CLIENT_SECRET / DOCUSIGN_REDIRECT_URI env vars (set up once in
// DocuSign's admin console — see chat for the walkthrough).
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

// DocuSign's sandbox/developer environment — this Integration Key was
// created there (DocuSign auto-enrolls new "Apps and Keys" into a sandbox
// unless you're specifically in a production admin console), and it's also
// what we want for testing before going live anyway. Swap this one host for
// 'https://account.docusign.com' (and nothing else — base_uri for API calls
// is discovered dynamically from the userinfo response either way) once
// ready to switch to the production account and a production Integration Key.
const AUTH_HOST = 'https://account-d.docusign.com';
// Just 'signature' — the 'extended' scope (for a sliding, non-expiring
// refresh token) requires DocuSign to specifically enable it for this
// Integration Key first; requesting it before that happens makes the
// consent screen fail silently (blank page, no error shown). Without it,
// the refresh token is good for 30 days from connecting and does NOT
// renew itself on use, so Settings will need a one-time reconnect roughly
// every 30 days unless DocuSign enables 'extended' for this key later.
const SCOPES = ['signature'];

function configured() {
  return !!(process.env.DOCUSIGN_INTEGRATION_KEY && process.env.DOCUSIGN_CLIENT_SECRET && process.env.DOCUSIGN_REDIRECT_URI);
}

async function initTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docusign_tokens (
      id INTEGER PRIMARY KEY DEFAULT 1,
      email TEXT,
      account_id TEXT,
      base_uri TEXT,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);
}

// Single shared connection, not per-user — state just needs to prove this
// redirect came from an auth-url we issued a few minutes ago (CSRF guard),
// not carry a userId like the per-user Google Calendar flow does.
function buildAuthUrl() {
  const state = jwt.sign({ purpose: 'docusign-connect' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    response_type: 'code',
    scope: SCOPES.join(' '),
    client_id: process.env.DOCUSIGN_INTEGRATION_KEY,
    redirect_uri: process.env.DOCUSIGN_REDIRECT_URI,
    state,
  });
  return `${AUTH_HOST}/oauth/auth?${params.toString()}`;
}

function verifyState(state) {
  const payload = jwt.verify(state, process.env.JWT_SECRET);
  if (payload.purpose !== 'docusign-connect') throw new Error('Bad state');
  return true;
}

async function exchangeCode(code) {
  const basic = Buffer.from(`${process.env.DOCUSIGN_INTEGRATION_KEY}:${process.env.DOCUSIGN_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${AUTH_HOST}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + basic },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'DocuSign token exchange failed');
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function fetchUserInfo(accessToken) {
  const res = await fetch(`${AUTH_HOST}/oauth/userinfo`, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!res.ok) throw new Error('Could not read DocuSign account info');
  const d = await res.json();
  const acct = (d.accounts || []).find(a => a.is_default) || (d.accounts || [])[0];
  if (!acct) throw new Error('No DocuSign account found for this login');
  return { email: d.email, accountId: acct.account_id, baseUri: acct.base_uri };
}

async function connect(code) {
  const tokens = await exchangeCode(code);
  if (!tokens.refresh_token) {
    throw new Error('DocuSign did not return a refresh token — try disconnecting any prior access and reconnecting.');
  }
  const info = await fetchUserInfo(tokens.access_token);
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);
  await pool.query(
    `INSERT INTO docusign_tokens (id, email, account_id, base_uri, refresh_token, access_token, expires_at, updated_at)
     VALUES (1,$1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (id) DO UPDATE SET email=$1, account_id=$2, base_uri=$3, refresh_token=$4, access_token=$5, expires_at=$6, updated_at=now()`,
    [info.email, info.accountId, info.baseUri, tokens.refresh_token, tokens.access_token, expiresAt]
  );
}

async function disconnect() {
  await pool.query('DELETE FROM docusign_tokens WHERE id = 1');
}

async function status() {
  const { rows } = await pool.query('SELECT email, account_id FROM docusign_tokens WHERE id = 1');
  const row = rows[0];
  return row ? { connected: true, email: row.email } : { connected: false };
}

async function getRow() {
  const { rows } = await pool.query('SELECT * FROM docusign_tokens WHERE id = 1');
  return rows[0] || null;
}

async function getFreshAccessToken() {
  const row = await getRow();
  if (!row) throw new Error('Not connected');
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() - Date.now() > 60000) {
    return { accessToken: row.access_token, accountId: row.account_id, baseUri: row.base_uri };
  }
  const basic = Buffer.from(`${process.env.DOCUSIGN_INTEGRATION_KEY}:${process.env.DOCUSIGN_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${AUTH_HOST}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + basic },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === 'invalid_grant') await disconnect();
    throw new Error(data.error_description || data.error || 'Could not refresh DocuSign access token');
  }
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
  await pool.query('UPDATE docusign_tokens SET access_token=$1, expires_at=$2, updated_at=now() WHERE id=1', [data.access_token, expiresAt]);
  return { accessToken: data.access_token, accountId: row.account_id, baseUri: row.base_uri };
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Renders the proposal as a simple signable HTML document — DocuSign converts
// HTML documents to PDF automatically, so no PDF-generation library is needed.
// "/sig1/" and "/date1/" are anchor strings DocuSign finds in the rendered
// document to place the signature/date tabs, instead of fixed x/y coordinates.
function buildProposalHtml(p) {
  const lines = (p.items || []).map(i => `<li>${escHtml(i.s)} — $${Number(i.p).toLocaleString()}${i.monthly === false ? ' (one-time)' : '/mo'}</li>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;color:#222;padding:40px;line-height:1.5}
    h1{font-size:20px;margin-bottom:0}
    .sub{color:#666;margin-top:4px}
    ul{margin:16px 0}
    .tot{font-size:16px;font-weight:bold;margin-top:20px}
    .sig{margin-top:60px}
  </style></head><body>
  <h1>Summit Creative Group, LLC</h1>
  <p class="sub">Proposal #SCG-${escHtml(p.num)} &middot; ${escHtml(p.date)}</p>
  <p><b>Prepared for:</b> ${escHtml(p.client)}<br><b>Prepared by:</b> ${escHtml(p.preparedBy || '')}</p>
  <h3>Services</h3>
  <ul>${lines}</ul>
  ${p.setup ? `<p>One-time setup: $${Number(p.setup).toLocaleString()}</p>` : ''}
  ${p.disc ? `<p>Discount: -$${Number(p.disc).toLocaleString()}</p>` : ''}
  <p class="tot">Total investment: $${Number(p.total).toLocaleString()}</p>
  <h3>Scope</h3>
  <p>${escHtml(p.notes).replace(/\n/g, '<br>')}</p>
  <div class="sig">
  <p>Signature: /sig1/ &nbsp;&nbsp;&nbsp; Date: /date1/</p>
  </div>
  </body></html>`;
}

async function sendForSignature(p, recipientEmail, recipientName) {
  if (!recipientEmail) throw new Error('Recipient email required');
  const { accessToken, accountId, baseUri } = await getFreshAccessToken();
  const html = buildProposalHtml(p);
  const envelope = {
    emailSubject: `Please sign: Summit Creative Group proposal #SCG-${p.num}`,
    emailBlurb: 'Please review and sign the attached proposal from Summit Creative Group.',
    status: 'sent',
    documents: [{
      documentId: '1',
      name: `SCG Proposal ${p.num}.html`,
      fileExtension: 'html',
      documentBase64: Buffer.from(html, 'utf8').toString('base64'),
    }],
    recipients: {
      signers: [{
        email: recipientEmail,
        name: recipientName || recipientEmail,
        recipientId: '1',
        routingOrder: '1',
        tabs: {
          signHereTabs: [{ anchorString: '/sig1/', anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-10' }],
          dateSignedTabs: [{ anchorString: '/date1/', anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-10' }],
        },
      }],
    },
  };
  const res = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify(envelope),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.message) || JSON.stringify(data.errorDetails || data) || 'DocuSign envelope creation failed');
  return { envelopeId: data.envelopeId, status: data.status };
}

async function getEnvelopeStatus(envelopeId) {
  const { accessToken, accountId, baseUri } = await getFreshAccessToken();
  const res = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}`, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Could not check envelope status');
  return { status: data.status, completedAt: data.completedDateTime || null };
}

module.exports = { configured, initTable, buildAuthUrl, verifyState, connect, disconnect, status, sendForSignature, getEnvelopeStatus };
