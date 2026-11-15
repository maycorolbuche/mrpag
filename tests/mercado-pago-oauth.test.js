import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { agent, fixture, login, post } from './helpers.js';
import { sealCredentials } from '../src/payment-providers.js';

const settings = '/account/payments';
const connect = settings + '/mercado-pago/connect';
const callback = settings + '/mercado-pago/callback';
const webhook = '/webhooks/mercado-pago/oauth';
const origin = 'https://pag.example.com';
const webhookSecret = 'oauth-webhook-secret-for-tests';
const orderId = 'ORD01HRYFWNYRE1MR1E60MW3X0T2P';

test('OAuth vincula a conta, renova o acesso e confirma Pix pelo webhook compartilhado', async t => {
  const grantRequests = [];
  const accessTokens = [];
  let collector = 123;
  let payment;
  const f = await fixture({
    bindings: {
      APP_URL: origin, PAYMENT_INTEGRATION_KEY: 'a'.repeat(64),
      MERCADO_PAGO_CLIENT_ID: '42', MERCADO_PAGO_CLIENT_SECRET: 'client-secret-for-tests',
      MERCADO_PAGO_WEBHOOK_SECRET: webhookSecret, MERCADO_PAGO_OAUTH_MODE: 'test',
    },
    async paymentApi(request) {
      const path = new URL(request.url).pathname;
      if (path === '/oauth/token') {
        const body = await request.json();
        grantRequests.push(body);
        const refreshed = body.grant_type === 'refresh_token';
        return Response.json({
          access_token: refreshed ? 'rotated-access' : 'initial-access',
          refresh_token: refreshed ? 'rotated-refresh' : 'initial-refresh',
          expires_in: refreshed ? 3600 : 30, user_id: collector, live_mode: false,
        });
      }
      accessTokens.push(request.headers.get('Authorization'));
      if (request.method === 'POST') {
        assert.equal(path, '/v1/orders');
        payment = { ...await request.json(), status: 'action_required', status_detail: 'waiting_transfer',
          country_code: 'BRA', id: orderId, last_updated_date: new Date().toISOString() };
      } else {
        assert.equal(path, '/v1/orders/' + orderId);
      }
      return Response.json(payment);
    },
  });
  t.after(() => f.mf.dispose());
  await f.db.prepare('UPDATE users SET must_change=0').run();
  await login(f.agent);
  await f.db.prepare(`INSERT INTO customers(account_id,name,person_type,document,email,created_at,updated_at)
    VALUES (1,'Cliente Pix','person','52998224725','pix@example.com',0,0)`).run();

  const start = async () => {
    const page = await post(f.agent, settings, connect, {});
    assert.equal(page.status, 200);
    return new URL(page.text.match(/href="([^"]+)" data-payment-authorization/)[1].replaceAll('&amp;', '&'));
  };
  const authorization = await start();
  assert.equal(authorization.origin, 'https://auth.mercadopago.com');
  assert.equal(authorization.searchParams.get('redirect_uri'), origin + callback);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const state = authorization.searchParams.get('state');
  const finish = `${callback}?code=auth-code&state=${state}`;
  const otherSession = agent(f.mf, origin);
  await login(otherSession);
  assert.equal((await otherSession.request(finish)).headers.get('location'), settings + '?oauth=expired');
  assert.equal(grantRequests.length, 0);
  assert.equal((await f.agent.request(finish)).headers.get('location'), settings + '?oauth=connected');
  assert.equal((await f.agent.request(finish)).headers.get('location'), settings + '?oauth=expired');
  assert.equal(grantRequests.length, 1);
  assert.equal(grantRequests[0].test_token, true);
  assert.equal(grantRequests[0].client_secret, 'client-secret-for-tests');
  assert.equal(createHash('sha256').update(grantRequests[0].code_verifier).digest('base64url'),
    authorization.searchParams.get('code_challenge'));
  const integration = await f.db.prepare('SELECT * FROM payment_integrations').first();
  assert.equal(integration.oauth_collector_id, '123');
  assert.doesNotMatch(integration.credentials, /initial-access|initial-refresh/);
  assert.match((await f.agent.request(settings)).text, /123<\/strong> · Teste/);

  const chargeId = crypto.randomUUID();
  const charge = await post(f.agent, '/charges/new', '/charges', {
    request_id: chargeId, customer_id: '1', description: 'Pix OAuth', amount: '10,00',
    due_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  });
  assert.equal(charge.headers.get('location'), '/charges/' + chargeId);
  assert.equal(grantRequests[1].refresh_token, 'initial-refresh');
  assert.equal(payment.notification_url, undefined);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');
  assert.deepEqual(accessTokens, ['Bearer rotated-access']);

  const retiredCharge = payment;
  const authorizeAgain = async () => {
    const next = await start();
    return f.agent.request(`${callback}?code=auth-code&state=${next.searchParams.get('state')}`);
  };
  assert.equal((await authorizeAgain()).headers.get('location'), settings + '?oauth=connected');
  assert.equal((await f.db.prepare('SELECT count(*) AS total FROM payment_integrations').first()).total, 1);
  collector = 987;
  assert.equal((await authorizeAgain()).headers.get('location'), settings + '?oauth=connected');
  const active = await f.db.prepare('SELECT integration_id FROM payment_integration_defaults').first();
  assert.notEqual(active.integration_id, integration.id);
  assert.equal((await f.db.prepare('SELECT integration_id FROM charges').first()).integration_id, integration.id);

  payment = { ...retiredCharge, status: 'processed', status_detail: 'accredited', total_paid_amount: '10.00',
    last_updated_date: new Date(Date.now() + 1000).toISOString() };
  Object.assign(payment.transactions.payments[0], { status: 'processed', status_detail: 'accredited' });
  const ts = String(Date.now());
  const sendWebhook = signingSecret => f.mf.dispatchFetch(origin + webhook + '?data.id=' + orderId + '&type=order', {
    method: 'POST',
    headers: { 'x-request-id': 'test', 'x-signature': `ts=${ts},v1=` +
      createHmac('sha256', signingSecret).update(`id:${orderId};request-id:test;ts:${ts};`).digest('hex') },
  });
  assert.equal((await sendWebhook('wrong-secret')).status, 401);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');
  collector = 123;
  assert.equal((await sendWebhook(webhookSecret)).status, 200);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'paid');
});

