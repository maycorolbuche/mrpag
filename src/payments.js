import { paymentProvider, sealCredentials, verifyMercadoPagoToken, verifySignature } from './payment-providers.js';
import {
  finishMercadoPagoOAuth, oauthCallback, oauthConnect, oauthReady, oauthWebhook, startMercadoPagoOAuth,
} from './mercado-pago-oauth.js';

import { token } from './security.js';
import { businessDate, chargeMoney, displayDueDate, paymentLink, chargeEmailHistory, queueManualChargeEmail } from './charge-emails.js';
import { orderIdPattern, pixOrderPayload, readPixOrder } from './mercado-pago-orders.js';

export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const minutes = 60_000;
export const maximumRetryAge = 15 * minutes;
const statuses = {
  pending: 'pending', in_process: 'pending', authorized: 'pending', in_mediation: 'in_mediation',
  approved: 'paid', cancelled: 'cancelled', rejected: 'rejected', refunded: 'refunded', charged_back: 'charged_back',
};
export const chargeLabels = {
  creating: 'Aguardando emissão', creation_error: 'Emissão não confirmada', pending: 'Aguardando pagamento',
  expired: 'Vencida', paid: 'Paga', cancelled: 'Cancelada', rejected: 'Recusada',
  refunded: 'Estornada', charged_back: 'Contestada', in_mediation: 'Em análise',
};
const route = '/charges';

function present(charge) {
  const status = charge.status === 'pending' && charge.due_date < businessDate(new Date()) ? 'expired' : charge.status;
  return {
    ...charge, status, label: chargeLabels[status], amount: chargeMoney.format(charge.amount_cents / 100),
    date: displayDueDate(charge.due_date),
    canCancel: status === 'pending' && !!charge.provider_id,
    canRetry: !charge.provider_id && Date.now() - charge.created_at <= maximumRetryAge,
  };
}

function webhookUrl(origin, id) {
  return `${origin}/webhooks/mercado-pago/${id}`;
}

export async function currentIntegration(db, accountId) {
  return db.prepare(`SELECT i.id, i.provider, i.oauth_collector_id, i.oauth_live_mode FROM payment_integration_defaults d
    JOIN payment_integrations i ON i.id=d.integration_id AND i.account_id=d.account_id
    WHERE d.account_id=?`).bind(accountId).first();
}

const oauthErrors = {
  unavailable: 'A autorização do Mercado Pago ainda não está configurada neste ambiente.',
  expired: 'A autorização expirou ou já foi usada. Clique em Conectar Mercado Pago para iniciar novamente.',
  denied: 'A autorização do Mercado Pago foi cancelada ou recusada.',
  failed: 'Não foi possível conectar ao Mercado Pago. Tente novamente ou fale com o administrador.',
  busy: 'A conexão está sendo renovada. Aguarde alguns instantes e tente conectar novamente.',
};

