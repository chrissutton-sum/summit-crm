// Google Calendar OAuth: lets each team member click "Sign in with Google"
// instead of hunting down a secret iCal link. Requires GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI env vars (set up once in Google
// Cloud Console — see chat for the walkthrough). Tokens are stored server-side
// only; the browser never sees them.
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const { utcMsToBizLocal } = require('./ics');

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.readonly',
  // Lets someone send an email from a lead/contact record as themselves
  // (see sendEmail below) and lets the server read just enough of the
  // resulting thread to log replies back onto that record (see
  // syncGmailReplies) — never anyone's whole inbox.
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function configured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

async function initTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_tokens (
      user_id TEXT PRIMARY KEY,
      email TEXT,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function buildAuthUrl(stateUserId) {
  const state = jwt.sign({ uid: stateUserId, purpose: 'gcal-connect' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: SCOPES.join(' '),
    state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

function verifyState(state) {
  const payload = jwt.verify(state, process.env.JWT_SECRET);
  if (payload.purpose !== 'gcal-connect' || !payload.uid) throw new Error('Bad state');
  return payload.uid;
}

async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google token exchange failed');
  return data; // { access_token, refresh_token?, expires_in, id_token, ... }
}

async function fetchEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!res.ok) return null;
  const d = await res.json();
  return d.email || null;
}

async function connect(userId, code) {
  const tokens = await exchangeCode(code);
  if (!tokens.refresh_token) {
    // Happens if the user had already granted consent and Google chose not to
    // re-issue one even with prompt=consent (rare, but be explicit about it).
    throw new Error('Google did not return a refresh token — try disconnecting any prior access at myaccount.google.com/permissions and reconnecting.');
  }
  const email = await fetchEmail(tokens.access_token);
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);
  await pool.query(
    `INSERT INTO google_tokens (user_id, email, refresh_token, access_token, expires_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (user_id) DO UPDATE SET email=$2, refresh_token=$3, access_token=$4, expires_at=$5, updated_at=now()`,
    [userId, email, tokens.refresh_token, tokens.access_token, expiresAt]
  );
}

async function disconnect(userId) {
  await pool.query('DELETE FROM google_tokens WHERE user_id = $1', [userId]);
}

async function statusAll() {
  const { rows } = await pool.query('SELECT user_id, email FROM google_tokens');
  const out = {};
  for (const r of rows) out[r.user_id] = r.email;
  return out;
}

async function getFreshAccessToken(userId) {
  const { rows } = await pool.query('SELECT * FROM google_tokens WHERE user_id = $1', [userId]);
  const row = rows[0];
  if (!row) return null;
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() - Date.now() > 60000) {
    return row.access_token;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: row.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    // Refresh token revoked/expired (e.g. 7-day testing-mode expiry) — drop it
    // so status-all stops reporting this user as connected.
    if (data.error === 'invalid_grant') await disconnect(userId);
    throw new Error(data.error_description || data.error || 'Could not refresh Google access token');
  }
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
  await pool.query('UPDATE google_tokens SET access_token=$1, expires_at=$2, updated_at=now() WHERE user_id=$3', [data.access_token, expiresAt, userId]);
  return data.access_token;
}

