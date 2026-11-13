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

// A few things happen purely because time passed rather than because of an
// edit, so notifyChanges() (edit-triggered) can't catch them. These three
// checks run on one shared hourly timer instead — same mirror-the-client
// logic connect.js and the public/index.html lead helpers use (WON()/
// LOST()/stale/SLA are each duplicated here in server-side form since
// there's no shared module between the browser and the server).
//
// Sends are de-duped in-memory so a restart can repeat one reminder at
// worst — harmless, and much simpler than persisting a "already notified"
// flag in the data blob just for this.
const remindedToday = new Set();
const SLA_HOURS = 4;
const STALE_DAYS = 5;
const dispsOf = data => data.cfg?.disps || [];
const leadConverted = data => { const d = dispsOf(data); return d.includes('Converted') ? 'Converted' : d.at(-2); };
const leadLost = data => { const d = dispsOf(data); return d.includes('Lost') ? 'Lost' : d.at(-1); };
const leadOpen = (data, l) => l.disposition !== leadConverted(data) && l.disposition !== leadLost(data);
const leadTouch = (data, l) => Math.max(
  l.createdAt ? +new Date(l.createdAt) : 0,
  ...(data.log || []).filter(x => x.ref === 'L' + l.id).map(x => +new Date(x.at)),
  ...(l.noteLog || []).map(n => +new Date(n.at)),
);

function startPeriodicChecks(getData, intervalMs = 60 * 60 * 1000) {
  const check = async () => {
    try {
      const data = await getData();
      const dateKey = new Date().toISOString().slice(0, 10);

      // 1. Tasks due/overdue today — once per task per calendar day.
      const due = (data.tasks || []).filter(t => !t.done && t.due && t.due <= dateKey);
      const byOwner = new Map();
      for (const t of due) {
        const key = 'task:' + dateKey + ':' + t.id;
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

      // 2. SLA breach — a lead still in the first ("New") disposition that's
      // gone past SLA_HOURS with no first response. Fires once per lead
      // (not daily); re-arms automatically if the lead ever cycles back
      // through "New" again later (new createdAt-independent breach).
      const firstDisp = dispsOf(data)[0];
      for (const l of data.leads || []) {
        if (!l.createdAt || l.disposition !== firstDisp) continue;
        const deadline = +new Date(l.createdAt) + SLA_HOURS * 3600e3;
        if (Date.now() <= deadline) continue;
        const key = 'sla:' + l.id + ':' + l.createdAt;
        if (remindedToday.has(key)) continue;
        remindedToday.add(key);
        sendToUsers([l.owner], '⏰ SLA breached', `${l.company || l.contact || 'A lead'} has had no first response in ${SLA_HOURS}h+`, { type: 'lead', id: l.id });
      }

      // 3. Stale lead — gone quiet (no logged activity) for STALE_DAYS+ while
      // still open. Keyed to the day of last activity, so a lead that gets
      // touched and later goes stale again triggers a fresh notification.
      for (const l of data.leads || []) {
        if (!leadOpen(data, l)) continue;
        const touch = leadTouch(data, l);
        if (!touch || Date.now() - touch <= STALE_DAYS * 864e5) continue;
        const key = 'stale:' + l.id + ':' + Math.floor(touch / 864e5);
        if (remindedToday.has(key)) continue;
        remindedToday.add(key);
        sendToUsers([l.owner], '🧊 Lead gone quiet', `${l.company || l.contact || 'A lead'} — no activity in ${STALE_DAYS}+ days`, { type: 'lead', id: l.id });
      }

      if (remindedToday.size > 10000) remindedToday.clear(); // don't grow forever
    } catch (e) {
      console.error('[push] periodic check failed:', e.message);
    }
  };
  setInterval(check, intervalMs);
}

module.exports = { mount, initTable, notifyChanges, sendToUsers, startPeriodicChecks };
