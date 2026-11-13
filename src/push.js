// Push notifications (Firebase Cloud Messaging) for the SCG CRM Android app.
//
// Device tokens are registered by the app itself (see public/native.js,
// which calls POST /api/push/register once it has permission) and stored
// per-user here. notify() is called after every /api/data save — mirroring
// connect.js's announceWins() — to diff the old vs new blob and push a
// couple of high-value, easy-to-define-as-an-edit events: a lead getting
// assigned/reassigned, and a deal moving into the Won stage. Task due/
// overdue reminders aren't edit-triggered (they happen purely because time
// passed), so those run on their own hourly timer instead.
//
// One manual setup step is needed before any of this actually sends
// anything: a Firebase project with Cloud Messaging enabled, its service
// account JSON base64-encoded into the FCM_SERVICE_ACCOUNT_JSON env var on
// Render, and the matching google-services.json added to the Android build
// (see mobile/PUSH_SETUP.md). Until that's done, sendToUsers() logs once and
// quietly does nothing else — nothing here breaks without it.
const { pool } = require('./db');

let fbApp = null, triedInit = false;
function firebase() {
  if (triedInit) return fbApp;
  triedInit = true;
  const b64 = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!b64) {
    console.warn('[push] FCM_SERVICE_ACCOUNT_JSON not set — push notifications are disabled until it is. See mobile/PUSH_SETUP.md.');
    return null;
  }
  try {
    const svc = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(svc) });
    fbApp = admin;
  } catch (e) {
    console.error('[push] Could not initialize Firebase from FCM_SERVICE_ACCOUNT_JSON:', e.message);
    fbApp = null;
  }
  return fbApp;
}

async function initTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'android',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function tokensFor(userIds) {
  if (!userIds.length) return [];
  const { rows } = await pool.query('SELECT token FROM push_tokens WHERE user_id = ANY($1)', [userIds]);
  return rows.map(r => r.token);
}

async function sendToUsers(userIds, title, body, data = {}) {
  const admin = firebase();
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!admin || !ids.length) return;
  const tokens = await tokensFor(ids);
  if (!tokens.length) return;
  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
    });
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (!r.success && (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token')) {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) await pool.query('DELETE FROM push_tokens WHERE token = ANY($1)', [dead]);
  } catch (e) {
    console.error('[push] send failed:', e.message);
  }
}

function mount(app) {
  const { requireAuth } = require('./auth');

  app.post('/api/push/register', requireAuth, async (req, res) => {
    const { token, platform } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    await pool.query(
      `INSERT INTO push_tokens (token, user_id, platform, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (token) DO UPDATE SET user_id = $2, platform = $3, updated_at = now()`,
      [token, req.account.userId, platform || 'android']
    );
    res.json({ ok: true });
  });

  app.post('/api/push/unregister', requireAuth, async (req, res) => {
    const { token } = req.body || {};
    if (token) await pool.query('DELETE FROM push_tokens WHERE token = $1', [token]);
    res.json({ ok: true });
  });
}

const stagesOf = data => data.cfg?.stages || [];
const wonStage = data => stagesOf(data).at(-2);

// Called after every /api/data save (see server.js's PUT /api/data).
function notifyChanges(before, after) {
  if (!before || !after) return;
  try {
    const prevLeads = new Map((before.leads || []).map(l => [l.id, l]));
    for (const l of after.leads || []) {
      const was = prevLeads.get(l.id);
      if (l.owner && (!was || was.owner !== l.owner)) {
        sendToUsers([l.owner], '🎯 New lead assigned', `${l.company || l.contact || 'A lead'} — ${l.disposition || ''}`, { type: 'lead', id: l.id });
      }
    }
    const won = wonStage(after);
    const prevDealStage = new Map((before.deals || []).map(d => [d.id, d.stage]));
    for (const d of after.deals || []) {
      if (won && d.stage === won && prevDealStage.has(d.id) && prevDealStage.get(d.id) !== won) {
        sendToUsers([d.owner], '🎉 Deal won', `${d.name || d.account || 'A deal'} — $${Number(d.amount) || 0}`, { type: 'deal', id: d.id });
      }
    }
  } catch (e) {
    console.error('[push] notifyChanges failed:', e.message);
  }
}

// Due/overdue task reminders happen purely because time passed, not because
// of an edit, so they run on their own timer. Sends at most once per task
// per calendar day; the de-dupe set is in-memory only, so a restart can
// repeat a reminder once — harmless, and simpler than persisting it.
const remindedToday = new Set();
function startTaskReminders(getData, intervalMs = 60 * 60 * 1000) {
  const check = async () => {
    try {
      const data = await getData();
      const dateKey = new Date().toISOString().slice(0, 10);
      const due = (data.tasks || []).filter(t => !t.done && t.due && t.due <= dateKey);
      const byOwner = new Map();
      for (const t of due) {
        const key = dateKey + ':' + t.id;
        if (remindedToday.has(key)) continue;
        remindedToday.add(key);
        if (!byOwner.has(t.owner)) byOwner.set(t.owner, []);
        byOwner.get(t.owner).push(t);
      }
      for (const [owner, tasks] of byOwner) {
        if (!owner || !tasks.length) continue;
        const overdue = tasks.filter(t => t.due < dateKey).length;
        sendToUsers([owner], '✅ Tasks due today', `${tasks.length} task${tasks.length === 1 ? '' : 's'} due${overdue ? ` (${overdue} overdue)` : ''}`, { type: 'tasks' });
      }
      if (remindedToday.size > 5000) remindedToday.clear(); // don't grow forever
    } catch (e) {
      console.error('[push] task reminder check failed:', e.message);
    }
  };
  setInterval(check, intervalMs);
}

module.exports = { mount, initTable, notifyChanges, sendToUsers, startTaskReminders };
