import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, agent, post, login, csrf, initial, personal } from './helpers.js';
import { digest, limited } from '../src/security.js';
async function setup(t) { const f = await fixture(); t.after(() => f.mf.dispose()); return f; }

test('Worker serves pages, assets, security headers, private routes and CSRF', async t => {
  const { agent: a } = await setup(t);
  const protectedPage = await a.request('/app'); assert.equal(protectedPage.status, 303); assert.equal(protectedPage.headers.get('location'), '/login');
  const page = await a.request('/login'); assert.equal(page.status, 200); assert.match(page.text, /Bom ter você aqui/);
  assert.match(page.headers.get('set-cookie'), /HttpOnly/); assert.match(page.headers.get('set-cookie'), /SameSite=Lax/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await a.request('/register')).status, 404);
  assert.equal((await a.request('/assets/bootstrap/bootstrap.min.css')).status, 200);
  const rejected = await a.request('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=admin%40mrpag.local' }); assert.equal(rejected.status, 403);
  const crossOrigin = await a.request('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }, body: new URLSearchParams({ _csrf: csrf(page) }).toString() }); assert.equal(crossOrigin.status, 403);
});
test('login rotates session, requires initial password change, validates and logs out', async t => {
  const { agent: a, db } = await setup(t);
  assert.notEqual((await db.prepare('SELECT password FROM users').first()).password, initial);
  const before = await a.request('/login');
  assert.equal((await login(a, 'wrong')).status, 422);
  const result = await login(a); assert.equal(result.status, 303); assert.equal(result.headers.get('location'), '/account/password');
  assert.notEqual(before.headers.get('set-cookie'), result.headers.get('set-cookie'));
  assert.equal((await a.request('/app')).headers.get('location'), '/account/password');
  for (const values of [ { current: initial, password: 'short', confirmation: 'short' }, { current: 'wrong', password: personal, confirmation: personal }, { current: initial, password: personal, confirmation: 'wrong' } ]) {
    assert.equal((await post(a, '/account/password', '/account/password', values)).status, 422);
  }
  assert.equal((await post(a, '/account/password', '/account/password', { current: initial, password: personal, confirmation: personal })).status, 303);
  assert.equal((await a.request('/app')).status, 200);
  assert.equal((await post(a, '/account/password', '/logout', {})).status, 303);
  assert.equal((await a.request('/app')).headers.get('location'), '/login');
  assert.equal((await login(a, initial)).status, 422); assert.equal((await login(a, personal)).status, 303);
});
test('D1 recovery expires, hashes tokens, uses configured origin and revokes sessions', async t => {
  const { agent: a, mf, db, messages } = await setup(t); await login(a);
  const guest = agent(mf);
  const known = await post(guest, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  const unknown = await post(guest, '/forgot-password', '/forgot-password', { email: 'unknown@example.com' });
  for (const r of [known, unknown]) assert.match(r.text, /Se o e-mail estiver cadastrado/);
  assert.equal(messages.length, 1);
  const link = messages[0].text.match(/http:\/\/localhost:8787\/reset-password\/[a-f0-9]+/)[0];
  const path = new URL(link).pathname, raw = path.split('/').at(-1);
  assert.equal((await db.prepare('SELECT token FROM resets').first()).token, await digest(raw));
  await db.prepare('UPDATE resets SET expires=0').run();
  assert.equal((await guest.request(path)).status, 400);
  await post(guest, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  const next = new URL(messages.at(-1).text.match(/http:\/\/localhost:8787\/reset-password\/[a-f0-9]+/)[0]).pathname;
  assert.equal((await post(guest, next, next, { password: personal, confirmation: personal })).status, 303);
  assert.equal((await guest.request(next)).status, 400);
  assert.equal((await a.request('/account/password')).headers.get('location'), '/login');
  assert.equal((await login(guest, personal)).status, 303);
});
test('D1 batch enforces one-time recovery under concurrent submissions', async t => {
  const { agent: a, mf, messages } = await setup(t);
  await post(a, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  const path = new URL(messages[0].text.match(/http:\/\/localhost:8787\/reset-password\/[a-f0-9]+/)[0]).pathname;
  const one = agent(mf), two = agent(mf);
  const results = await Promise.all([post(one, path, path, { password: personal, confirmation: personal }), post(two, path, path, { password: personal, confirmation: personal })]);
  assert.deepEqual(results.map(r => r.status).sort(), [303, 400]);
});
test('password change revokes other sessions and pending links', async t => {
  const { agent: a, mf, messages } = await setup(t); const b = agent(mf);
  await login(a); await login(b);
  await post(a, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  assert.equal((await post(a, '/account/password', '/account/password', { current: initial, password: personal, confirmation: personal })).status, 303);
  assert.equal((await b.request('/account/password')).headers.get('location'), '/login');
  const path = new URL(messages[0].text.match(/http:\/\/localhost:8787\/reset-password\/[a-f0-9]+/)[0]).pathname;
  assert.equal((await a.request(path)).status, 400); assert.equal((await a.request('/app')).status, 200);
});
test('D1 login limits and expired counter windows', async t => {
  const { agent: a, db } = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await login(a, 'wrong')).status, 422);
  assert.equal((await login(a)).status, 429);
  assert.equal(await limited(db, 'test', 1, 1000), false);
  assert.equal(await limited(db, 'test', 1, 1001), true);
  assert.equal(await limited(db, 'test', 1, 901001), false);
});

test('failed mail delivery stays generic and removes unusable reset tokens', async t => {
  const f = await fixture({ failMail: true }); t.after(() => f.mf.dispose());
  const response = await post(f.agent, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  assert.equal(response.status, 200); assert.match(response.text, /Se o e-mail estiver cadastrado/);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM resets').first()).n, 0);
});
test('production rejects local mail mode and missing secrets without leaking them', async t => {
  const f = await fixture({ bindings: { APP_URL: 'https://mrpag.example.com', MAIL_MODE: 'log' } }); t.after(() => f.mf.dispose());
  const result = await f.mf.dispatchFetch('https://mrpag.example.com/login');
  assert.equal(result.status, 500); assert.match(await result.text(), /Referência:/);
  const g = await fixture({ bindings: { PASSWORD_PEPPER: '' } }); t.after(() => g.mf.dispose());
  assert.equal((await g.agent.request('/login')).status, 500);
});
test('Secure cookies in HTTPS, remember TTL and disabled recovery mode', async t => {
  const f = await fixture({ bindings: { APP_URL: 'https://mrpag.example.com', MAIL_MODE: 'disabled' } }); t.after(() => f.mf.dispose());
  const page = await f.mf.dispatchFetch('https://mrpag.example.com/login');
  assert.match(page.headers.get('set-cookie'), /; Secure/);
  const local = await setup(t);
  const response = await post(local.agent, '/login', '/login', { email: 'admin@mrpag.local', password: initial, remember: 'on' });
  assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/);
  const disabled = await fixture({ bindings: { MAIL_MODE: 'disabled' } }); t.after(() => disabled.mf.dispose());
  assert.equal((await post(disabled.agent, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' })).status, 503);
});
test('scheduled cleanup removes expired data and preserves live sessions', async t => {
  const { mf, db, agent: a } = await setup(t);
  await login(a);
  await db.prepare("INSERT INTO sessions(token,csrf,expires) VALUES ('old','old',0)").run();
  await db.prepare("INSERT INTO resets(token,user_id,expires) VALUES ('old',1,0)").run();
  await db.prepare("INSERT INTO attempts(key,count,expires) VALUES ('old',1,0)").run();
  await (await mf.getWorker()).scheduled({ cron: '0 4 * * *' });
  assert.equal((await db.prepare("SELECT count(*) n FROM sessions WHERE token='old'").first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) n FROM resets').first()).n, 0);
  assert.equal((await a.request('/account/password')).status, 200);
});
