import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase, SqliteStore } from './database.js';
import { token, digest, hashPassword, verifyPassword, passwordError, limited } from './security.js';
import { makeMailer } from './mail.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const generic = 'Se o e-mail estiver cadastrado, você receberá um link para redefinir sua senha.';

export async function createApp({ env = process.env, database, sendMail, clock = Date.now } = {}) {
  const production = env.NODE_ENV === 'production';
  const origin = new URL(env.APP_URL || 'http://localhost:3000');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('APP_URL deve conter apenas a origem do aplicativo.');
  if (production && (origin.protocol !== 'https:' || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) throw new Error('Produção exige APP_URL HTTPS e SESSION_SECRET com pelo menos 32 caracteres.');
  const db = database || openDatabase(env.DATABASE_PATH || 'data/mrpag.sqlite');
  const mail = sendMail || makeMailer(env);
  // A development account is seeded only on first run, never reset on startup.
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    if (production && (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || passwordError(env.ADMIN_PASSWORD, env.ADMIN_PASSWORD))) throw new Error('Defina ADMIN_EMAIL e ADMIN_PASSWORD (12 a 128 caracteres) para o primeiro acesso.');
    await db.prepare('INSERT INTO users(name,email,password) VALUES (?,?,?)').run('Administrador', (env.ADMIN_EMAIL || 'admin@mrpag.local').toLowerCase(), await hashPassword(env.ADMIN_PASSWORD || 'MrPag@2026!Inicial'));
  }
  const dummyHash = await hashPassword(token());
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(env.TRUST_PROXY_HOPS));
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'upgrade-insecure-requests': production ? [] : null } } }));
  app.use('/assets', express.static(resolve(root, 'public')));
  app.use('/assets/bootstrap', express.static(resolve(root, 'node_modules/bootstrap/dist/css'), { immutable: true, maxAge: '1d' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  app.set('view engine', 'ejs'); app.set('views', resolve(root, 'views'));
  app.use(session({ name: 'mrpag.sid', secret: env.SESSION_SECRET || token(), store: new SqliteStore(db), resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 2 * 60 * 60 * 1000 } }));
  let nextCleanup = 0;
  app.use((req, res, next) => {
    if (Date.now() >= nextCleanup) {
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
      db.prepare('DELETE FROM resets WHERE expires<=?').run(clock());
      db.prepare('DELETE FROM attempts WHERE expires<=?').run(Date.now());
      nextCleanup = Date.now() + 600000;
    }
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    req.session.csrf ||= token();
    res.locals.csrf = req.session.csrf;
    const account = req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null;
    res.locals.user = account && req.session.version === digest(account.password) ? account : null;
    res.locals.error = null; res.locals.success = null; res.locals.email = ''; res.locals.resetToken = '';
    if (req.method === 'POST' && (typeof req.body._csrf !== 'string' || req.body._csrf !== req.session.csrf)) return res.status(403).render('auth', { page: 'error', error: 'Sua sessão expirou. Recarregue a página e tente novamente.' });
    next();
  });
  const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
  const login = async (req, id, remember = false) => { await regenerate(req); req.session.userId = id; req.session.version = digest(db.prepare('SELECT password FROM users WHERE id=?').get(id).password); req.session.csrf = token(); req.session.cookie.maxAge = (remember ? 30 * 24 : 2) * 3600000; };
  const requireAuth = (req, res, next) => res.locals.user ? next() : res.redirect('/login');
  const show = (res, page, values = {}, status = 200) => res.status(status).render('auth', { page, ...values });
  app.get('/', (req, res) => res.redirect(res.locals.user ? '/app' : '/login'));
  app.get('/login', (req, res) => res.locals.user ? res.redirect('/app') : show(res, 'login', { success: req.query.reset === '1' ? 'Senha redefinida. Entre com sua nova senha.' : null }));
  app.post('/login', async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (limited(db, `login-ip:${req.ip}`, 30) || limited(db, `login-email:${email}`, 10)) return show(res, 'login', { error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.', email }, 429);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const valid = await verifyPassword(password.slice(0, 1024), user?.password || dummyHash);
    if (!user || !valid || password.length > 128) return show(res, 'login', { error: 'E-mail ou senha incorretos.', email }, 422);
    db.prepare('DELETE FROM attempts WHERE key=?').run(digest(`login-email:${email}`));
    await login(req, user.id, req.body.remember === 'on');
    res.redirect(user.must_change ? '/account/password' : '/app');
  });
  app.post('/logout', requireAuth, (req, res, next) => req.session.destroy(error => { if (error) return next(error); res.clearCookie('mrpag.sid'); res.redirect('/login'); }));
  app.get('/forgot-password', (req, res) => show(res, 'forgot'));
  app.post('/forgot-password', async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    if (limited(db, `forgot-ip:${req.ip}`, 10) || limited(db, `forgot-email:${email}`, 3)) return show(res, 'forgot', { success: generic });
    const user = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (user) {
      const resetToken = token();
      db.prepare('DELETE FROM resets WHERE expires<=?').run(clock());
      db.prepare('INSERT INTO resets VALUES (?,?,?)').run(digest(resetToken), user.id, clock() + 30 * 60000);
      try { await mail({ email, url: `${origin.origin}/reset-password/${resetToken}` }); }
      catch { db.prepare('DELETE FROM resets WHERE token=?').run(digest(resetToken)); console.error('password_reset_delivery_failed'); }
    }
    show(res, 'forgot', { success: generic });
  });
  const resetRecord = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? db.prepare('SELECT * FROM resets WHERE token=? AND expires>?').get(digest(value), clock()) : null;
  app.get('/reset-password/:token', (req, res) => resetRecord(req.params.token) ? show(res, 'reset', { resetToken: req.params.token }) : show(res, 'expired', {}, 400));
  app.post('/reset-password/:token', async (req, res) => {
    const value = req.params.token;
    if (limited(db, `reset-ip:${req.ip}`, 20)) return show(res, 'expired', {}, 429);
    if (!resetRecord(value)) return show(res, 'expired', {}, 400);
    const error = passwordError(req.body.password, req.body.confirmation);
    if (error) return show(res, 'reset', { error, resetToken: value }, 422);
    const hash = await hashPassword(req.body.password);
    // Recheck inside the synchronous transaction after asynchronous hashing (single use under concurrency).
    db.exec('BEGIN IMMEDIATE');
    try {
      const record = resetRecord(value);
      if (!record) { db.exec('ROLLBACK'); return show(res, 'expired', {}, 400); }
      db.prepare('UPDATE users SET password=?,must_change=0,password_changed_at=? WHERE id=?').run(hash, clock(), record.user_id);
      db.prepare('DELETE FROM resets WHERE user_id=?').run(record.user_id);
      db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.userId')=?").run(record.user_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await regenerate(req); res.redirect('/login?reset=1');
  });
  app.get('/app', requireAuth, (req, res) => res.locals.user.must_change ? res.redirect('/account/password') : res.render('dashboard'));
  app.get('/account/password', requireAuth, (req, res) => res.render('password'));
  app.post('/account/password', requireAuth, async (req, res) => {
    if (limited(db, `change:${res.locals.user.id}`, 10)) return res.status(429).render('password', { error: 'Muitas tentativas. Aguarde 15 minutos.' });
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(res.locals.user.id);
    let error = passwordError(req.body.password, req.body.confirmation);
    if (!error && !await verifyPassword(typeof req.body.current === 'string' ? req.body.current.slice(0, 1024) : '', user.password)) error = 'A senha atual está incorreta.';
    if (!error && await verifyPassword(req.body.password, user.password)) error = 'Escolha uma senha diferente da atual.';
    if (error) return res.status(422).render('password', { error });
    const hash = await hashPassword(req.body.password);
    const changed = db.prepare('UPDATE users SET password=?,must_change=0,password_changed_at=? WHERE id=? AND password=?').run(hash, clock(), user.id, user.password);
    if (!changed.changes) return res.status(409).render('password', { error: 'Sua senha foi alterada em outra sessão. Entre novamente.' });
    db.prepare('DELETE FROM resets WHERE user_id=?').run(user.id);
    db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.userId')=?").run(user.id);
    await login(req, user.id);
    res.redirect('/app?password=updated');
  });
  app.use((req, res) => show(res, 'error', { error: 'Página não encontrada.' }, 404));
  app.use((error, req, res, next) => { console.error('request_failed', error.code || error.name); if (res.headersSent) return next(error); show(res, 'error', { error: 'Não foi possível concluir. Tente novamente em alguns instantes.' }, error.status === 413 ? 413 : 500); });
  app.locals.db = db;
  return app;
}