async function integrationSettings({ request, url, db, env, accountId, origin, show, redirect, body }) {
  const oauthStatus = url.searchParams.get('oauth');
  const integration = await currentIntegration(db, accountId);
  const formId = request.method === 'GET' ? crypto.randomUUID() : body.integration_id;
  const render = (error = null, status = 200) => show('payment-settings', {
    integration, formId, endpoint: uuid.test(formId || '') ? webhookUrl(origin, formId) : '',
    activeEndpoint: integration ? origin + (integration.oauth_collector_id ? oauthWebhook : `/webhooks/mercado-pago/${integration.id}`) : '',
    oauthReady: oauthReady(env, origin), oauthConnect, manualError: request.method === 'POST' ? error : null,
    error: request.method === 'GET' && Object.hasOwn(oauthErrors, oauthStatus) ? oauthErrors[oauthStatus] : null,
    success: oauthStatus === 'connected' && integration?.oauth_collector_id ? 'Conta do Mercado Pago conectada.' : null,
  }, status);
  if (request.method === 'GET') return render();
  const token = (body.access_token || '').trim();
  const webhookSecret = (body.webhook_secret || '').trim();
  if (!uuid.test(formId || '') || !/^[!-~]{12,512}$/.test(token) || !/^[!-~]{12,512}$/.test(webhookSecret)) {
    return render('Informe o Access Token e a assinatura secreta do webhook.', 422);
  }
  const alreadySaved = await db.prepare('SELECT account_id FROM payment_integrations WHERE id=?').bind(formId).first();
  if (alreadySaved) return alreadySaved.account_id === accountId ? redirect('/account/payments') : render('Recarregue a página e tente novamente.', 409);
  if (!/^[a-f0-9]{64}$/i.test(env.PAYMENT_INTEGRATION_KEY || '')) return render('Configure o secret PAYMENT_INTEGRATION_KEY com 64 caracteres hexadecimais no Worker.', 503);

  let collectorId;
  try {
    collectorId = await verifyMercadoPagoToken(token);
  } catch (error) {
    return render(error.statusCode === 401 || error.statusCode === 403
      ? 'O Mercado Pago recusou o Access Token.'
      : 'Não foi possível validar o Access Token agora. Tente novamente.', 422);
  }
  if (!/^\d+$/.test(collectorId)) return render('Não foi possível identificar a conta do Mercado Pago.', 422);
  const credentials = await sealCredentials(env, formId, { token, webhookSecret, collectorId });
  await db.batch([
    db.prepare(`INSERT INTO payment_integrations(id,account_id,provider,credentials,created_at)
      VALUES (?,?,'mercado-pago',?,?) ON CONFLICT(id) DO NOTHING`).bind(formId, accountId, credentials, Date.now()),
    db.prepare(`INSERT INTO payment_integration_defaults(account_id,integration_id)
      SELECT account_id,id FROM payment_integrations WHERE id=? AND account_id=?
      ON CONFLICT(account_id) DO UPDATE SET integration_id=excluded.integration_id`).bind(formId, accountId),
  ]);
  return redirect('/account/payments');
}

export function formAmount(value) {
  if (!/^\d{1,7}([.,]\d{1,2})?$/.test(value)) return 0;
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function validDueDate(value) {
  const now = new Date();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < businessDate(now)) return false;
  const iso = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(iso.getTime()) || iso.toISOString().slice(0, 10) !== value) return false;
  const expiry = Date.parse(`${value}T23:59:59-03:00`);
  return expiry - now.getTime() >= 31 * minutes && expiry - now.getTime() < 30 * 24 * 60 * minutes;
}

function readPixPayment(payment, charge, provider) {
  const id = String(payment.id || '');
  if (!/^\d{1,24}$/.test(id) || payment.external_reference !== charge.id ||
      payment.payment_method_id !== 'pix' || payment.currency_id !== 'BRL' ||
      Math.round(Number(payment.transaction_amount) * 100) !== charge.amount_cents ||
      String(payment.collector_id ?? '') !== provider.collectorId) {
    throw new Error('payment_provider_data_mismatch');
  }
  const status = payment.status === 'cancelled' && payment.status_detail === 'expired'
    ? 'expired'
    : (Object.hasOwn(statuses, payment.status) ? statuses[payment.status] : 'pending');
  const date = payment.date_last_updated || payment.date_created;
  return { id, status, date, paidAt: payment.date_approved || date, pix: payment.point_of_interaction?.transaction_data };
}

async function saveProviderState(db, charge, provider, payment, expectedId) {
  const { id, status, date, paidAt, pix } = charge.provider_api === 'orders'
    ? readPixOrder(payment, charge)
    : readPixPayment(payment, charge, provider);
  if ((expectedId && id !== expectedId) || (charge.provider_id && id !== charge.provider_id)) {
    throw new Error('payment_provider_data_mismatch');
  }
  const timestamp = Date.parse(date || '');
  if (!Number.isFinite(timestamp)) throw new Error('payment_provider_timestamp_missing');
  const code = typeof pix?.qr_code === 'string' && pix.qr_code.length <= 4096 ? pix.qr_code : null;
  const image = typeof pix?.qr_code_base64 === 'string' && pix.qr_code_base64.length <= 400000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(pix.qr_code_base64) ? pix.qr_code_base64 : null;
  await db.prepare(`UPDATE charges SET provider_id=?, status=?, provider_updated_at=?,
    paid_at=COALESCE(paid_at,?), pix_code=COALESCE(?,pix_code), pix_image=COALESCE(?,pix_image), creation_failure=NULL
    WHERE id=? AND account_id=? AND integration_id=? AND (provider_id IS NULL OR provider_id=?)
    AND provider_updated_at<=?
    AND (status!='cancelled' OR ? IN ('cancelled','paid','refunded','charged_back'))
    AND (status NOT IN ('paid','refunded','charged_back') OR status=?
      OR (status='paid' AND ? IN ('refunded','charged_back')))`)
    .bind(id, status, timestamp, status === 'paid' ? paidAt : null,
      code, image, charge.id, charge.account_id, charge.integration_id, id, timestamp, status, status, status).run();
  return status;
}

