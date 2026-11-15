import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { agent, fixture, login, post } from './helpers.js';

const settings = '/account/payments';
const connect = settings + '/mercado-pago/connect';
const callback = settings + '/mercado-pago/callback';
const webhook = '/webhooks/mercado-pago/oauth';
const origin = 'https://pag.example.com';
const webhookSecret = 'oauth-webhook-secret-for-tests';

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
        payment = { ...await request.json(), status: 'pending', currency_id: 'BRL',
          collector_id: collector, id: 765, date_last_updated: new Date().toISOString() };
      }
      return Response.json(payment);
    },
  });
  t.after(() => f.mf.dispose());
  await f.db.prepare('UPDATE users SET must_change=0').run();
  await login(f.agent);
  await f.db.prepare(`INSERT INTO customers(account_id,name,person_type,document,email,created_at,updated_at)
    VALUES (1,'Cliente Pix','person','52998224725','pix@example.com',0,0)`).run();

  const start = async () => new URL((await post(f.agent, settings, connect, {})).headers.get('location'));
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
  assert.equal(payment.notification_url, origin + webhook + '?charge=' + chargeId);
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

  payment = { ...retiredCharge, status: 'approved', date_last_updated: new Date(Date.now() + 1000).toISOString() };
  const ts = String(Date.now());
  const sendWebhook = signingSecret => f.mf.dispatchFetch(origin + webhook + '?data.id=765', {
    method: 'POST',
    headers: { 'x-request-id': 'test', 'x-signature': `ts=${ts},v1=` +
      createHmac('sha256', signingSecret).update(`id:765;request-id:test;ts:${ts};`).digest('hex') },
  });
  assert.equal((await sendWebhook('wrong-secret')).status, 401);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');
  collector = 123;
  assert.equal((await sendWebhook(webhookSecret)).status, 200);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'paid');
});
