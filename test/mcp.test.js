// End-to-end test of the AI connector against a real server + Postgres.
// Run: MCP_TEST_DATABASE_URL=postgres://... node --test test/mcp.test.js
// (uses and wipes that database). Skipped when the variable isn't set.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const DB = process.env.MCP_TEST_DATABASE_URL;
const PORT = 3217;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'test-mcp-secret-not-for-production';
const REDIRECT = 'http://localhost:9/callback';
const PW = 'testpass123';

let server, pool, jwt;

test.before(async () => {
  if (!DB) return;
  process.env.DATABASE_URL = DB;
  process.env.JWT_SECRET = SECRET;
  ({ pool } = require('../src/db'));
  jwt = require('jsonwebtoken');
  await pool.query('DROP TABLE IF EXISTS oauth_tokens, oauth_codes, oauth_clients, crm_data, accounts CASCADE');

  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT, DATABASE_URL: DB, JWT_SECRET: SECRET, MCP_ALLOW_LOCALHOST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write(d));
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => String(d).includes('listening') && resolve());
    server.on('exit', code => reject(new Error('server exited ' + code)));
  });

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(PW, 10);
  await pool.query(`INSERT INTO accounts (username, password_hash, user_id, is_admin) VALUES
    ('alex', $1, 'u1', true), ('jordan', $1, 'u3', false), ('sarah', $1, 'u2', false)`, [hash]);
  await pool.query(`UPDATE crm_data SET data = jsonb_set(jsonb_set(data, '{users}', $1), '{leads}', $2)`, [
    JSON.stringify([{ id: 'u1', name: 'Alex' }, { id: 'u2', name: 'Sarah' }, { id: 'u3', name: 'Jordan', level: 'staff' }]),
    JSON.stringify([{ id: 'old1', company: 'Ridgeline Diesel', phone: '208-555-0101', disposition: 'New Lead', owner: 'u2', services: [], value: 0 }]),
  ]);
});

test.after(async () => {
  server?.kill();
  await pool?.end();
});

const skip = !DB && 'set MCP_TEST_DATABASE_URL to run';

async function connect(username, password = PW) {
  const reg = await (await fetch(`${BASE}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test', redirect_uris: [REDIRECT] }),
  })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = { client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256' };
  const page = await fetch(`${BASE}/oauth/authorize?${new URLSearchParams(params)}`);
  assert.equal(page.status, 200);
  const res = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ ...params, username, password, action: 'allow' }),
  });
  if (res.status !== 302) return { status: res.status };
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const tok = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }),
  });
  return { ...(await tok.json()), client_id: reg.client_id };
}

let rpcId = 0;
async function rpc(token, method, params = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function call(token, name, args = {}) {
  const { body } = await rpc(token, 'tools/call', { name, arguments: args });
  const r = body.result;
  return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
}
const crm = async () => (await pool.query('SELECT data FROM crm_data WHERE id = 1')).rows[0].data;

test('discovery metadata and sign-in challenge', { skip }, async () => {
  const unauth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:3217\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
});

test('only Claude and ChatGPT (and localhost in tests) can register', { skip }, async () => {
  const reg = uris => fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: uris }) });
  assert.equal((await reg(['https://evil.example/cb'])).status, 400);
  assert.equal((await reg(['https://claude.ai.evil.example/cb'])).status, 400);
  assert.equal((await reg(['https://claude.ai/api/mcp/auth_callback'])).status, 201);
  assert.equal((await reg(['https://chatgpt.com/connector_platform_oauth_redirect'])).status, 201);
});

test('wrong password, cancel, and bad PKCE are refused', { skip }, async () => {
  assert.equal((await connect('alex', 'nope')).status, 401);

  const reg = await (await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
  const p = { client_id: reg.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: 'abc', code_challenge_method: 'S256' };
  const deny = await fetch(`${BASE}/oauth/authorize`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...p, action: 'deny' }) });
  assert.match(deny.headers.get('location'), /error=access_denied/);
  const ok = await fetch(`${BASE}/oauth/authorize`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...p, username: 'alex', password: PW, action: 'allow' }) });
  const code = new URL(ok.headers.get('location')).searchParams.get('code');
  const tok = await fetch(`${BASE}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: 'wrong' }) });
  assert.equal((await tok.json()).error, 'invalid_grant');
});

test('tools: list, search, leads, notes, duplicates', { skip }, async () => {
  const { access_token: t } = await connect('alex');
  const list = await rpc(t, 'tools/list');
  const names = list.body.result.tools.map(x => x.name);
  assert.ok(names.includes('crm_overview') && names.includes('add_note') && names.includes('update_deal'));
  assert.ok(!names.some(n => /delete|remove/.test(n)));

  const ov = await call(t, 'crm_overview');
  assert.equal(ov.data.signed_in_as.name, 'Alex');

  const dup = await call(t, 'create_lead', { company: 'Ridgeline Diesel' });
  assert.match(dup.error, /Already in the CRM.*old1/);

  const made = await call(t, 'create_lead', { company: 'Sawtooth Coffee', contact: 'Sam', phone: '208-555-0199', services: ['seo', 'Social Media'], owner: 'sarah' });
  assert.equal(made.data.owner, 'Sarah');
  assert.equal(made.data.monthly_value, 1200 + 950);
  assert.deepEqual(made.data.services, ['SEO', 'Social Media']);

  assert.match((await call(t, 'update_lead', { id: made.data.id, status: 'Hot' })).error, /Unknown status/);
  const upd = await call(t, 'update_lead', { id: made.data.id, status: 'contacted' });
  assert.equal(upd.data.status, 'Contacted');

  await call(t, 'add_note', { record_type: 'lead', record_id: made.data.id, text: 'Owner wants a call Tuesday' });
  const got = await call(t, 'get_lead', { id: made.data.id });
  assert.equal(got.data.history[0].text, '📝 Owner wants a call Tuesday');
  assert.equal(got.data.history[0].by, 'Alex');
  assert.ok(got.data.history.some(h => h.text === 'Status → Contacted'));

  const found = await call(t, 'search_crm', { query: '555-0199' });
  assert.equal(found.data.results[0].id, made.data.id);

  const data = await crm();
  assert.match(data.audit[0].text, /via Test|via An AI app/);
});

