import { Miniflare } from 'miniflare';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { hashPassword, token } from '../src/security.js';
const pepper = 'test-pepper-with-at-least-32-characters';
export const initial = 'MrPag@2026!Inicial';
export const personal = 'Minha senha pessoal 2026!';
export async function fixture({ serve = false, bindings = {}, failMail = false } = {}) {
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
  const migration = await readFile('migrations/0001_auth.sql', 'utf8');
  await db.batch(migration.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  await db.prepare('INSERT INTO users(id,name,email,password,version) VALUES (1,?,?,?,?)').bind('Administrador', 'admin@mrpag.local', await hashPassword(initial, pepper), token()).run();
  return { mf, db, messages, agent: agent(mf) };
  } catch(error) { await mf.dispose(); throw error; }
}
export function agent(mf) {
  let cookie = '';
  return { async request(path, init = {}) {
    const response = await mf.dispatchFetch(`http://localhost:8787${path}`, { redirect: 'manual', ...init, headers: { Cookie: cookie, ...init.headers } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, headers: response.headers, text: await response.text() };
  } };
}
export const csrf = page => page.text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
export async function post(agent, page, path, body) {
  const form = await agent.request(page);
  return agent.request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost:8787' }, body: new URLSearchParams({ _csrf: csrf(form), ...body }).toString() });
}
export const login = (a, password = initial) => post(a, '/login', '/login', { email: 'admin@mrpag.local', password });
