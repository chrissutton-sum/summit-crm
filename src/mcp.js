// MCP server for Claude / ChatGPT: view, create and edit leads, contacts,
// deals and notes, acting as the signed-in CRM user. No deletes.
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { readData, mutate } = require('./crmStore');
const { requireMcpAuth } = require('./oauth');
const { buildIndex, findMatch } = require('./leadFinder');

const SOURCES = ['Website', 'Referral', 'Event', 'Cold outreach', 'Google / SEO', 'Social', 'Partner', 'Unknown'];
const ONE_TIME_DEFAULT = { 'SBDC: Basic Website': false, 'SBDC: Logo Design': false, 'SBDC: Social Media Setup': false };

const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Boise' }).format(new Date());
const norm = s => String(s ?? '').toLowerCase().trim();

class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

// ---- Same rules the CRM page uses

const rate = (data, s) => Number(data.cfg?.rates?.[s]) || 800;
const isMonthly = (data, s) => {
  const m = data.cfg?.monthly || {};
  return m[s] !== undefined ? !!m[s] : ONE_TIME_DEFAULT[s] !== undefined ? !ONE_TIME_DEFAULT[s] : true;
};
const monthlyValue = (data, services) => (services || []).filter(s => isMonthly(data, s)).reduce((t, s) => t + rate(data, s), 0);
const stages = data => data.cfg?.stages || [];
const WON = data => stages(data).at(-2);
const LOST = data => stages(data).at(-1);

function mkAcct(data, o) {
  return {
    id: uid(), status: 'Active', created: today(), name: o.name, contact: o.contact || '', phone: o.phone || '',
    owner: o.owner, retainer: o.retainer || 0,
    steps: (data.cfg?.onboard || []).map(text => ({ id: uid(), text, done: false })),
  };
}

// ---- Lookups and validation

function pickOne(list, value, label) {
  if (value == null) return undefined;
  const hit = list.find(x => norm(x) === norm(value));
  if (!hit) fail(`Unknown ${label} "${value}". Use one of: ${list.join(', ')}`);
  return hit;
}

function ownerId(data, value) {
  if (value == null || value === '') return undefined;
  const users = data.users || [];
  const hit = users.find(u => u.id === value) || users.filter(u => norm(u.name) === norm(value));
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0].id;
    fail(hit.length ? `More than one team member is named "${value}". Use their id: ${hit.map(u => u.id).join(', ')}`
      : `Unknown team member "${value}". Team: ${users.map(u => u.name).join(', ')}`);
  }
  return hit.id;
}

function services(data, list) {
  if (list == null) return undefined;
  const known = Object.keys(data.cfg?.rates || {});
  return list.map(s => pickOne(known, s, 'service'));
}

function find(data, key, id, label) {
  const rec = (data[key] || []).find(r => r.id === id);
  if (!rec) fail(`No ${label} with id "${id}". Use search_crm to find the right id.`);
  return rec;
}

const userName = (data, id) => (data.users || []).find(u => u.id === id)?.name || (id ? 'Former user' : 'Unassigned');
const campaignName = (data, id) => (data.campaigns || []).find(c => c.id === id)?.name || '';

// ---- Shapes returned to the AI

const leadOut = (data, l) => ({
  id: l.id, type: 'lead', company: l.company, contact: l.contact || '', phone: l.phone || '', email: l.email || '',
  status: l.disposition || '', owner: userName(data, l.owner), source: l.source || '',
  campaign: campaignName(data, l.campaign), monthly_value: Number(l.value) || 0, services: l.services || [], notes: l.notes || '',
});
const dealOut = (data, d) => ({
  id: d.id, type: 'deal', name: d.name, client: d.account || '', contact: d.contact || '', email: d.email || '', phone: d.phone || '',
  stage: d.stage, owner: userName(data, d.owner), amount: Number(d.amount) || 0, expected_close: d.close || '',
  services: d.services || [], source: d.source || '', ...(d.lossReason && { loss_reason: d.lossReason }),
});
const contactOut = (data, k) => ({
  id: k.id, type: 'contact', name: k.name, company: k.company || '', title: k.title || '', phone: k.phone || '',
  email: k.email || '', address: k.address || '', owner: userName(data, k.owner), notes: k.notes || '',
});

const history = (data, ref) => (data.log || []).filter(e => e.ref === ref).slice(0, 50).map(e => ({ at: e.at, by: e.by, text: e.text }));

const TYPES = {
  lead: { key: 'leads', prefix: 'L', out: leadOut },
  deal: { key: 'deals', prefix: 'D', out: dealOut },
  contact: { key: 'contacts', prefix: 'K', out: contactOut },
};