test('ao trocar de aplicação OAuth, cobranças Payments preservam a credencial e o webhook antigos', async t => {
  const chargeId = crypto.randomUUID();
  const now = new Date().toISOString();
  const oldSecret = 'legacy-webhook-secret';
  const oldCredentials = {
    PAYMENT_INTEGRATION_KEY: 'a'.repeat(64),
    MERCADO_PAGO_LEGACY_CLIENT_ID: '41',
    MERCADO_PAGO_LEGACY_CLIENT_SECRET: 'old-client-secret',
    MERCADO_PAGO_LEGACY_WEBHOOK_SECRET: oldSecret,
  };
  const f = await fixture({
    bindings: {
      ...oldCredentials, APP_URL: origin, MERCADO_PAGO_CLIENT_ID: '42',
      MERCADO_PAGO_CLIENT_SECRET: 'new-client-secret', MERCADO_PAGO_WEBHOOK_SECRET: webhookSecret,
    },
    async paymentApi(request) {
      const path = new URL(request.url).pathname;
      if (path === '/oauth/token') {
        const params = await request.json();
        const legacy = params.grant_type === 'refresh_token';
        assert.equal(params.client_id, legacy ? '41' : '42');
        assert.equal(params.client_secret, legacy ? 'old-client-secret' : 'new-client-secret');
        return Response.json({
          access_token: legacy ? 'old-renewed' : 'new-token', refresh_token: 'next-refresh',
          user_id: 123, live_mode: true, expires_in: 3600,
        });
      }
      assert.equal(path, '/v1/payments/321');
      assert.equal(request.headers.get('authorization'), 'Bearer old-renewed');
      return Response.json({
        id: 321, status: 'approved', currency_id: 'BRL', payment_method_id: 'pix',
        collector_id: 123, transaction_amount: 10, date_last_updated: now, external_reference: chargeId,
      });
    },
  });
  t.after(() => f.mf.dispose());
  const hash = createHash('sha256').update('mercado-pago-oauth:1:123:true').digest('hex');
  const legacyId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const sealed = await sealCredentials(oldCredentials, legacyId, {
    token: 'old-token', refreshToken: 'old-refresh', expiresAt: 0,
    liveMode: true, collectorId: '123', clientId: '41',
  });
  await f.db.batch([
    f.db.prepare('UPDATE users SET must_change=0'),
    f.db.prepare(`INSERT INTO customers(account_id,name,person_type,document,email,created_at,updated_at)
      VALUES (1,'Cliente Pix','person','52998224725','pix@example.com',0,0)`),
    f.db.prepare(`INSERT INTO payment_integrations(id,account_id,provider,credentials,created_at,oauth_collector_id,oauth_live_mode)
      VALUES (?,1,'mercado-pago',?,0,'123',1)`).bind(legacyId, sealed),
    f.db.prepare(`INSERT INTO charges(id,account_id,customer_id,integration_id,description,amount_cents,due_date,
      provider_payload,provider_id,status,created_at) VALUES (?,1,1,?,'Pix legado',1000,'2099-01-01','{}','321','pending',0)`)
      .bind(chargeId, legacyId),
  ]);
  await login(f.agent);
  const page = await post(f.agent, settings, connect, {});
  const authorization = new URL(page.text.match(/href="([^"]+)" data-payment-authorization/)[1].replaceAll('&amp;', '&'));
  assert.equal((await f.agent.request(callback + '?code=auth-code&state=' + authorization.searchParams.get('state')))
    .headers.get('location'), settings + '?oauth=connected');
  assert.notEqual((await f.db.prepare('SELECT integration_id FROM payment_integration_defaults').first()).integration_id, legacyId);
  const ts = String(Date.now());
  const sendWebhook = signingSecret => f.mf.dispatchFetch(origin + webhook + '?data.id=321&type=payment', {
    method: 'POST', headers: {
      'x-request-id': 'legacy-test',
      'x-signature': `ts=${ts},v1=` + createHmac('sha256', signingSecret).update(`id:321;request-id:legacy-test;ts:${ts};`).digest('hex'),
    },
  });
  assert.equal((await sendWebhook(webhookSecret)).status, 401);
  assert.equal((await sendWebhook(oldSecret)).status, 200);
  assert.deepEqual(await f.db.prepare('SELECT status,integration_id FROM charges').first(),
    { status: 'paid', integration_id: legacyId });
});