async function fetchEvents(userId, windowStartMs, windowEndMs) {
  const accessToken = await getFreshAccessToken(userId);
  if (!accessToken) throw new Error('Not connected');
  const events = [];
  let pageToken = null;
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({
      timeMin: new Date(windowStartMs).toISOString(),
      timeMax: new Date(windowEndMs).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Google Calendar API error');
    for (const item of data.items || []) {
      if (item.status === 'cancelled') continue;
      const allDay = !!(item.start && item.start.date);
      let start, end;
      if (allDay) {
        start = item.start.date;
        end = item.end ? item.end.date : item.start.date;
      } else {
        start = utcMsToBizLocal(new Date(item.start.dateTime).getTime());
        end = item.end ? utcMsToBizLocal(new Date(item.end.dateTime).getTime()) : start;
      }
      events.push({ uid: item.id, title: item.summary || '(untitled)', location: item.location || '', allDay, start, end });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  events.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  return events;
}

// ---- Two-way email logging ----
// Outbound: sendEmail actually sends through the signed-in user's own Gmail
// (not a mailto link), so the CRM can be sure it went out and log it as a
// fact rather than a maybe. Inbound: syncGmailReplies polls each lead's
// stored thread for messages since the last check and logs any that didn't
// come from the owner themself — so a reply shows up on the lead's activity
// history without anyone copy-pasting it in.

function buildRawMessage({ to, subject, body, fromEmail }) {
  const lines = [
    `To: ${to}`,
    fromEmail ? `From: ${fromEmail}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body || '',
  ].filter(line => line !== null);
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

async function sendEmail(userId, { to, subject, body }) {
  const accessToken = await getFreshAccessToken(userId);
  if (!accessToken) throw new Error('Not connected to Google — sign in under Settings → Your calendar first.');
  const { rows } = await pool.query('SELECT email FROM google_tokens WHERE user_id = $1', [userId]);
  const raw = buildRawMessage({ to, subject, body, fromEmail: rows[0]?.email });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'Gmail send failed');
  return { id: data.id, threadId: data.threadId };
}

async function fetchThreadMessages(userId, threadId) {
  const accessToken = await getFreshAccessToken(userId);
  if (!accessToken) return null;
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
    { headers: { Authorization: 'Bearer ' + accessToken } },
  );
  const data = await res.json();
  if (!res.ok) return null;
  return (data.messages || []).map(m => ({
    id: m.id,
    internalDate: +m.internalDate || Date.now(),
    from: (m.payload?.headers || []).find(h => h.name === 'From')?.value || '',
    snippet: m.snippet || '',
  }));
}

// getData() reads the current CRM blob (for scanning which leads have a
// gmailThreadId and who owns them). mutateData(fn) runs fn against a
// FOR-UPDATE-locked copy of that same blob and writes back whatever fn
// mutated in place — see server.js's mutateData, which guards this the same
// way PUT /api/data guards a normal save. notify(userIds, title, body, data)
// is push.sendToUsers, passed in rather than required directly so this
// module doesn't need to know push.js exists.
async function syncGmailReplies(getData, mutateData, notify) {
  const data = await getData();
  const leads = (data.leads || []).filter(l => l.gmailThreadId);
  if (!leads.length) return;
  const { rows: tokRows } = await pool.query('SELECT user_id, email FROM google_tokens');
  const emailByUser = new Map(tokRows.map(r => [r.user_id, r.email]));

  for (const lead of leads) {
    const myEmail = emailByUser.get(lead.owner);
    if (!myEmail) continue; // owner isn't (or no longer) connected to Google
    let msgs;
    try { msgs = await fetchThreadMessages(lead.owner, lead.gmailThreadId); } catch (e) { continue; }
    if (!msgs) continue;

    const seen = new Set(lead.gmailSeenIds || []);
    const fresh = msgs.filter(m => !seen.has(m.id));
    if (!fresh.length) continue;
    const incoming = fresh.filter(m => !m.from.toLowerCase().includes(myEmail.toLowerCase()));

    await mutateData(d => {
      const l2 = (d.leads || []).find(x => x.id === lead.id);
      if (!l2) return;
      l2.gmailSeenIds = [...new Set([...(l2.gmailSeenIds || []), ...fresh.map(m => m.id)])];
      for (const m of incoming) {
        d.log = d.log || [];
        d.log.unshift({ id: 'gm_' + m.id, ref: 'L' + l2.id, text: `↩️ Reply from ${m.from}: ${m.snippet}`, by: 'Gmail sync', at: new Date(m.internalDate).toISOString() });
      }
      if (d.log && d.log.length > 600) d.log = d.log.slice(0, 600);
    });

    if (incoming.length) {
      notify([lead.owner], '📧 New email reply', `${lead.company || lead.contact || 'A lead'} replied to your email`, { type: 'lead', id: lead.id });
    }
  }
}

module.exports = {
  configured, initTable, buildAuthUrl, verifyState, connect, disconnect, statusAll, fetchEvents,
  sendEmail, syncGmailReplies,
};
