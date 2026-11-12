process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test@localhost/test';
const test = require('node:test');
const assert = require('node:assert');
const { announceWins, dealCard } = require('../src/connect');

const data = (stage) => ({
  cfg: { stages: ['Qualification', 'Proposal', 'Closed Won', 'Closed Lost'] },
  users: [{ id: 'u1', name: 'Sam Rep' }],
  deals: [{ id: 'd1', name: 'Website rebuild', account: 'AAROW', amount: 4500, stage, owner: 'u1' }],
});

test('dealCard includes owner name and won flag', () => {
  const card = dealCard(data('Closed Won'), data('Closed Won').deals[0]);
  assert.equal(card.owner, 'Sam Rep');
  assert.equal(card.won, true);
  assert.equal(card.stage_count, 2);
});

test('announceWins only fires when a deal moves into the won stage', async () => {
  process.env.CONNECT_URL = 'https://connect.test';
  process.env.CONNECT_KEY = 'k';
  const calls = [];
  global.fetch = async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { ok: true }; };
  announceWins(data('Proposal'), data('Proposal'));
  announceWins(data('Closed Won'), data('Closed Won'));
  assert.equal(calls.length, 0);
  announceWins(data('Proposal'), data('Closed Won'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://connect.test/api/integrations/crm/deal-won');
  assert.equal(calls[0][1].name, 'Website rebuild');
});