async function chargeProvider(env, db, charge) {
  const integration = await db.prepare('SELECT * FROM payment_integrations WHERE id=? AND account_id=?')
    .bind(charge.integration_id, charge.account_id).first();
  return paymentProvider(env, integration, charge.provider_api);
}

async function cancelCharge(env, db, charge) {
  const provider = await chargeProvider(env, db, charge);
  const id = charge.provider_id;
  try {
    const result = await provider.cancel(id, charge.id);
    const status = await saveProviderState(db, charge, provider, result, id);
    if (status !== 'pending') return;
    throw new Error('payment_provider_data_mismatch');
  } catch (error) {
    // The order may have been paid or cancelled while the request was in flight.
    try {
      const status = await saveProviderState(db, charge, provider, await provider.get(id), id);
      if (status !== 'pending') return;
    } catch {
      // Report the original cancellation failure if reconciliation also fails.
    }
    throw error;
  }
}

function paymentFailure(error) {
  const status = error.statusCode;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `http_${status}`;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
  if (error.message === 'payment_oauth_reconnect') return 'oauth_reconnect';
  if (error.message === 'payment_oauth_refresh_busy') return 'oauth_refresh_busy';
  if (error.message === 'payment_integration_key_missing') return 'integration_key';
  if (error.name === 'OperationError') return 'credentials_unreadable';
  if (['payment_provider_data_mismatch', 'payment_provider_timestamp_missing', 'invalid_provider_payment_id'].includes(error.message)) return 'unexpected_response';
  return 'unknown';
}

function paymentFailureMessage(code) {
  const status = /^http_([45]\d{2})$/.exec(code || '')?.[1];
  if (status) {
    const messages = {
      400: 'Confira os dados do cliente, o valor e o vencimento da cobrança.',
      401: 'Confira se o Access Token da integração usada nesta cobrança está válido e pertence ao ambiente correto (Teste ou Produção).',
      403: 'Confira as permissões da integração usada nesta cobrança.',
      404: 'O pagamento ou recurso não foi localizado na conta conectada.',
      409: 'A solicitação entrou em conflito com uma operação anterior. Confira a cobrança antes de repetir.',
      429: 'O provedor atingiu o limite de solicitações. Aguarde e tente novamente.',
    };
    return `Mercado Pago (HTTP ${status}). ${messages[status] || 'Confira a situação no Mercado Pago e tente novamente mais tarde.'}`;
  }
  const messages = {
    oauth_reconnect: 'Autorize novamente a mesma conta do Mercado Pago em Cobranças → Integrações.',
    oauth_refresh_busy: 'O acesso ao Mercado Pago está sendo renovado. Tente novamente em instantes.',
    timeout: 'O Mercado Pago demorou para responder. Confira a situação no painel do provedor.',
    integration_key: 'A chave de criptografia da integração não está configurada no Worker.',
    credentials_unreadable: 'O MR Pag não conseguiu ler as credenciais. Confira se a chave de criptografia do Worker é a mesma usada ao salvar a integração.',
    unexpected_response: 'A resposta do Mercado Pago não pôde ser validada. Confira a cobrança no painel do provedor.',
    unknown: 'O MR Pag não conseguiu confirmar a operação. Confira a situação no painel do Mercado Pago.',
  };
  return messages[code] || 'O motivo da falha anterior não foi registrado. Confira a cobrança no painel do Mercado Pago.';
}

export async function issue({ db, env }, charge) {
  if (charge.provider_id || Date.now() - charge.created_at > maximumRetryAge) return;
  try {
    const provider = await chargeProvider(env, db, charge);
    const payment = await provider.create(charge);
    const id = String(payment.id || '');
    const complete = charge.provider_api === 'orders'
      ? payment.last_updated_date
      : payment.collector_id != null && payment.currency_id && payment.date_last_updated;
    await saveProviderState(db, charge, provider, complete ? payment : await provider.get(id), id);
  } catch (error) {
    const reason = paymentFailure(error);
    console.error(JSON.stringify({ event: 'pix_creation_failed', charge_id: charge.id, provider_status: error.statusCode || null, reason }));
    await db.prepare("UPDATE charges SET status='creation_error', creation_failure=? WHERE id=? AND account_id=? AND provider_id IS NULL")
      .bind(reason, charge.id, charge.account_id).run();
  }
}

