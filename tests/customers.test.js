import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, agent, post, login, initial, csrf } from './helpers.js';
import { hashPassword, token, digest } from '../src/security.js';
const payload = { name:'Maria Cliente',person_type:'person',document:'529.982.247-25',email:'maria@example.com',phone:'(43) 99999-0000',active:'1',postal_code:'86010-000',city:'Londrina',state:'PR',notes:'Contato preferencial à tarde.' };
async function setup(t) {
  const f=await fixture();t.after(()=>f.mf.dispose());
  await f.db.prepare('UPDATE users SET must_change=0').run();
  await login(f.agent);return f;
}
async function second(f) {
  await f.db.prepare("INSERT INTO accounts(id,name,created_at,updated_at) VALUES (2,'Segunda conta',0,0)").run();
  await f.db.prepare("INSERT INTO users(id,name,email,password,version,must_change,account_id) SELECT 2,'Outro usuário','second@example.com',password,?,0,2 FROM users WHERE id=1").bind(token()).run();
  const a=agent(f.mf);
  assert.equal((await post(a,'/login','/login',{email:'second@example.com',password:initial})).status,303);
  return a;
}
test('customer lifecycle: create, normalize, read, edit, filter and deactivate/reactivate', async t=>{
  const {agent:a,db}=await setup(t);
  const created=await post(a,'/customers/new','/customers',payload);assert.equal(created.status,303);
  const path=created.headers.get('location').split('?')[0];
  const row=await db.prepare('SELECT * FROM customers').first();
  assert.equal(row.account_id,1);assert.equal(row.document,'52998224725');assert.equal(row.phone,'43999990000');
  assert.match((await a.request(path)).text,/Maria Cliente/);
  const edit=await post(a,`${path}/edit`,`${path}/update`,{...payload,name:'Maria Atualizada',document:'',notes:'Nova observação'});assert.equal(edit.status,303);
  const list=await a.request('/customers?q=Maria&status=1');assert.match(list.text,/Maria Atualizada/);
  assert.equal((await a.request('/customers?q=Ausente')).text.includes('Maria Atualizada'),false);
  assert.equal((await post(a,path,`${path}/status`,{active:'0'})).status,303);
  assert.equal((await db.prepare('SELECT active FROM customers').first()).active,0);
  assert.equal((await a.request('/customers?status=1')).text.includes('Maria Atualizada'),false);
  assert.match((await a.request('/customers?status=0')).text,/Maria Atualizada/);
  assert.equal((await post(a,path,`${path}/status`,{active:'1'})).status,303);
});
test('account ownership is enforced for list, detail, edit, update, status and forged account_id', async t=>{
  const f=await setup(t), a=f.agent, b=await second(f);
  const created=await post(a,'/customers/new','/customers',payload), path=created.headers.get('location').split('?')[0];
  assert.equal((await b.request('/customers')).text.includes(payload.name),false);
  for(const suffix of ['', '/edit']) assert.equal((await b.request(path+suffix)).status,404);
  // Valid CSRF for the other tenant still cannot authorize a foreign record.
  for(const [suffix,body] of [['/update',{...payload,name:'INVASÃO',account_id:'2'}],['/status',{active:'0',account_id:'2'}]]) {
    assert.equal((await post(b,'/customers',path+suffix,body)).status,404);
  }
  const row=await f.db.prepare('SELECT * FROM customers WHERE account_id=1').first();assert.equal(row.name,payload.name);assert.equal(row.active,1);
  // Same document is allowed in a separate account; a submitted account_id is ignored.
  const own=await post(b,'/customers/new','/customers',{...payload,name:'Cliente de B',account_id:'1'});assert.equal(own.status,303);
  assert.equal((await f.db.prepare("SELECT account_id FROM customers WHERE name='Cliente de B'").first()).account_id,2);
  assert.equal((await a.request('/customers')).text.includes('Cliente de B'),false);
  const counts=await a.request('/customers?q=Cliente');assert.match(counts.text,/<strong>1<\/strong> cliente/);
  await post(b,'/account','/account',{name:'Conta B alterada',account_id:'1'});
  assert.notEqual((await f.db.prepare('SELECT name FROM accounts WHERE id=1').first()).name,'Conta B alterada');
  assert.equal((await f.db.prepare('SELECT name FROM accounts WHERE id=2').first()).name,'Conta B alterada');
});
test('document uniqueness is account scoped, validations preserve fields, output is escaped', async t=>{
  const {agent:a,db}=await setup(t);
  assert.equal((await post(a,'/customers/new','/customers',payload)).status,303);
  const duplicate=await post(a,'/customers/new','/customers',payload);assert.equal(duplicate.status,422);assert.match(duplicate.text,/já está cadastrado na sua conta/);
  for(const invalid of [{name:'X'},{document:'11111111111'},{email:'invalid'},{postal_code:'123'},{phone:'abc'},{state:'ZZ'},{active:'9'},{notes:'X'.repeat(2001)}]) {
    const r=await post(a,'/customers/new','/customers',{...payload,document:'',...invalid});assert.equal(r.status,422);
  }
  const html='<script>alert(1)</script>';
  const xss=await post(a,'/customers/new','/customers',{...payload,name:html,notes:html,document:''});assert.equal(xss.status,303);
  const detail=await a.request(xss.headers.get('location'));assert.ok(!detail.text.includes(html));assert.match(detail.text,/&lt;script&gt;/);
  assert.equal((await db.prepare('SELECT count(*) n FROM customers').first()).n,2);
  assert.equal((await a.request('/customers?q=%25')).text.includes('Maria Cliente'),false);
});
test('pagination never includes another account and formatted document search works',async t=>{
  const f=await setup(t),b=await second(f);
  const statements=[];
  for(let i=0;i<22;i++)statements.push(f.db.prepare("INSERT INTO customers(account_id,name,person_type,created_at,updated_at) VALUES (1,?,'person',0,0)").bind(`Cliente ${String(i).padStart(2,'0')}`));
  await f.db.batch(statements);
  await post(b,'/customers/new','/customers',{...payload,name:'Cliente privado'});
  const page=await f.agent.request('/customers');assert.match(page.text,/Página 1 de 2/);assert.ok(!page.text.includes('Cliente 20'));assert.ok(!page.text.includes('Cliente privado'));
  assert.match((await f.agent.request('/customers?page=2')).text,/Cliente 20/);
  assert.match((await f.agent.request('/customers?page=999')).text,/Página 2 de 2/);
  await post(f.agent,'/customers/new','/customers',payload);
  assert.match((await f.agent.request('/customers?q=529.982.247-25')).text,/Maria Cliente/);
});
test('customer and account mutations require authentication, CSRF and initial password change',async t=>{
  const f=await fixture();t.after(()=>f.mf.dispose());const a=f.agent;
  assert.equal((await a.request('/customers')).headers.get('location'),'/login');
  await login(a);assert.equal((await a.request('/customers')).headers.get('location'),'/account/password');
  const r=await post(a,'/account/password','/customers',payload);assert.equal(r.headers.get('location'),'/account/password');
  await f.db.prepare('UPDATE users SET must_change=0').run();
  const rejected=await a.request('/customers',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(payload).toString()});assert.equal(rejected.status,403);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM customers').first()).n,0);
});
test('changing account assignment invalidates old sessions without changing password',async t=>{
  const f=await setup(t);await second(f);
  await f.db.prepare('UPDATE users SET account_id=2 WHERE id=1').run();
  assert.equal((await f.agent.request('/customers')).headers.get('location'),'/login');
  assert.equal((await login(f.agent)).status,303);
  assert.match((await f.agent.request('/account')).text,/Segunda conta/);
});
test('upgrade migrates existing users and sessions without sharing accounts or resetting credentials',async t=>{
  let hash,version,raw=token();
  const f=await fixture({beforeAccounts:async db=>{
    hash=await hashPassword(initial,'test-pepper-with-at-least-32-characters');version=token();
    await db.prepare("INSERT INTO users(id,name,email,password,version,must_change) VALUES (1,'Legado','admin@mrpag.local',?,?,0)").bind(hash,version).run();
    await db.prepare("INSERT INTO users(id,name,email,password,version) VALUES (7,'Outro legado','legacy@example.com',?,?)").bind(hash,token()).run();
    await db.prepare('INSERT INTO sessions(token,user_id,version,csrf,expires) VALUES (?,1,?,?,?)').bind(await digest(raw),version,token(),Date.now()+60000).run();
  }});t.after(()=>f.mf.dispose());
  const users=(await f.db.prepare('SELECT id,account_id,password FROM users ORDER BY id').all()).results;
  assert.deepEqual(users.map(u=>[u.id,u.account_id]),[[1,1],[7,7]]);assert.equal(users[0].password,hash);
  const response=await f.mf.dispatchFetch('http://localhost:8787/account',{headers:{Cookie:`mrpag.sid=${raw}`}});assert.equal(response.status,200);
  assert.match(await response.text(),/Conta de Legado/);
  await assert.rejects(f.db.prepare('UPDATE users SET account_id=NULL WHERE id=1').run(),/required/);
});

test('concurrent duplicate documents return validation and persist only one customer',async t=>{
  const {agent:a,db}=await setup(t);
  const results=await Promise.all([post(a,'/customers/new','/customers',payload),post(a,'/customers/new','/customers',payload)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[303,422]);
  assert.equal((await db.prepare('SELECT count(*) n FROM customers').first()).n,1);
});
test('company documents validate check digits and missing optional documents can repeat',async t=>{
  const {agent:a,db}=await setup(t);
  const company={...payload,name:'Empresa Ltda',person_type:'company',document:'11.222.333/0001-81'};
  assert.equal((await post(a,'/customers/new','/customers',company)).status,303);
  assert.equal((await post(a,'/customers/new','/customers',{...company,document:'52998224725'})).status,422);
  for(let i=0;i<2;i++)assert.equal((await post(a,'/customers/new','/customers',{...payload,document:'',name:`Sem documento ${i}`})).status,303);
  assert.equal((await db.prepare('SELECT count(*) n FROM customers WHERE document IS NULL').first()).n,2);
});