test('deals: lost needs a reason, won creates the client', { skip }, async () => {
  const { access_token: t } = await connect('alex');
  const d = await call(t, 'create_deal', { name: 'Sawtooth – SEO', client: 'Sawtooth Coffee', services: ['SEO'] });
  assert.equal(d.data.stage, 'Qualification');
  assert.equal(d.data.amount, 1200);

  assert.match((await call(t, 'update_deal', { id: d.data.id, stage: 'Closed Lost' })).error, /loss_reason/);
  const won = await call(t, 'update_deal', { id: d.data.id, stage: 'closed won' });
  assert.equal(won.data.client_created, 'Sawtooth Coffee');
  const again = await call(t, 'update_deal', { id: d.data.id, amount: 1500 });
  assert.equal(again.data.client_created, undefined);

  const data = await crm();
  assert.equal(data.accts.filter(a => a.dealId === d.data.id).length, 1);
  assert.equal(data.accts[0].steps.length, 5);
  assert.ok(data.log.some(e => e.ref === 'D' + d.data.id && e.text === 'Stage → Closed Won'));
});

test('staff logins cannot reassign leads', { skip }, async () => {
  const { access_token: t } = await connect('jordan');
  assert.match((await call(t, 'create_lead', { company: 'Boise Bikes', owner: 'Alex' })).error, /Staff/);
  const mine = await call(t, 'create_lead', { company: 'Boise Bikes' });
  assert.equal(mine.data.owner, 'Jordan');
  assert.match((await call(t, 'update_lead', { id: 'old1', owner: 'Jordan' })).error, /Staff/);
});

test('a stale browser save does not wipe out AI edits', { skip }, async () => {
  const { access_token: t } = await connect('alex');
  const browserToken = jwt.sign({ accountId: 1, username: 'alex', userId: 'u1', isAdmin: true }, SECRET);
  const stale = await crm(); // a tab loaded now

  const lead = await call(t, 'create_lead', { company: 'Treasure Valley Plumbing' });
  await call(t, 'update_lead', { id: 'old1', contact: 'Dana' });
  await call(t, 'add_note', { record_type: 'lead', record_id: 'old1', text: 'Left voicemail' });

  // The tab edits an unrelated field on its old copy and saves the leads + log sections
  stale.leads.find(l => l.id === 'old1').phone = '208-555-0102';
  const put = await fetch(`${BASE}/api/data`, {
    method: 'PUT', headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(stale),
  });
  assert.equal(put.status, 200);

  const after = await crm();
  assert.ok(after.leads.some(l => l.id === lead.data.id), 'AI-created lead kept');
  assert.equal(after.leads.find(l => l.id === 'old1').contact, 'Dana', 'AI edit kept');
  assert.ok(after.log.some(e => e.text === '📝 Left voicemail'), 'AI note kept');

  // A tab that already has the AI version wins normally
  const fresh = await crm();
  fresh.leads.find(l => l.id === 'old1').contact = 'Dana Smith';
  await fetch(`${BASE}/api/data`, { method: 'PUT', headers: { Authorization: `Bearer ${browserToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(fresh) });
  assert.equal((await crm()).leads.find(l => l.id === 'old1').contact, 'Dana Smith');
});

test('refresh tokens rotate; deactivation and password changes cut access', { skip }, async () => {
  const s = await connect('sarah');
  assert.equal((await rpc(s.access_token, 'tools/list')).status, 200);

  const refresh = body => fetch(`${BASE}/oauth/token`, { method: 'POST', body: new URLSearchParams(body) }).then(r => r.json());
  const next = await refresh({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id });
  assert.ok(next.access_token);
  assert.equal((await refresh({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id })).error, 'invalid_grant');
  assert.equal((await rpc(s.access_token, 'tools/list')).status, 401, 'old access token dropped on refresh');
  assert.equal((await rpc(next.access_token, 'tools/list')).status, 200);

  await pool.query(`UPDATE accounts SET active = false WHERE username = 'sarah'`);
  assert.equal((await rpc(next.access_token, 'tools/list')).status, 401);
  await pool.query(`UPDATE accounts SET active = true WHERE username = 'sarah'`);
  assert.equal((await rpc(next.access_token, 'tools/list')).status, 200);

  await pool.query(`UPDATE accounts SET password_hash = 'changed' WHERE username = 'sarah'`);
  assert.equal((await rpc(next.access_token, 'tools/list')).status, 401);
});

test('connections list and disconnect', { skip }, async () => {
  const { access_token: t } = await connect('alex');
  const browserToken = jwt.sign({ accountId: 1, username: 'alex', userId: 'u1', isAdmin: true }, SECRET);
  const list = await (await fetch(`${BASE}/api/ai-connections`, { headers: { Authorization: `Bearer ${browserToken}` } })).json();
  assert.ok(list.length >= 1);
  for (const c of list.filter(c => c.username === 'alex')) {
    await fetch(`${BASE}/api/ai-connections/${c.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${browserToken}` } });
  }
  assert.equal((await rpc(t, 'tools/list')).status, 401);
});