export function insertPixCharge(db, env, { id, accountId, integrationId, customer, description, cents, dueDate, actorEmail, series }) {
  const now = Date.now();
  const domain = (env.MERCADO_PAGO_PAYER_EMAIL_DOMAIN || '').trim().toLowerCase();
  if (domain && (domain.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain))) {
    throw new Error('MERCADO_PAGO_PAYER_EMAIL_DOMAIN deve conter apenas um domínio válido.');
  }
  const payerEmail = domain ? customer.email.slice(0, customer.email.lastIndexOf('@') + 1) + domain : customer.email;
  const payload = pixOrderPayload({
    id, description, cents, dueDate, now,
    payer: { email: payerEmail, identification: { type: customer.document.length === 11 ? 'CPF' : 'CNPJ', number: customer.document } },
  });
  const values = "?,?,?,?,?,?,?,?,?,'orders',?,1,?,?,?";
  const args = [id, accountId, customer.id, integrationId, description, cents, dueDate, JSON.stringify(payload), now,
    token(), actorEmail, series?.id ?? null, customer.email];
  const source = series
    ? `SELECT ${values} FROM charge_recurring_series r JOIN customers u ON u.id=r.customer_id AND u.account_id=r.account_id
      WHERE r.id=? AND r.account_id=? AND r.revision=? AND r.status='active'
        AND r.next_due_date=? AND u.active=1 AND u.email=? AND u.document=?`
    : `VALUES (${values})`;
  if (series) args.push(series.id, accountId, series.revision, series.next_due_date, customer.email, customer.document);
  return db.prepare(`INSERT INTO charges(id,account_id,customer_id,integration_id,
    description,amount_cents,due_date,provider_payload,created_at,provider_api,public_token,auto_email,issuer_email,recurring_series_id,notification_email)
    ${source} ON CONFLICT DO NOTHING RETURNING *`).bind(...args);
}

export async function publicPayment(db, publicToken) {
  if (!/^[a-f0-9]{64}$/.test(publicToken)) return null;
  const charge = await db.prepare(`SELECT c.amount_cents,c.due_date,c.status,c.pix_code,c.pix_image,a.name AS issuer
    FROM charges c JOIN accounts a ON a.id=c.account_id
    WHERE c.public_token=? AND c.provider_id IS NOT NULL`).bind(publicToken).first();
  return charge ? present(charge) : null;
}