// ---- Writes

function stamp(rec, isNew) {
  rec.aiAt = now();
  if (isNew) rec.aiNew = true;
  return rec;
}

function logEv(data, ctx, ref, text) {
  data.log = data.log || [];
  data.log.unshift(stamp({ id: uid(), ref, text, by: ctx.byName, at: now() }, true));
  data.log = data.log.slice(0, 600);
}

function audit(data, ctx, text) {
  data.audit = data.audit || [];
  data.audit.unshift({ at: now(), by: ctx.byName, text: `${text} (via ${ctx.clientName})` });
  data.audit = data.audit.slice(0, 2000);
}

const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function leadFields(data, ctx, a, existing) {
  const f = clean({
    company: a.company, contact: a.contact, phone: a.phone, email: a.email,
    source: pickOne(SOURCES, a.source, 'source'),
    disposition: pickOne(data.cfg?.disps || [], a.status, 'status'),
    services: services(data, a.services), notes: a.notes,
    value: a.monthly_value,
  });
  if (a.owner !== undefined) {
    const id = ownerId(data, a.owner);
    if (ctx.isStaff && id !== (existing ? existing.owner : ctx.userId)) fail('Staff logins can’t assign leads to someone else. Ask an admin.');
    f.owner = id;
  }
  return f;
}

function applyDeal(data, ctx, d, a, isNew) {
  Object.assign(d, clean({
    name: a.name, account: a.client, contact: a.contact, email: a.email, phone: a.phone,
    owner: a.owner !== undefined ? ownerId(data, a.owner) : undefined,
    stage: pickOne(stages(data), a.stage, 'stage'),
    amount: a.amount, close: a.expected_close, services: services(data, a.services),
    source: a.source !== undefined ? pickOne(SOURCES, a.source, 'source') : undefined,
  }));
  if (!d.name) fail('Deal name is required');
  if (!Number(d.amount)) d.amount = monthlyValue(data, d.services);
  d.account = d.account || d.name;

  // Same as the CRM page: lost needs a reason, won creates the client
  if (d.stage === LOST(data)) {
    if (a.loss_reason) d.lossReason = a.loss_reason;
    if (!d.lossReason) fail(`Moving a deal to ${LOST(data)} needs a loss_reason (price, timing, competitor, no response, other).`);
  } else delete d.lossReason;
  if (d.lastStage !== d.stage) {
    if (d.lastStage && !isNew) logEv(data, ctx, 'D' + d.id, 'Stage → ' + d.stage);
    d.lastStage = d.stage;
  }
  let createdClient = null;
  if (d.stage === WON(data) && !(data.accts || []).some(x => x.dealId === d.id)) {
    createdClient = stamp(mkAcct(data, { name: d.account, contact: d.contact, phone: d.phone, owner: d.owner, retainer: d.amount }), true);
    createdClient.dealId = d.id;
    data.accts = [createdClient, ...(data.accts || [])];
  }
  return createdClient;
}

// ---- Server

const result = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }], structuredContent: obj });
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const fieldDesc = {
  owner: 'Team member name (or id) from crm_overview',
  services: 'Service names exactly as listed in crm_overview',
};

