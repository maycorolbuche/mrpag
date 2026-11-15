import { notificationSettings, queueChargeReminders } from './charge-notifications.js';
import { dispatchRecurringCharges, recurringRoutes } from './recurring-charges.js';
import { dispatchChargeEmails } from './charge-emails.js';
import { render } from './generated/templates.js';
import { token, digest, hashPassword, verifyPassword, passwordError, limited } from './security.js';
import { mailSendingEnabled, sendRecovery } from './mail.js';
import { customerRoutes } from './customers.js';
import { paymentRoutes, paymentWebhook, publicPayment, publicPaymentStatus, refreshChargePayment } from './payments.js';

const generic = 'Se o e-mail estiver cadastrado, você receberá um link para redefinir sua senha.';
const dummy = `pbkdf2-sha256:100000:${'0'.repeat(64)}:${'0'.repeat(64)}`;
const cookieName = 'mrpag.sid';
const securityHeaders = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function configuration(env, request) {
  if (!env.DB) throw new Error('Binding DB não configurado.');
  if (!env.PASSWORD_PEPPER || env.PASSWORD_PEPPER.length < 32) throw new Error('Configure o secret PASSWORD_PEPPER (mínimo 32 caracteres).');
  const url = new URL(env.APP_URL);
  const requestUrl = new URL(request.url);
  const local = ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['localhost', '127.0.0.1', '[::1]'].includes(requestUrl.hostname);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password || (!local && url.protocol !== 'https:') || url.hostname.includes('seu-subdominio')) throw new Error('Configure APP_URL com a origem pública HTTPS do aplicativo.');
  if (env.MAIL_MODE === 'log' && !local) throw new Error('MAIL_MODE=log só é permitido em localhost.');
  return { origin: url.origin, secure: url.protocol === 'https:' };
}
async function bodyOf(request, maxSize = 8192) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw Object.assign(new Error('Formato de formulário inválido.'), { status: 415 });
  const reader = request.body?.getReader();
  let size = 0; const chunks = [];
  if (reader) {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxSize) { await reader.cancel(); throw Object.assign(new Error('Formulário muito grande.'), { status: 413 }); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(bytes)));
}
async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path.startsWith('/assets/')) return env.ASSETS.fetch(request);
  const config = configuration(env, request), db = env.DB;
  if (path.startsWith('/webhooks/mercado-pago/')) return paymentWebhook(request, env, url);
  const cookies = [];
  const responseHeaders = () => {
    const headers = new Headers(securityHeaders);
    if (config.secure) headers.set('Strict-Transport-Security', 'max-age=31536000');
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return headers;
  };
  if (path.startsWith('/pay/')) {
    const headers = responseHeaders();
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    if (request.method !== 'GET') return new Response(null, { status: 405, headers });
    if (path.endsWith('/status')) {
      const status = await publicPaymentStatus(db, path.slice('/pay/'.length, -'/status'.length));
      return Response.json({ status }, { status: status ? 200 : 404, headers });
    }
    const charge = await publicPayment(db, path.slice('/pay/'.length));
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(render('public-payment', { charge }), { status: charge ? 200 : 404, headers });
  }
  const cookie = (value, seconds) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secure ? '; Secure' : ''}`;
  const redirect = target => { const headers = responseHeaders(); headers.set('Location', target); return new Response(null, { status: 303, headers }); };
  let user = null, account = null, session = null, sessionHash = null;
  const rawCookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (/^[a-f0-9]{64}$/.test(rawCookie || '')) {
    sessionHash = await digest(rawCookie);
    session = await db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').bind(sessionHash, Date.now()).first();
    if (session?.user_id) {
      user = await db.prepare('SELECT u.* FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.id=? AND u.version=? AND u.account_id=?').bind(session.user_id, session.version, session.account_id).first();
      if (user) account = await db.prepare('SELECT id,name FROM accounts WHERE id=?').bind(user.account_id).first();
      if (!user) session = null;
    }
  }
  const show = (name, values = {}, status = 200) => {
    const headers = responseHeaders(); headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(render(name, { csrf: session?.csrf || '', user, account, currentPath: path, saved: url.searchParams.get('saved') === '1', error: null, success: null, email: '', resetToken: '', ...values }), { status, headers });
  };
  const auth = (page, values = {}, status = 200) => show('auth', { page, ...values }, status);
  async function rotate(account, remember = false) {
    const raw = token(), csrf = token(), now = Date.now();
    const seconds = account ? (remember ? 30 * 86400 : 7200) : 1800;
    const hashed = await digest(raw);
    const statements = [];
    if (sessionHash) statements.push(db.prepare('DELETE FROM sessions WHERE token=?').bind(sessionHash));
    statements.push(db.prepare('INSERT INTO sessions(token,user_id,version,csrf,expires,account_id) VALUES (?,?,?,?,?,?)')
      .bind(hashed, account?.id || null, account?.version || null, csrf, now + seconds * 1000, account?.account_id || null));
    await db.batch(statements);
    session = { token: hashed, csrf }; sessionHash = hashed;
    cookies.push(cookie(raw, seconds));
  }
  if (request.method !== 'GET' && request.method !== 'POST') return auth('error', { error: 'Método não permitido.' }, 405);
  let body = {};
  if (request.method === 'POST') {
    body = await bodyOf(request, path === '/customers' || path.startsWith('/customers/') ? 32768 : 8192);
    const origin = request.headers.get('origin');
    if ((origin && origin !== config.origin) || !session || body._csrf !== session.csrf) return auth('error', { error: 'Sua sessão expirou. Recarregue a página e tente novamente.' }, 403);
  }
  const isPaymentRoute = path === '/account/payments' || path.startsWith('/account/payments/mercado-pago/') || path === '/charges' || path.startsWith('/charges/');
  const protectedRoute = isPaymentRoute || ['/app', '/account', '/account/password', '/account/notifications', '/logout'].includes(path) || path === '/customers' || path.startsWith('/customers/');
  if (protectedRoute && !user) return redirect('/login');
  if (protectedRoute && user.must_change && !['/account/password','/logout'].includes(path)) return redirect('/account/password');
  if (path === '/' && request.method === 'GET') return redirect(user ? '/app' : '/login');
  if (path === '/login' && request.method === 'GET' && user) return redirect('/app');
  const resetMatch = path.match(/^\/reset-password\/([a-f0-9]{64})$/);
  if (!session && request.method === 'GET' && (['/login', '/forgot-password'].includes(path) || resetMatch)) await rotate(null);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const email = (body.email || '').trim().toLowerCase().slice(0, 254);
  if (path === '/login') {
    if (request.method === 'GET') return auth('login', { success: url.searchParams.get('reset') === '1' ? 'Senha redefinida. Entre com sua nova senha.' : null });
    if (await limited(db, `login-ip:${ip}`, 30) || await limited(db, `login-email:${email}`, 10)) return auth('login', { error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.', email }, 429);
    const account = await db.prepare('SELECT u.* FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.email=?').bind(email).first();
    const valid = await verifyPassword(body.password || '', account?.password || dummy, env.PASSWORD_PEPPER);
    if (!account || !valid) return auth('login', { error: 'E-mail ou senha incorretos.', email }, 422);
    await db.prepare('DELETE FROM attempts WHERE key=?').bind(await digest(`login-email:${email}`)).run();
    await rotate(account, body.remember === 'on');
    return redirect(account.must_change ? '/account/password' : '/app');
  }
  if (path === '/logout' && request.method === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE token=?').bind(sessionHash).run();
    cookies.push(cookie('', 0)); return redirect('/login');
  }
  if (path === '/forgot-password') {
    if (request.method === 'GET') return auth('forgot');
    if (env.MAIL_MODE === 'disabled' || !env.MAIL_MODE) return auth('forgot', { error: 'A recuperação por e-mail ainda não está configurada neste ambiente. Fale com o administrador.' }, 503);
    if (await limited(db, `forgot-ip:${ip}`, 10) || await limited(db, `forgot-email:${email}`, 3)) return auth('forgot', { success: generic });
    const account = await db.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    if (account) {
      const raw = token(), hashed = await digest(raw);
      await db.prepare('INSERT INTO resets(token,user_id,expires) VALUES (?,?,?)').bind(hashed, account.id, Date.now() + 1800000).run();
      try { await sendRecovery(env, { email, url: `${config.origin}/reset-password/${raw}` }); }
      catch (error) {
        await db.prepare('DELETE FROM resets WHERE token=?').bind(hashed).run();
        console.error(JSON.stringify({ event: 'password_reset_delivery_failed', error_id: crypto.randomUUID(), code: error.message.startsWith('mail_') ? error.message : 'mail_transport_error' }));
      }
    }
    return auth('forgot', { success: generic });
  }
  if (resetMatch) {
    const raw = resetMatch[1], hashed = await digest(raw);
    const record = await db.prepare('SELECT user_id FROM resets WHERE token=? AND expires>?').bind(hashed, Date.now()).first();
    if (!record) return auth('expired', {}, 400);
    if (request.method === 'GET') return auth('reset', { resetToken: raw });
    if (await limited(db, `reset-ip:${ip}`, 20)) return auth('expired', {}, 429);
    const error = passwordError(body.password, body.confirmation);
    if (error) return auth('reset', { error, resetToken: raw }, 422);
    const hash = await hashPassword(body.password, env.PASSWORD_PEPPER), version = token();
    // batch() is atomic. Only the winner receives this unique version; cleanup depends on it.
    const results = await db.batch([
      db.prepare('UPDATE users SET password=?,version=?,must_change=0,password_changed_at=? WHERE id=(SELECT user_id FROM resets WHERE token=? AND expires>?) RETURNING id').bind(hash, version, Date.now(), hashed, Date.now()),
      db.prepare('DELETE FROM resets WHERE user_id=(SELECT id FROM users WHERE version=?)').bind(version),
      db.prepare('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE version=?)').bind(version),
    ]);
    if (!results[0].results.length) return auth('expired', {}, 400);
    await rotate(null); return redirect('/login?reset=1');
  }
  if (path === '/account') {
    if (request.method === 'GET') return show('account');
    const name = (body.name || '').trim();
    if (name.length < 2 || name.length > 120) return show('account', { error: 'Informe um nome para a conta com 2 a 120 caracteres.', account: { ...account, name } }, 422);
    await db.prepare('UPDATE accounts SET name=?,updated_at=? WHERE id=?').bind(name,Date.now(),user.account_id).run();
    return redirect('/account?saved=1');
  }
  if (path === '/account/notifications') {
    return notificationSettings({ request, url, env, db, accountId: user.account_id, actorEmail: user.email, body, show, redirect });
  }
  if (isPaymentRoute) {
    const context = { request, url, db, env, accountId: user.account_id, actorEmail: user.email, origin: config.origin, sessionHash, body, show, redirect };
    const result = path === '/charges/recurring' || path.startsWith('/charges/recurring/')
      ? await recurringRoutes(context) : await paymentRoutes(context);
    if (result) return result;
  }
  if (path === '/customers' || path.startsWith('/customers/')) {
    const result = await customerRoutes({ request, url, db, user, account, body, show, redirect });
    if (result) return result;
  }
  if (path === '/app' && request.method === 'GET') return user.must_change ? redirect('/account/password') : show('dashboard');
  if (path === '/account/password') {
    if (request.method === 'GET') return show('password');
    if (await limited(db, `change:${user.id}`, 10)) return show('password', { error: 'Muitas tentativas. Aguarde 15 minutos.' }, 429);
    let error = passwordError(body.password, body.confirmation);
    if (!error && !await verifyPassword(body.current || '', user.password, env.PASSWORD_PEPPER)) error = 'A senha atual está incorreta.';
    if (!error && await verifyPassword(body.password, user.password, env.PASSWORD_PEPPER)) error = 'Escolha uma senha diferente da atual.';
    if (error) return show('password', { error }, 422);
    const hash = await hashPassword(body.password, env.PASSWORD_PEPPER), version = token();
    const results = await db.batch([
      db.prepare('UPDATE users SET password=?,version=?,must_change=0,password_changed_at=? WHERE id=? AND version=? RETURNING id').bind(hash, version, Date.now(), user.id, user.version),
      db.prepare('DELETE FROM resets WHERE user_id=(SELECT id FROM users WHERE version=?)').bind(version),
      db.prepare('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE version=?)').bind(version),
    ]);
    if (!results[0].results.length) return show('password', { error: 'Sua senha foi alterada em outra sessão. Entre novamente.' }, 409);
    await rotate({ id: user.id, version, account_id: user.account_id }); return redirect('/app?password=updated');
  }
  return auth('error', { error: 'Página não encontrada.' }, 404);
}
export async function cleanup(env) {
  const now = Date.now();
  await env.DB.batch(['sessions', 'resets', 'attempts'].map(table => env.DB.prepare(`DELETE FROM ${table} WHERE expires<=?`).bind(now)));
}
export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (error) {
      const errorId = crypto.randomUUID();
      console.error(JSON.stringify({ event: 'request_failed', error_id: errorId, name: error.name, message: error.message }));
      const status = error.status || 500;
      return new Response(`Não foi possível concluir. Tente novamente em alguns instantes. Referência: ${errorId}`, { status, headers: { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  },
  async scheduled(event, env, ctx) {
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(dispatchRecurringCharges(env));
      if (mailSendingEnabled(env)) {
        const { origin } = configuration(env, new Request('https://scheduled.invalid'));
        ctx.waitUntil(queueChargeReminders(env.DB, new Date(event.scheduledTime))
          .finally(() => dispatchChargeEmails(env, origin, refreshChargePayment)));
      }
    } else {
      ctx.waitUntil(cleanup(env));
    }
  },
};