export async function paymentRoutes(context) {
  const { request, url, db, env, accountId, actorEmail, origin, body, show, redirect } = context;
  if (url.pathname === oauthConnect && request.method === 'POST') return startMercadoPagoOAuth(context);
  if (url.pathname === oauthCallback && request.method === 'GET') return finishMercadoPagoOAuth(context);
  if (url.pathname === '/account/payments') return integrationSettings(context);
  if (url.pathname === route && request.method === 'GET') {
    const offset = Math.min(100000, Math.max(0, (parseInt(url.searchParams.get('page'), 10) || 1) - 1) * 25);
    const rows = await db.prepare(`SELECT c.id,c.amount_cents,c.description,c.status,c.due_date,u.name AS customer_name
      FROM charges c JOIN customers u ON u.id=c.customer_id AND u.account_id=c.account_id
      WHERE c.account_id=? ORDER BY c.created_at DESC,c.id DESC LIMIT 26 OFFSET ?`).bind(accountId, offset).all();
    return show('charges', { charges: rows.results.slice(0, 25).map(present), chargePage: offset / 25 + 1, nextPage: rows.results.length > 25 });
  }
  if ((url.pathname === `${route}/new` && request.method === 'GET') || (url.pathname === route && request.method === 'POST')) {
    const integration = await currentIntegration(db, accountId);
    const customers = await db.prepare(`SELECT id,name FROM customers WHERE account_id=? AND active=1
      AND email<>'' AND document IS NOT NULL ORDER BY name,id`).bind(accountId).all();
    const fields = request.method === 'GET' ? { request_id: crypto.randomUUID(), due_date: businessDate(new Date(Date.now() + 24 * 60 * minutes)) } : body;
    const render = (error = null, status = 200) => show('charge-form', { integration, customers: customers.results, chargeFields: fields, error }, status);
    if (request.method === 'GET') return render();
    if (!uuid.test(fields.request_id || '')) return redirect(`${route}/new`);
    const previous = await db.prepare('SELECT * FROM charges WHERE id=? AND account_id=?').bind(fields.request_id, accountId).first();
    if (previous) return redirect(`${route}/${previous.id}`);
    if (!integration) return render('Configure o Mercado Pago antes de emitir uma cobrança.', 422);
    const cents = formAmount(fields.amount || '');
    const description = (fields.description || '').trim();
    if (!cents || !description || description.length > 150 || !validDueDate(fields.due_date || '')) {
      return render('Informe descrição, valor positivo e vencimento a pelo menos 31 minutos e a menos de 30 dias.', 422);
    }
    if (!/^[1-9]\d{0,14}$/.test(fields.customer_id || '')) return render('Selecione um cliente ativo.', 422);
    const customer = await db.prepare('SELECT * FROM customers WHERE id=? AND account_id=? AND active=1')
      .bind(Number(fields.customer_id), accountId).first();
    if (!customer?.email || !/^\d{11}$|^\d{14}$/.test(customer.document || '')) {
      return render('Selecione um cliente ativo com e-mail e CPF ou CNPJ cadastrados.', 422);
    }
    const created = await insertPixCharge(db, env, {
      id: fields.request_id, accountId, integrationId: integration.id, customer, description, cents,
      dueDate: fields.due_date, actorEmail,
    }).first();
    if (!created) return redirect(`${route}/${fields.request_id}`);
    await issue(context, created);
    return redirect(`${route}/${created.id}`);
  }
  const [, id, action] = url.pathname.match(/^\/charges\/([a-f0-9-]+)(?:\/(retry|refresh|email|cancel))?$/) || [];
  if (!uuid.test(id || '')) return null;
  const charge = await db.prepare(`SELECT c.*,u.name AS customer_name,u.email AS customer_email FROM charges c
    JOIN customers u ON u.id=c.customer_id AND u.account_id=c.account_id WHERE c.id=? AND c.account_id=?`).bind(id, accountId).first();
  if (!charge) return null;
  const detail = async (error, status = 200) => {
    const display = present(charge);
    const emailHistory = await chargeEmailHistory(db, id);
    return show('charge-detail', {
      charge: display, error, emailHistory, mailRequestId: crypto.randomUUID(),
      publicUrl: charge.provider_id && charge.public_token ? paymentLink(origin, charge.public_token) : null,
      canSendEmail: display.status === 'pending' && !!(charge.pix_code || charge.pix_image) &&
        !!charge.customer_email && !emailHistory.some(entry => ['queued', 'sending'].includes(entry.status)),
    }, status);
  };
  if (!action && request.method === 'GET') {
    return detail(charge.status === 'creation_error' ? paymentFailureMessage(charge.creation_failure) : null);
  }
  if (request.method !== 'POST' || !action) return null;
  if (action === 'retry') await issue(context, charge);
  if (action === 'email' && uuid.test(body.mail_request_id || '')) {
    await queueManualChargeEmail(db, charge, body.mail_request_id, actorEmail);
  }
  if (action === 'cancel' && present(charge).canCancel) {
    try {
      await cancelCharge(env, db, charge);
    } catch (error) {
      return detail(`O cancelamento não foi confirmado. ${paymentFailureMessage(paymentFailure(error))}`, 502);
    }
  }
  if (action === 'refresh' && charge.provider_id) {
    try {
      const provider = await chargeProvider(env, db, charge);
      await saveProviderState(db, charge, provider, await provider.get(charge.provider_id), charge.provider_id);
    } catch (error) {
      return detail(paymentFailureMessage(paymentFailure(error)), 502);
    }
  }
  return redirect(`${route}/${id}`);
}

async function orderReference(request, providerId) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let length = 0;
  let json = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) {
        await reader.cancel();
        return null;
      }
      json += decoder.decode(value, { stream: true });
    }
    const data = JSON.parse(json + decoder.decode()).data;
    return typeof data?.id === 'string' && data.id.toUpperCase() === providerId && uuid.test(data.external_reference || '')
      ? data.external_reference : null;
  } catch {
    return null;
  }
}

