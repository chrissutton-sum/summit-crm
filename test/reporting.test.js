const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'test-reporting-secret-not-for-production';
let account, snapshot;
const calls = [];
require.cache[require.resolve('../src/db')] = { exports: {pool:{query: async (sql, args) => {
  calls.push(sql);
  if (sql.includes('FROM crm_data')) return {rows:[{data:snapshot,updated_at:'2026-11-04T00:00:00Z'}]};
  const matches = sql.includes('username =') ? args[0] === account?.username : args[0] === account?.id;
  return {rows:matches ? [account] : []};
}}}};
const { mount, buildReport } = require('../src/reporting');
const { requireAuth, signToken } = require('../src/auth');

test('current reports retain unassigned/former owners, custom stages, numeric strings and date boundaries', () => {
  const report = buildReport({
    users:[{id:'u1',name:'Pat'},{id:'u2',name:'Pat'}], cfg:{stages:['Working','Success','Lost']},
    leads:[{owner:'u1'},{owner:'former'},{owner:null}],
    deals:[{owner:'u1',stage:'Working',amount:'1200.50'},{owner:'u1',stage:'Success',amount:350},{owner:'u2',stage:'Lost',amount:900}],
    tasks:[{owner:'u1',done:true},{owner:'u1',due:'2026-11-02'},{owner:'u1',due:'2026-11-03'}],
    acts:[{owner:'u1',type:'Call',done:true},{owner:'u1',type:'Call',done:false}],
    deliv:[{owner:'u1',done:false}],
  },new Date('2026-11-04T01:00:00Z'));
  const pat = report.users.find(user=>user.id==='u1');
  assert.equal(pat.pipeline,1200.5); assert.equal(pat.wonValue,350);
  assert.equal(pat.overdueTasks,1); assert.equal(pat.openTasks,2); assert.equal(pat.doneTasks,1);
  assert.equal(pat.doneCalls,1); assert.equal(pat.openActivities,1); assert.equal(pat.openDeliverables,1);
  assert.equal(report.users.length,4); assert.equal(report.users.find(u=>u.id==='').leads,1);
  assert.equal(buildReport(null).users.length,0);
});

test('reporting authentication, isolation, revocation, schema and failure handling', async t => {
  account = {id:1,username:'admin',password_hash:await bcrypt.hash('correct-password',4),active:true,is_admin:true,user_id:'u1'};
  snapshot = {users:[{id:'u1',name:'Chris',icsUrl:'private',email:'private'}],leads:[{owner:'u1',email:'private'}]};
  const app = express(); app.use(express.json()); mount(app);
  app.get('/normal', requireAuth, (req,res)=>res.json({ok:true}));
  app.put('/normal', requireAuth, (req,res)=>res.json({ok:true}));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url = 'http://127.0.0.1:'+server.address().port;
  const login = (password='correct-password',username='admin') => fetch(url+'/api/reporting/session',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  const initial = await login(); assert.equal(initial.status,200);
  const {token} = await initial.json();
  const get = (path='/api/reporting/users',auth=token,method='GET')=>fetch(url+path,{method,headers:{Authorization:'Bearer '+auth}});
  await t.test('only returns aggregate fields and does not query writes',async()=>{
    const response=await get(); assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const body=await response.json(); assert.equal(body.users[0].leads,1);
    assert.equal(JSON.stringify(body).includes('private'),false);
    assert.ok(calls.every(sql=>sql.startsWith('SELECT')));
  });
  await t.test('scoped token cannot use normal CRM read/write routes',async()=>{
    assert.equal((await get('/normal')).status,401);
    assert.equal((await get('/normal',token,'PUT')).status,401);
    assert.equal((await get('/normal',signToken(account))).status,200);
    assert.equal((await get('/api/reporting/users',signToken(account))).status,401);
  });
  await t.test('rejects expired and tampered tokens',async()=>{
    assert.equal((await get('/api/reporting/users',token+'x')).status,401);
    const expired=jwt.sign({scope:'reports:read',accountId:1},process.env.JWT_SECRET,{audience:'scg-insights',issuer:'summit-crm',expiresIn:-1});
    assert.equal((await get('/api/reporting/users',expired)).status,401);
  });
  await t.test('revokes reporting on demotion and deactivation',async()=>{
    account.is_admin=false; assert.equal((await get()).status,403); assert.equal((await login()).status,401);
    account.is_admin=true;account.active=false;assert.equal((await get()).status,403);assert.equal((await login()).status,401);
    account.active=true;
  });
  await t.test('password changes invalidate sessions',async()=>{
    const old=account.password_hash; account.password_hash=await bcrypt.hash('new-password',4);
    assert.equal((await get()).status,403);account.password_hash=old;
  });
  await t.test('invalid credentials are rejected and throttled',async()=>{
    assert.equal((await login('incorrect')).status,401);
    for(let i=0;i<10;i++) assert.equal((await login('wrong','unknown')).status,401);
    assert.equal((await login('wrong','unknown')).status,429);
  });
});
