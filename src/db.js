const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Point it at your Neon (or other) Postgres connection string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// node-postgres gotcha that crashed this server twice: when an IDLE client
// in the pool loses its connection (Neon's free tier drops idle connections
// after inactivity; a network blip can too), the Pool emits an 'error'
// event. With no listener for it, Node's default behavior is to throw and
// kill the whole process — even though the error has nothing to do with any
// request in flight. The pool recovers on its own (it opens a fresh
// connection on the next query); we just need to not let this crash the app.
pool.on('error', (err) => {
  console.error('Postgres pool: idle client error (recovered automatically):', err.message);
});

// Default data shape, mirrors what the CRM page used to seed into its shared doc.
function defaultData() {
  return {
    users: [
      { id: 'u1', name: 'Alex', role: 'Managing Partner' },
      { id: 'u2', name: 'Sarah', role: 'Account Executive' },
      { id: 'u3', name: 'Jordan', role: 'Events & Media' },
    ],
    cfg: {
      rates: {
        SEO: 1200, AEO: 850, GEO: 850, CTV: 2200,
        'Social Media': 950, Podcasts: 900, 'Logo Design': 750, 'Live Events': 2500,
      },
      stages: ['Qualification', 'Audit & Discovery', 'Proposal / Pitch', 'Negotiation', 'Closed Won', 'Closed Lost'],
      disps: ['New Lead', 'Attempted Contact', 'Contacted', 'Discovery Scheduled', 'Proposal Sent', 'Converted', 'Lost'],
      onboard: [
        'Signed retainer & deposit collected',
        'Kickoff & strategy call scheduled',
        'Website, GBP & analytics access granted',
        'Logo & brand assets uploaded',
        '30-day launch roadmap delivered',
      ],
    },
    leads: [], deals: [], acts: [], accts: [], invoices: [], recur: [],
    log: [], audit: [], deliv: [], props: [], tasks: [], files: [],
    templates: [
      { id: 't1', name: 'Intro follow-up', subject: 'Great connecting, {{contact}}', body: 'Hi {{contact}},\n\nThanks for taking the time to talk about {{client}}. I\'d love to share how Summit Creative can help grow your visibility in the Treasure Valley. Would a quick call this week work?\n\n{{rep}}\nSummit Creative Group' },
      { id: 't2', name: 'Proposal sent', subject: 'Your Summit Creative proposal', body: 'Hi {{contact}},\n\nAttached is the proposal for {{client}}. Happy to walk through it and adjust the scope. What day works for a short review?\n\n{{rep}}\nSummit Creative Group' },
      { id: 't3', name: 'Invoice due', subject: 'Invoice {{invoice}} from Summit Creative', body: 'Hi {{contact}},\n\nYour invoice {{invoice}} for {{amount}} is due {{due}}. Please let me know if you have any questions.\n\nThank you,\n{{rep}}\nSummit Creative Group' },
      { id: 't4', name: 'Overdue notice', subject: 'Reminder: invoice {{invoice}} is past due', body: 'Hi {{contact}},\n\nA friendly reminder that invoice {{invoice}} ({{amount}}) was due {{due}} and is still open. If it has already been sent, thank you and please disregard.\n\n{{rep}}\nSummit Creative Group' },
      { id: 't5', name: 'Welcome / onboarding', subject: 'Welcome to Summit Creative, {{client}}!', body: 'Hi {{contact}},\n\nWelcome aboard! We\'re excited to get started. Here is where your onboarding stands:\n\n{{extra}}\n\n{{rep}}\nSummit Creative Group' },
      { id: 't6', name: 'Monthly update', subject: 'Your monthly update from Summit Creative', body: 'Hi {{contact}},\n\nHere is your monthly snapshot for {{client}}:\n\n{{extra}}\n\n{{rep}}\nSummit Creative Group' },
    ],
  };
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      user_id TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_data (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);
  const { rows } = await pool.query('SELECT id FROM crm_data WHERE id = 1');
  if (rows.length === 0) {
    await pool.query('INSERT INTO crm_data (id, data) VALUES (1, $1)', [defaultData()]);
    console.log('Seeded default CRM data.');
  }
}

module.exports = { pool, init, defaultData };
