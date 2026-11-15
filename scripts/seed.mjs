import { hashPassword, token, passwordError } from '../src/security.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const remote = process.argv.includes('--remote');
const email = (process.env.SEED_EMAIL ?? (remote ? '' : 'admin@mrpag.local')).trim().toLowerCase();
const password = process.env.SEED_PASSWORD ?? (remote ? '' : 'MrPag@2026!Inicial');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || passwordError(password, password)) throw new Error('Defina SEED_EMAIL e SEED_PASSWORD (12 a 128 caracteres).');
if (remote && (password === 'MrPag@2026!Inicial' || email.endsWith('.local'))) throw new Error('No remoto, use e-mail real e senha própria.');
const hash = await hashPassword(password, process.env.PASSWORD_PEPPER);
const sqlString = value => `'${value.replaceAll("'", "''")}'`;
// Bootstrap only an empty database. The same guard covers the account and user.
const now = Date.now();
const sql = `INSERT INTO accounts(id,name,created_at,updated_at)
SELECT 1,'Minha conta',${now},${now}
WHERE NOT EXISTS (SELECT 1 FROM users)
ON CONFLICT DO NOTHING;
INSERT INTO users(id,name,email,password,version,account_id)
SELECT 1,'Administrador',${sqlString(email)},${sqlString(hash)},${sqlString(token())},1
WHERE NOT EXISTS (SELECT 1 FROM users)
ON CONFLICT DO NOTHING;`;
const folder = await mkdtemp(join(tmpdir(), 'mrpag-seed-'));
try {
  const path = join(folder, 'seed.sql');
  await writeFile(path, sql, { mode: 0o600 });
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'mrpag-db', remote ? '--remote' : '--local', '--file', path], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
  else console.log('Seed concluído. Uma conta existente nunca tem sua senha substituída.');
} finally { await rm(folder, { recursive: true, force: true }); }
