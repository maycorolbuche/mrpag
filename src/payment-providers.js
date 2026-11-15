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

async function openCredentials(env, integration) {
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
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
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

async function verifySignature(request, paymentId, secret) {
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

export async function paymentProvider(env, integration) {
  if (integration.provider !== 'mercado-pago') throw new Error('unsupported_payment_provider');
  const credentials = await openCredentials(env, integration);
  return {
    create(charge) {
      return requestMercadoPago(credentials.token, '/v1/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': charge.id },
        body: charge.provider_payload,
      });
    },
    get(id) {
      if (!/^\d{1,24}$/.test(id)) throw new Error('invalid_provider_payment_id');
      return requestMercadoPago(credentials.token, `/v1/payments/${id}`);
    },
    verify(request, id) {
      return verifySignature(request, id, credentials.webhookSecret);
    },
    collectorId: credentials.collectorId,
  };
}