async function orderWebhook(request, env, url, signedId, reply) {
  const db = env.DB;
  const providerId = signedId.toUpperCase();
  const integrationId = url.pathname.split('/').at(-1);
  const oauth = url.pathname === oauthWebhook;
  if (!oauth && !uuid.test(integrationId)) return reply(400);
  const authentic = async verify => await verify(request, signedId) ||
    (signedId !== signedId.toLowerCase() && await verify(request, signedId.toLowerCase()));

  let provider;
  if (oauth) {
    if (!await authentic((request, id) => verifySignature(request, id, env.MERCADO_PAGO_WEBHOOK_SECRET))) return reply(401);
  } else {
    const integration = await db.prepare('SELECT * FROM payment_integrations WHERE id=? AND oauth_collector_id IS NULL')
      .bind(integrationId).first();
    if (!integration) return reply(404);
    provider = await paymentProvider(env, integration, 'orders');
    if (!await authentic(provider.verify)) return reply(401);
  }
  const scope = oauth ? 'i.oauth_collector_id IS NOT NULL' : 'i.id=?';
  const args = oauth ? [] : [integrationId];
  const lookup = `SELECT c.* FROM charges c JOIN payment_integrations i ON i.id=c.integration_id
    WHERE c.provider_api='orders' AND ${scope}`;
  let charge = await db.prepare(lookup + ' AND c.provider_id=?').bind(...args, providerId).first();
  if (!charge) {
    const reference = await orderReference(request, providerId);
    if (reference) {
      charge = await db.prepare(lookup + ' AND c.id=? AND c.provider_id IS NULL').bind(...args, reference).first();
    }
  }
  if (!charge) return reply(200);

  // The body only locates a candidate. Confirm all data using its original integration.
  provider ??= await chargeProvider(env, db, charge);
  if (oauth && !await authentic(provider.verify)) return reply(401);
  await saveProviderState(db, charge, provider, await provider.get(providerId), providerId);
  return reply(200);
}

export async function paymentWebhook(request, env, url) {
  const integrationId = url.pathname.split('/').at(-1);
  const providerId = url.searchParams.get('data.id') || '';
  const reply = status => new Response(null, { status });
  if (request.method !== 'POST') return reply(405);
  if (orderIdPattern.test(providerId.toUpperCase())) return orderWebhook(request, env, url, providerId, reply);
  if (!/^\d{1,24}$/.test(providerId)) return reply(400);
  if (url.pathname === oauthWebhook) {
    if (!await verifySignature(request, providerId, env.MERCADO_PAGO_WEBHOOK_SECRET) &&
        !await verifySignature(request, providerId, env.MERCADO_PAGO_LEGACY_WEBHOOK_SECRET)) return reply(401);
    const chargeId = url.searchParams.get('charge') || '';
    if (chargeId && !uuid.test(chargeId)) return reply(400);
    const charge = await env.DB.prepare(`SELECT c.* FROM charges c JOIN payment_integrations i ON i.id=c.integration_id
      WHERE i.oauth_collector_id IS NOT NULL AND c.provider_api='payments' AND ${chargeId ? 'c.id=?' : 'c.provider_id=?'}`)
      .bind(chargeId || providerId).first();
    if (!charge) return reply(200);
    if (charge.provider_id && charge.provider_id !== providerId) return reply(400);
    const provider = await chargeProvider(env, env.DB, charge);
    if (!await provider.verify(request, providerId)) return reply(401);
    await saveProviderState(env.DB, charge, provider, await provider.get(providerId), providerId);
    return reply(200);
  }
  if (!uuid.test(integrationId)) return reply(400);
  const integration = await env.DB.prepare('SELECT * FROM payment_integrations WHERE id=?').bind(integrationId).first();
  if (!integration || integration.oauth_collector_id) return reply(404);
  const provider = await paymentProvider(env, integration);
  if (!await provider.verify(request, providerId)) return reply(401);
  const payment = await provider.get(providerId);
  if (!uuid.test(payment.external_reference || '')) return reply(200);
  const charge = await env.DB.prepare('SELECT * FROM charges WHERE id=? AND account_id=? AND integration_id=? AND provider_api=?')
    .bind(payment.external_reference, integration.account_id, integration.id, 'payments').first();
  if (charge) await saveProviderState(env.DB, charge, provider, payment, providerId);
  return reply(200);
}
