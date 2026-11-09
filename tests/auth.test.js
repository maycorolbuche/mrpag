import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { digest } from '../src/security.js';
const initial = 'MrPag@2026!Inicial';
const personal = 'Minha senha pessoal 2026!';
async function fixture(t, options = {}) {
  const database = openDatabase(':memory:'); const messages = [];
  const app = await createApp({ env: { SESSION_SECRET: 'test-session-secret-long-enough-for-tests' }, database, sendMail: async msg => messages.push(msg), ...options });
  t.after(() => database.close());
  return { app, db: database, messages, agent: request.agent(app) };
}
const csrf = response => response.text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
async function post(agent, page, target, data) { const response = await agent.get(page); return agent.post(target).type('form').send({ _csrf: csrf(response), ...data }); }
async function login(agent, password = initial) { return post(agent, '/login', '/login', { email: 'admin@mrpag.local', password }); }

test('guest routes, no registration, CSRF and security headers', async t => {
  const { app, agent } = await fixture(t);
  await agent.get('/app').expect(302).expect('Location', '/login');
  await agent.get('/register').expect(404);
  await agent.post('/login').type('form').send({ email: 'admin@mrpag.local', password: initial }).expect(403);
  const page = await request(app).get('/login').expect(200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers['set-cookie'][0], /HttpOnly/);
  assert.match(page.headers['set-cookie'][0], /SameSite=Lax/);
  await agent.get('/assets/bootstrap/bootstrap.min.css').expect(200);
});
test('login failure, session rotation, mandatory first password, password validation and logout', async t => {
  const { agent, db } = await fixture(t);
  assert.notEqual(db.prepare('SELECT password FROM users').get().password, initial);
  const first = await agent.get('/login');
  const priorCookie = first.headers['set-cookie'][0].split(';')[0];
  assert.equal((await login(agent, 'incorrect')).status, 422);
  const loginPage = await agent.get('/login');
  const result = await agent.post('/login').type('form').send({ _csrf: csrf(loginPage), email: 'admin@mrpag.local', password: initial, remember: 'on' }).expect(302);
  assert.notEqual(priorCookie, result.headers['set-cookie'][0].split(';')[0]);
  assert.match(result.headers['set-cookie'][0], /Expires=/);
  await agent.get('/app').expect(302).expect('Location', '/account/password');
  assert.equal((await post(agent, '/account/password', '/account/password', { current: initial, password: 'short', confirmation: 'short' })).status, 422);
  const wrong = await post(agent, '/account/password', '/account/password', { current: 'wrong', password: personal, confirmation: personal }); assert.equal(wrong.status, 422);
  const mismatch = await post(agent, '/account/password', '/account/password', { current: initial, password: personal, confirmation: 'another' }); assert.equal(mismatch.status, 422);
  const ok = await post(agent, '/account/password', '/account/password', { current: initial, password: personal, confirmation: personal }); assert.equal(ok.status, 302);
  await agent.get('/app').expect(200);
  const page = await agent.get('/account/password');
  await agent.post('/logout').type('form').send({ _csrf: csrf(page) }).expect(302);
  await agent.get('/app').expect(302).expect('Location', '/login');
  assert.equal((await login(agent, initial)).status, 422);
  assert.equal((await login(agent, personal)).status, 302);
});
test('reset generic response, hashed token, expiry, single use and session invalidation', async t => {
  let now = Date.now(); const { app, agent, db, messages } = await fixture(t, { clock: () => now });
  await login(agent);
  const outsider = request.agent(app);
  const known = await post(outsider, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  const unknown = await post(outsider, '/forgot-password', '/forgot-password', { email: 'unknown@example.com' });
  const notice = 'Se o e-mail estiver cadastrado'; assert.ok(known.text.includes(notice)); assert.ok(unknown.text.includes(notice));
  assert.equal(messages.length, 1);
  let path = new URL(messages[0].url).pathname; const raw = path.split('/').at(-1);
  assert.equal(db.prepare('SELECT token FROM resets').get().token, digest(raw));
  now += 31 * 60000;
  await outsider.get(path).expect(400);
  await post(outsider, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  path = new URL(messages.at(-1).url).pathname;
  const bad = await post(outsider, path, path, { password: personal, confirmation: 'wrong' }); assert.equal(bad.status, 422);
  const form = await outsider.get(path);
  const result = await outsider.post(path).type('form').send({ _csrf: csrf(form), password: personal, confirmation: personal }); assert.equal(result.status, 302);
  await outsider.get(path).expect(400);
  await agent.get('/account/password').expect(302).expect('Location', '/login');
  assert.equal((await login(outsider, personal)).status, 302);
  assert.equal(db.prepare('SELECT count(*) n FROM resets').get().n, 0);
});
test('changing password revokes other sessions and outstanding recovery links', async t => {
  const { app, agent, messages } = await fixture(t); const second = request.agent(app);
  await login(agent); await login(second);
  await post(agent, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  await post(agent, '/account/password', '/account/password', { current: initial, password: personal, confirmation: personal });
  await second.get('/account/password').expect(302);
  await agent.get(new URL(messages[0].url).pathname).expect(400);
  await agent.get('/app').expect(200);
});
test('login attempts are limited and mail failure never leaks account existence', async t => {
  const { agent } = await fixture(t, { sendMail: async () => { throw new Error('SMTP unavailable'); } });
  const response = await post(agent, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  assert.equal(response.status, 200); assert.match(response.text, /Se o e-mail estiver cadastrado/);
  for (let i = 0; i < 10; i++) assert.equal((await login(agent, 'bad')).status, 422);
  assert.equal((await login(agent)).status, 429);
});
test('production configuration rejects defaults', async () => {
  await assert.rejects(createApp({ env: { NODE_ENV: 'production' } }), /Produção exige/);
});

test('concurrent recovery submissions consume the token exactly once', async t => {
  const { app, agent, messages } = await fixture(t);
  await post(agent, '/forgot-password', '/forgot-password', { email: 'admin@mrpag.local' });
  const path = new URL(messages[0].url).pathname;
  const a = request.agent(app), b = request.agent(app);
  const [one, two] = await Promise.all([a.get(path), b.get(path)]);
  const results = await Promise.all([
    a.post(path).type('form').send({ _csrf: csrf(one), password: personal, confirmation: personal }),
    b.post(path).type('form').send({ _csrf: csrf(two), password: personal, confirmation: personal }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [302, 400]);
});

test('server restart preserves accounts and sessions without resetting passwords', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'mrpag-test-'));
  const env = { SESSION_SECRET: 'persistent-test-secret-with-32-characters', DATABASE_PATH: join(directory, 'db.sqlite') };
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await createApp({ env, sendMail: async () => {} });
  const agent = request.agent(first);
  await login(agent);
  const result = await post(agent, '/account/password', '/account/password', { current: initial, password: personal, confirmation: personal });
  const cookie = result.headers['set-cookie'][0].split(';')[0];
  first.locals.db.close();
  const second = await createApp({ env, sendMail: async () => {} });
  t.after(() => second.locals.db.close());
  await request(second).get('/app').set('Cookie', cookie).expect(200);
  assert.equal((await login(request.agent(second), initial)).status, 422);
  assert.equal((await login(request.agent(second), personal)).status, 302);
});
