import { readFileSync, writeFileSync } from 'node:fs';

const required = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_APP_URL'];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`Configure ${name} no GitHub Actions.`);
}

const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID.trim();
if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(databaseId) ||
    databaseId === '00000000-0000-0000-0000-000000000000') {
  throw new Error('CLOUDFLARE_D1_DATABASE_ID deve ser o UUID do D1 de produção.');
}
const rawUrl = process.env.CLOUDFLARE_APP_URL.trim();
const appUrl = URL.canParse(rawUrl) ? new URL(rawUrl) : null;
if (!appUrl || appUrl.protocol !== 'https:' || rawUrl.replace(/\/$/, '') !== appUrl.origin ||
    /localhost|seu-subdominio|127\.0\.0\.1|\[::1\]/i.test(appUrl.hostname)) {
  throw new Error('CLOUDFLARE_APP_URL deve conter a origem HTTPS publicada do MR Pag.');
}

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const database = config.d1_databases.find(binding => binding.binding === 'DB');
if (!database) throw new Error('Binding DB ausente em wrangler.jsonc.');
database.database_id = databaseId;
config.keep_vars = true;
config.vars.APP_URL = appUrl.origin;
// A configuração de e-mail da produção continua no Worker.
delete config.vars.MAIL_MODE;
writeFileSync('wrangler.production.generated.json', JSON.stringify(config, null, 2) + '\n');
