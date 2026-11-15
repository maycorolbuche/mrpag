import { orderIdPattern } from './mercado-pago-orders.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function encryptionKey(env) {
  const secret = env.PAYMENT_INTEGRATION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(secret)) return null;
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g), byte => parseInt(byte, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealCredentials(env, integration, credentials) {
  const key = await encryptionKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(integration) }, key, encoder.encode(JSON.stringify(credentials)));
  return JSON.stringify([btoa(String.fromCharCode(...iv)), btoa(String.fromCharCode(...new Uint8Array(data)))]);
}

export async function openCredentials(env, integration) {
  const key = await encryptionKey(env);
  if (!key) throw new Error('payment_integration_key_missing');
  const [iv, data] = JSON.parse(integration.credentials).map(value => Uint8Array.from(atob(value), char => char.charCodeAt(0)));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(integration.id) }, key, data);
  return JSON.parse(decoder.decode(plain));
}

export class PaymentProviderError extends Error {
  constructor(status) {
    super('payment_provider_request_failed');
    this.statusCode = status;
  }
}

async function requestMercadoPago(token, path, options = {}) {
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PaymentProviderError(response.status);
  }
  return response.json();
}

export async function verifyMercadoPagoToken(token) {
  const user = await requestMercadoPago(token, '/users/me');
  return String(user.id || '');
}

export async function verifySignature(request, paymentId, secret) {
  if (!secret) return false;
  const pieces = new Map((request.headers.get('x-signature') || '').split(',').map(piece => piece.trim().split('=')));
  const ts = pieces.get('ts') || '';
  const signature = pieces.get('v1') || '';
  const requestId = request.headers.get('x-request-id') || '';
  if (!/^\d{10,13}$/.test(ts) || !/^[a-f0-9]{64}$/i.test(signature) || !requestId) return false;
  const timestamp = ts.length === 13 ? Number(ts) : Number(ts) * 1000;
  if (Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) return false;
  const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16)), encoder.encode(manifest));
}

function oauthClient(env, clientId) {
  if (clientId === env.MERCADO_PAGO_CLIENT_ID) {
    return { secret: env.MERCADO_PAGO_CLIENT_SECRET, webhook: env.MERCADO_PAGO_WEBHOOK_SECRET };
  }
  if (clientId && clientId === env.MERCADO_PAGO_LEGACY_CLIENT_ID) {
    return { secret: env.MERCADO_PAGO_LEGACY_CLIENT_SECRET, webhook: env.MERCADO_PAGO_LEGACY_WEBHOOK_SECRET };
  }
  return {};
}

export async function exchangeMercadoPagoToken(env, parameters, liveMode, clientId = env.MERCADO_PAGO_CLIENT_ID) {
  const response = await requestMercadoPago(null, '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: oauthClient(env, clientId).secret,
      ...parameters,
      test_token: !liveMode,
    }),
  });
  const collectorId = String(response.user_id ?? '');
  const expiresIn = Number(response.expires_in);
  if (!/^\d{1,24}$/.test(collectorId) || response.live_mode !== liveMode ||
      !Number.isSafeInteger(expiresIn) || expiresIn <= 0 ||
      typeof response.access_token !== 'string' || !response.access_token ||
      typeof response.refresh_token !== 'string' || !response.refresh_token) {
    throw new Error('invalid_payment_oauth_grant');
  }
  return {
    token: response.access_token, refreshToken: response.refresh_token, collectorId, liveMode,
    expiresAt: Date.now() + expiresIn * 1000, clientId,
  };
}

async function refreshCredentials(env, integration, credentials) {
  if (!oauthClient(env, credentials.clientId).secret) {
    throw new Error('payment_oauth_reconnect');
  }
  const now = Date.now();
  const lock = now + 30_000;
  const db = env.DB;
  const acquired = await db.prepare(`UPDATE payment_integrations SET oauth_refresh_until=?
    WHERE id=? AND credentials=? AND oauth_refresh_until<=? RETURNING id`)
    .bind(lock, integration.id, integration.credentials, now).first();
  if (!acquired) {
    const updated = await db.prepare('SELECT * FROM payment_integrations WHERE id=?').bind(integration.id).first();
    if (updated.credentials !== integration.credentials) {
      const current = await openCredentials(env, updated);
      if (current.expiresAt > Date.now()) return current;
    }
    if (credentials.expiresAt > Date.now()) return credentials;
    throw new Error('payment_oauth_refresh_busy');
  }

  try {
    const refreshed = await exchangeMercadoPagoToken(env, {
      grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
    }, credentials.liveMode, credentials.clientId);
    if (refreshed.collectorId !== credentials.collectorId) throw new Error('invalid_payment_oauth_grant');
    const encrypted = await sealCredentials(env, integration.id, refreshed);
    await db.prepare(`UPDATE payment_integrations SET credentials=?
      WHERE id=? AND credentials=? AND oauth_refresh_until=?`)
      .bind(encrypted, integration.id, integration.credentials, lock).run();
    return refreshed;
  } catch (error) {
    if (credentials.expiresAt > Date.now()) return credentials;
    if ([400, 401, 403].includes(error.statusCode)) throw new Error('payment_oauth_reconnect');
    throw error;
  } finally {
    await db.prepare('UPDATE payment_integrations SET oauth_refresh_until=0 WHERE id=? AND oauth_refresh_until=?')
      .bind(integration.id, lock).run();
  }
}

export async function paymentProvider(env, integration, api = 'payments') {
  if (integration.provider !== 'mercado-pago') throw new Error('unsupported_payment_provider');
  let credentials = await openCredentials(env, integration);
  if (integration.oauth_collector_id && credentials.expiresAt <= Date.now() + 60_000) {
    credentials = await refreshCredentials(env, integration, credentials);
  }
  const webhookSecret = integration.oauth_collector_id
    ? oauthClient(env, credentials.clientId).webhook : credentials.webhookSecret;
  const orders = api === 'orders';
  const endpoint = orders ? '/v1/orders' : '/v1/payments';
  const idPattern = orders ? orderIdPattern : /^\d{1,24}$/;
  return {
    create(charge) {
      return requestMercadoPago(credentials.token, endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': charge.id },
        body: charge.provider_payload,
      });
    },
    get(id) {
      if (!idPattern.test(id)) throw new Error('invalid_provider_payment_id');
      return requestMercadoPago(credentials.token, `${endpoint}/${id}`);
    },
    verify(request, id) {
      return verifySignature(request, id, webhookSecret);
    },
    collectorId: credentials.collectorId,
  };
}