function buildServer(ctx) {
  const server = new McpServer({ name: 'scg-crm', title: 'SCG CRM', version: '1.0.0' }, {
    instructions: 'SCG CRM for Summit Creative Group. Call crm_overview first to learn the team, lead statuses, deal stages, sources and services. Use search_crm to find records before editing. Nothing can be deleted through this connector.',
  });

  // Wraps every tool: catches our validation errors and returns them as tool errors the AI can read.
  const tool = (name, config, fn) => server.registerTool(name, config, async args => {
    try { return result(await fn(args || {})); }
    catch (e) {
      if (e instanceof UserError) return { content: [{ type: 'text', text: e.message }], isError: true };
      console.error('mcp tool', name, e);
      return { content: [{ type: 'text', text: 'Something went wrong in the CRM. Try again.' }], isError: true };
    }
  });

  const write = fn => mutate(data => {
    const user = (data.users || []).find(u => u.id === ctx.userId);
    Object.assign(ctx, { byName: user?.name || ctx.username, isStaff: user?.level === 'staff' });
    return fn(data);
  });

  tool('crm_overview', {
    title: 'CRM overview',
    description: 'Who you are signed in as, the team, lead statuses, deal stages, lead sources, services with monthly rates, and record counts. Call this first.',
    inputSchema: {}, annotations: READ,
  }, async () => {
    const data = await readData();
    const me = (data.users || []).find(u => u.id === ctx.userId);
    return {
      signed_in_as: { name: me?.name || ctx.username, id: ctx.userId, level: me?.level === 'staff' ? 'staff' : 'standard' },
      team: (data.users || []).map(u => ({ id: u.id, name: u.name, role: u.role || '' })),
      lead_statuses: data.cfg?.disps || [],
      deal_stages: stages(data),
      won_stage: WON(data), lost_stage: LOST(data),
      lead_sources: SOURCES,
      services: Object.keys(data.cfg?.rates || {}).map(s => ({ name: s, rate: rate(data, s), billing: isMonthly(data, s) ? 'monthly' : 'one-time' })),
      counts: { leads: (data.leads || []).length, deals: (data.deals || []).length, contacts: (data.contacts || []).length },
      today: today(),
    };
  });

  tool('search_crm', {
    title: 'Search the CRM',
    description: 'Find leads, deals and contacts by company, person, email or phone. Returns short summaries with ids.',
    inputSchema: {
      query: z.string().min(1).describe('Company, person, email or phone'),
      types: z.array(z.enum(['lead', 'deal', 'contact'])).optional().describe('Limit to these record types'),
    }, annotations: READ,
  }, async ({ query, types }) => {
    const data = await readData();
    const q = norm(query), digits = query.replace(/\D/g, '');
    const hit = (...vals) => vals.some(v => norm(v).includes(q)) || (digits.length >= 4 && vals.some(v => String(v || '').replace(/\D/g, '').includes(digits)));
    const want = t => !types?.length || types.includes(t);
    const out = [];
    if (want('lead')) for (const l of data.leads || []) if (hit(l.company, l.contact, l.email, l.phone)) out.push({ type: 'lead', id: l.id, company: l.company, contact: l.contact, status: l.disposition, owner: userName(data, l.owner) });
    if (want('deal')) for (const d of data.deals || []) if (hit(d.name, d.account, d.contact, d.email, d.phone)) out.push({ type: 'deal', id: d.id, name: d.name, client: d.account, stage: d.stage, amount: Number(d.amount) || 0, owner: userName(data, d.owner) });
    if (want('contact')) for (const k of data.contacts || []) if (hit(k.name, k.company, k.email, k.phone)) out.push({ type: 'contact', id: k.id, name: k.name, company: k.company, owner: userName(data, k.owner) });
    return { total: out.length, results: out.slice(0, 30) };
  });

  // ---- Leads

  tool('list_leads', {
    title: 'List leads',
    description: 'List leads, newest first, optionally filtered by status, owner or source.',
    inputSchema: {
      status: z.string().optional(), owner: z.string().optional().describe(fieldDesc.owner), source: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0),
    }, annotations: READ,
  }, async a => {
    const data = await readData();
    const st = a.status && pickOne(data.cfg?.disps || [], a.status, 'status');
    const own = a.owner && ownerId(data, a.owner);
    const src = a.source && pickOne(SOURCES, a.source, 'source');
    const list = (data.leads || []).filter(l => (!st || l.disposition === st) && (!own || l.owner === own) && (!src || l.source === src));
    return { total: list.length, offset: a.offset, leads: list.slice(a.offset, a.offset + a.limit).map(l => leadOut(data, l)) };
  });

  tool('get_lead', {
    title: 'Get a lead', description: 'Full details and history (notes, changes) for one lead.',
    inputSchema: { id: z.string() }, annotations: READ,
  }, async ({ id }) => {
    const data = await readData();
    return { ...leadOut(data, find(data, 'leads', id, 'lead')), history: history(data, 'L' + id) };
  });

  const leadInput = {
    company: z.string().optional(), contact: z.string().optional().describe('Contact person'),
    phone: z.string().optional(), email: z.string().optional(),
    source: z.string().optional().describe('Lead source from crm_overview'),
    status: z.string().optional().describe('Lead status from crm_overview'),
    owner: z.string().optional().describe(fieldDesc.owner),
    services: z.array(z.string()).optional().describe(fieldDesc.services),
    monthly_value: z.number().min(0).optional().describe('Monthly value in dollars. Leave out to calculate from services'),
    notes: z.string().optional().describe('The lead’s notes field. To log a dated note, use add_note instead'),
  };

  tool('create_lead', {
    title: 'Create a lead',
    description: 'Add a new lead. Checks for an existing lead, client or contact with the same company or phone first.',
    inputSchema: { ...leadInput, company: z.string().min(1), allow_duplicate: z.boolean().default(false).describe('Create even if a match exists') },
    annotations: WRITE,
  }, async a => write(data => {
    if (!a.allow_duplicate) {
      const match = findMatch(buildIndex(data), { name: a.company, phone: a.phone });
      if (match) fail(`Already in the CRM as a ${match.type}: ${match.company} (id ${match.id}, owner ${match.owner || 'none'}). Update that one, or pass allow_duplicate: true.`);
    }
    const f = leadFields(data, ctx, a, null);
    const lead = stamp({
      id: uid(), company: '', contact: '', phone: '', email: '', source: 'Unknown',
      disposition: data.cfg?.disps?.[0] || 'New Lead', services: [], notes: '', owner: ctx.userId, ...f,
    }, true);
    lead.value = Number(lead.value) || monthlyValue(data, lead.services);
    data.leads = [lead, ...(data.leads || [])];
    logEv(data, ctx, 'L' + lead.id, `✨ Added via ${ctx.clientName}`);
    audit(data, ctx, `Added lead ${lead.company}`);
    return leadOut(data, lead);
  }));

  tool('update_lead', {
    title: 'Update a lead',
    description: 'Change fields on a lead. Only the fields you pass are changed.',
    inputSchema: { id: z.string(), ...leadInput }, annotations: WRITE,
  }, async a => write(data => {
    const lead = find(data, 'leads', a.id, 'lead');
    const f = leadFields(data, ctx, a, lead);
    if (f.company === '') fail('Company can’t be blank');
    const before = lead.disposition;
    Object.assign(lead, f);
    if (a.monthly_value === 0 || (a.services && a.monthly_value === undefined && !Number(lead.value))) lead.value = monthlyValue(data, lead.services);
    stamp(lead);
    if (f.disposition && f.disposition !== before) logEv(data, ctx, 'L' + lead.id, `Status → ${lead.disposition}`);
    audit(data, ctx, `Edited lead ${lead.company}`);
    return leadOut(data, lead);
  }));

  // ---- Deals

  tool('list_deals', {
    title: 'List deals',
    description: 'List deals, optionally filtered by stage or owner. open_only skips won and lost deals.',
    inputSchema: {
      stage: z.string().optional(), owner: z.string().optional().describe(fieldDesc.owner), open_only: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0),
    }, annotations: READ,
  }, async a => {
    const data = await readData();
    const st = a.stage && pickOne(stages(data), a.stage, 'stage');
    const own = a.owner && ownerId(data, a.owner);
    const list = (data.deals || []).filter(d => (!st || d.stage === st) && (!own || d.owner === own)
      && (!a.open_only || (d.stage !== WON(data) && d.stage !== LOST(data))));
    const pipeline = list.filter(d => d.stage !== WON(data) && d.stage !== LOST(data)).reduce((t, d) => t + (Number(d.amount) || 0), 0);
    return { total: list.length, open_pipeline: pipeline, offset: a.offset, deals: list.slice(a.offset, a.offset + a.limit).map(d => dealOut(data, d)) };
  });

  tool('get_deal', {
    title: 'Get a deal', description: 'Full details and history (notes, stage changes) for one deal.',
    inputSchema: { id: z.string() }, annotations: READ,
  }, async ({ id }) => {
    const data = await readData();
    return { ...dealOut(data, find(data, 'deals', id, 'deal')), history: history(data, 'D' + id) };
  });

  const dealInput = {
    name: z.string().optional(), client: z.string().optional().describe('Client / company name'),
    contact: z.string().optional(), email: z.string().optional(), phone: z.string().optional(),
    owner: z.string().optional().describe(fieldDesc.owner),
    stage: z.string().optional().describe('Deal stage from crm_overview'),
    amount: z.number().min(0).optional().describe('Monthly amount in dollars. Leave out to calculate from services'),
    expected_close: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    services: z.array(z.string()).optional().describe(fieldDesc.services),
    source: z.string().optional(),
    loss_reason: z.string().optional().describe('Required when moving to the lost stage'),
  };

  tool('create_deal', {
    title: 'Create a deal',
    description: 'Add a deal. Moving it to the won stage also creates the client record, same as in the CRM.',
    inputSchema: { ...dealInput, name: z.string().min(1) }, annotations: WRITE,
  }, async a => write(data => {
    const d = { id: uid(), owner: ctx.userId, stage: stages(data)[0], services: [], source: 'Unknown', close: '' };
    const client = applyDeal(data, ctx, d, a, true);
    stamp(d, true);
    data.deals = [d, ...(data.deals || [])];
    logEv(data, ctx, 'D' + d.id, `✨ Added via ${ctx.clientName}`);
    audit(data, ctx, `Added deal ${d.name}`);
    return { ...dealOut(data, d), ...(client && { client_created: client.name }) };
  }));

  tool('update_deal', {
    title: 'Update a deal',
    description: 'Change fields on a deal, including moving its stage. Only the fields you pass are changed.',
    inputSchema: { id: z.string(), ...dealInput }, annotations: WRITE,
  }, async a => write(data => {
    const d = find(data, 'deals', a.id, 'deal');
    if (a.name === '') fail('Deal name can’t be blank');
    const client = applyDeal(data, ctx, d, a, false);
    stamp(d);
    audit(data, ctx, `Edited deal ${d.name}`);
    return { ...dealOut(data, d), ...(client && { client_created: client.name }) };
  }));

  // ---- Contacts

  tool('list_contacts', {
    title: 'List contacts', description: 'List contacts, optionally filtered by owner or company.',
    inputSchema: {
      owner: z.string().optional().describe(fieldDesc.owner), company: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).default(0),
    }, annotations: READ,
  }, async a => {
    const data = await readData();
    const own = a.owner && ownerId(data, a.owner);
    const list = (data.contacts || []).filter(k => (!own || k.owner === own) && (!a.company || norm(k.company).includes(norm(a.company))));
    return { total: list.length, offset: a.offset, contacts: list.slice(a.offset, a.offset + a.limit).map(k => contactOut(data, k)) };
  });

  tool('get_contact', {
    title: 'Get a contact', description: 'Full details and history for one contact.',
    inputSchema: { id: z.string() }, annotations: READ,
  }, async ({ id }) => {
    const data = await readData();
    return { ...contactOut(data, find(data, 'contacts', id, 'contact')), history: history(data, 'K' + id) };
  });

  const contactInput = {
    name: z.string().optional(), company: z.string().optional(), title: z.string().optional().describe('Job title / role'),
    phone: z.string().optional(), email: z.string().optional(), address: z.string().optional(),
    owner: z.string().optional().describe(fieldDesc.owner), notes: z.string().optional(),
  };
  const contactFields = (data, a) => clean({
    name: a.name, company: a.company, title: a.title, phone: a.phone, email: a.email, address: a.address,
    notes: a.notes, owner: a.owner !== undefined ? ownerId(data, a.owner) : undefined,
  });

  tool('create_contact', {
    title: 'Create a contact', description: 'Add a contact.',
    inputSchema: { ...contactInput, name: z.string().min(1) }, annotations: WRITE,
  }, async a => write(data => {
    const k = stamp({ id: uid(), owner: ctx.userId, ...contactFields(data, a) }, true);
    data.contacts = [k, ...(data.contacts || [])];
    logEv(data, ctx, 'K' + k.id, `✨ Added via ${ctx.clientName}`);
    audit(data, ctx, `Added contact ${k.name}`);
    return contactOut(data, k);
  }));

  tool('update_contact', {
    title: 'Update a contact', description: 'Change fields on a contact. Only the fields you pass are changed.',
    inputSchema: { id: z.string(), ...contactInput }, annotations: WRITE,
  }, async a => write(data => {
    const k = find(data, 'contacts', a.id, 'contact');
    if (a.name === '') fail('Name can’t be blank');
    Object.assign(k, contactFields(data, a));
    stamp(k);
    audit(data, ctx, `Edited contact ${k.name}`);
    return contactOut(data, k);
  }));

  // ---- Notes

  tool('add_note', {
    title: 'Add a note',
    description: 'Add a dated note to a lead, deal or contact’s history, signed with your name.',
    inputSchema: {
      record_type: z.enum(['lead', 'deal', 'contact']), record_id: z.string(),
      text: z.string().min(1).max(2000),
    }, annotations: WRITE,
  }, async ({ record_type, record_id, text }) => write(data => {
    const t = TYPES[record_type];
    const rec = find(data, t.key, record_id, record_type);
    logEv(data, ctx, t.prefix + record_id, '📝 ' + text.trim());
    stamp(rec); // so an open browser tab doesn't hide the new note behind a stale copy
    audit(data, ctx, `Added a note to ${record_type} ${rec.company || rec.name}`);
    return { ok: true, record: t.out(data, rec), history: history(data, t.prefix + record_id).slice(0, 5) };
  }));

  return server;
}

function mount(app) {
  app.post('/mcp', requireMcpAuth, async (req, res) => {
    const server = buildServer({
      userId: req.mcp.account.userId, username: req.mcp.account.username, clientName: req.mcp.clientName,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('mcp', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  // Stateless server: no streams or sessions to open or close
  const notAllowed = (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', requireMcpAuth, notAllowed);
  app.delete('/mcp', requireMcpAuth, notAllowed);
}

module.exports = { mount, buildServer };
