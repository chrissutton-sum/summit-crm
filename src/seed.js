// Run once after first deploy: node src/seed.js
// Creates a login account for each of the three default team members
// (Alex / Sarah / Jordan) and prints the generated passwords ONCE.
// Alex is made an admin (can see Invoices/Insights/Settings and can create
// further logins from Settings afterward).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, init, defaultData } = require('./db');

function genPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

async function main() {
  await init();

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM accounts');
  if (rows[0].n > 0) {
    console.log('Accounts already exist — seed already ran. Not creating duplicates.');
    const existing = await pool.query('SELECT username, user_id, is_admin FROM accounts ORDER BY created_at');
    console.table(existing.rows);
    process.exit(0);
  }

  const seedUsers = [
    { userId: 'u1', username: 'alex', isAdmin: true },
    { userId: 'u2', username: 'sarah', isAdmin: false },
    { userId: 'u3', username: 'jordan', isAdmin: false },
  ];

  const results = [];
  for (const u of seedUsers) {
    const password = genPassword();
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO accounts (username, password_hash, user_id, is_admin) VALUES ($1, $2, $3, $4)',
      [u.username, hash, u.userId, u.isAdmin]
    );
    results.push({ ...u, password });
  }

  console.log('\nCreated login accounts — save these now, they are not shown again:\n');
  console.table(results.map((r) => ({ username: r.username, password: r.password, admin: r.isAdmin })));
  console.log('\nEach person should sign in with their username + password above, then change it from Settings.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
