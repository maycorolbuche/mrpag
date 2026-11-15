import { digest, token } from './security.js';
import { exchangeMercadoPagoToken, sealCredentials } from './payment-providers.js';

export const oauthCallback = '/account/payments/mercado-pago/callback';
export const oauthConnect = '/account/payments/mercado-pago/connect';
export const oauthWebhook = '/webhooks/mercado-pago/oauth';
const settings = '/account/payments';

export function oauthReady(env, origin) {
  return origin.startsWith('https://') && /^\d+$/.test(env.MERCADO_PAGO_CLIENT_ID || '') &&
    !!env.MERCADO_PAGO_CLIENT_SECRET?.trim() && !!env.MERCADO_PAGO_WEBHOOK_SECRET?.trim() &&
    /^[a-f0-9]{64}$/i.test(env.PAYMENT_INTEGRATION_KEY || '');
}

export async function startMercadoPagoOAuth({ env, db, origin, accountId, sessionHash, redirect, show }) {
  if (!oauthReady(env, origin)) return redirect(`${settings}?oauth=unavailable`);
  const state = token();
  const verifier = token();
  const challengeHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeHash)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM payment_oauth_states WHERE session_token=? OR expires_at<=?').bind(sessionHash, now),
    db.prepare('INSERT INTO payment_oauth_states VALUES (?,?,?,?,?)')
      .bind(await digest(state), sessionHash, accountId, verifier, now + 10 * 60_000),
  ]);

  const authorization = new URL('https://auth.mercadopago.com/authorization');
  authorization.search = new URLSearchParams({
    client_id: env.MERCADO_PAGO_CLIENT_ID,
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: origin + oauthCallback,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return show('payment-authorize', { authorizationUrl: authorization.href });
}

async function integrationId(accountId, collectorId, liveMode) {
  const hash = await digest(`mercado-pago-oauth:${accountId}:${collectorId}:${liveMode}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function finishMercadoPagoOAuth({ env, db, url, origin, accountId, sessionHash, redirect }) {
  const result = status => redirect(`${settings}?oauth=${status}`);
  if (!oauthReady(env, origin)) return result('unavailable');
  const state = url.searchParams.get('state');
  if (!/^[a-f0-9]{64}$/.test(state || '')) return result('expired');
  const attempt = await db.prepare(`DELETE FROM payment_oauth_states
    WHERE state_hash=? AND session_token=? AND account_id=? AND expires_at>? RETURNING verifier`)
    .bind(await digest(state), sessionHash, accountId, Date.now()).first();
  if (!attempt) return result('expired');
  if (url.searchParams.has('error')) return result('denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 1024) return result('failed');

  try {
    const grant = await exchangeMercadoPagoToken(env, {
      grant_type: 'authorization_code', code, redirect_uri: origin + oauthCallback, code_verifier: attempt.verifier,
    }, env.MERCADO_PAGO_OAUTH_MODE !== 'test');
    const id = await integrationId(accountId, grant.collectorId, grant.liveMode);
    const credentials = await sealCredentials(env, id, grant);
    const now = Date.now();
    const [saved] = await db.batch([
      db.prepare(`INSERT INTO payment_integrations(id,account_id,provider,credentials,created_at,oauth_collector_id,oauth_live_mode)
        VALUES (?,?,'mercado-pago',?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET credentials=excluded.credentials, oauth_refresh_until=0
        WHERE payment_integrations.oauth_refresh_until<=excluded.created_at`)
        .bind(id, accountId, credentials, now, grant.collectorId, Number(grant.liveMode)),
      db.prepare(`INSERT INTO payment_integration_defaults(account_id,integration_id)
        SELECT account_id,id FROM payment_integrations WHERE id=? AND account_id=? AND credentials=?
        ON CONFLICT(account_id) DO UPDATE SET integration_id=excluded.integration_id`).bind(id, accountId, credentials),
    ]);
    return result(saved.meta.changes === 1 ? 'connected' : 'busy');
  } catch (error) {
    console.error(JSON.stringify({ event: 'mercado_pago_oauth_failed', provider_status: error.statusCode || null }));
    return result('failed');
  }
}
