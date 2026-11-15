import { Miniflare } from 'miniflare';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { hashPassword, token } from '../src/security.js';
const pepper = 'test-pepper-with-at-least-32-characters';
export const initial = 'MrPag@2026!Inicial';
export const personal = 'Minha senha pessoal 2026!';
export async function fixture({ serve = false, bindings = {}, failMail = false, beforeAccounts, paymentApi } = {}) {
  const messages = [];
  const options = {
    modules: true, modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], scriptPath: 'src/worker.js', compatibilityDate: '2026-08-01',
    d1Databases: ['DB'],
    bindings: { APP_URL: 'http://localhost:8787', PASSWORD_PEPPER: pepper, MAIL_MODE: 'resend', RESEND_API_KEY: 'test-only', MAIL_FROM: 'MR Pag <test@example.com>', ...bindings },
    serviceBindings: { ASSETS: async request => {
      const path = new URL(request.url).pathname.replace(/^\/assets\//, '');
      if (path.includes('..')) return new Response(null, { status: 404 });
      try { return new Response(await readFile(`dist/assets/${path}`), { headers: { 'Content-Type': path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'image/svg+xml' } }); }
      catch { return new Response(null, { status: 404 }); }
    } },
    outboundService: async request => {
      if (paymentApi && new URL(request.url).hostname === 'api.mercadopago.com') return paymentApi(request);
      if (request.url !== 'https://api.resend.com/emails') throw new Error('Unexpected external request');
      messages.push(await request.json());
      if (failMail) return new Response('unavailable', { status: 503 });
      return new Response('{"id":"test"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  if (serve) {
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    options.port = port; options.bindings.APP_URL = `http://127.0.0.1:${port}`;
  }
  const mf = new Miniflare(options);
  try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) {
    if (name.startsWith('0002') && beforeAccounts) await beforeAccounts(db);
    const migration = await readFile(`migrations/${name}`, 'utf8');
    await db.exec(migration.replace(/--[^\n]*/g,'').replace(/\n/g,' '));
  }
  await db.prepare("INSERT INTO accounts(id,name,created_at,updated_at) VALUES (1,'Minha conta',0,0) ON CONFLICT DO NOTHING").run();
  await db.prepare('INSERT INTO users(id,name,email,password,version,account_id) VALUES (1,?,?,?,?,1) ON CONFLICT DO NOTHING').bind('Administrador', 'admin@mrpag.local', await hashPassword(initial, pepper), token()).run();
  return { mf, db, messages, agent: agent(mf, bindings.APP_URL) };
  } catch(error) { await mf.dispose(); throw error; }
}
export function agent(mf, origin = 'http://localhost:8787') {
  let cookie = '';
  return { origin, async request(path, init = {}) {
    const response = await mf.dispatchFetch(`${origin}${path}`, { redirect: 'manual', ...init, headers: { Cookie: cookie, ...init.headers } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, headers: response.headers, text: await response.text() };
  } };
}
export const csrf = page => page.text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
export async function post(agent, page, path, body) {
  const form = await agent.request(page);
  return agent.request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: agent.origin }, body: new URLSearchParams({ _csrf: csrf(form), ...body }).toString() });
}
export const login = (a, password = initial) => post(a, '/login', '/login', { email: 'admin@mrpag.local', password });
