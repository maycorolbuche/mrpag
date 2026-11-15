import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fixture, agent, login, post, initial } from './helpers.js';

const secret = 'test-webhook-secret-not-real';
const accessToken = 'test-access-token-not-real';
const integrationId = crypto.randomUUID();
const chargeId = crypto.randomUUID();

async function setup(t) {
  const calls = [];
  let payment;
  let failFirst = false;
  const f = await fixture({
    bindings: { PAYMENT_INTEGRATION_KEY: 'a'.repeat(64) },
    async paymentApi(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, key: request.headers.get('x-idempotency-key'), token: request.headers.get('authorization') });
      if (path === '/users/me') return Response.json({ id: 123 });
      if (request.method === 'POST') {
        const payload = await request.json();
        payment = {
          ...payload, id: 321, collector_id: 123, currency_id: 'BRL', status: 'pending',
          date_last_updated: new Date().toISOString(),
          point_of_interaction: { transaction_data: { qr_code: 'codigo-pix-de-teste', qr_code_base64: 'aW1hZ2U=' } },
        };
        if (failFirst) {
          failFirst = false;
          return new Response(null, { status: 503 });
        }
      }
      return Response.json(payment);
    },
  });
  t.after(() => f.mf.dispose());
  await f.db.prepare('UPDATE users SET must_change=0').run();
  await login(f.agent);
  await f.db.prepare(`INSERT INTO customers(account_id,name,person_type,document,email,created_at,updated_at)
    VALUES (1,'Cliente Pix','person','52998224725','pix@example.com',0,0)`).run();
  return {
    ...f, calls,
    failFirst() { failFirst = true; },
    updatePayment(values) { Object.assign(payment, values); },
  };
}

async function configure(f) {
  const response = await post(f.agent, '/account/payments', '/account/payments', {
    integration_id: integrationId, access_token: accessToken, webhook_secret: secret,
  });
  assert.equal(response.headers.get('location'), '/account/payments', response.text.match(/role="alert">([^<]+)/)?.[1]);
}

async function createCharge(f, changes = {}) {
  return post(f.agent, '/charges/new', '/charges', {
    request_id: chargeId, customer_id: '1', description: 'Cobrança de teste',
    amount: '49,90', due_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), ...changes,
  });
}

function webhook(f, signingSecret = secret) {
  const ts = String(Math.floor(Date.now() / 1000));
  const requestId = 'request-notification-test';
  const signature = createHmac('sha256', signingSecret).update(`id:321;request-id:${requestId};ts:${ts};`).digest('hex');
  return f.mf.dispatchFetch(`http://localhost:8787/webhooks/mercado-pago/${integrationId}?data.id=321&type=payment`, {
    method: 'POST', headers: { 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${signature}` },
  });
}

test('a cobrança emite Pix uma vez e só é baixada após consulta autenticada ao Mercado Pago', async t => {
  const f = await setup(t);
  await configure(f);
  const credentials = (await f.db.prepare('SELECT credentials FROM payment_integrations').first()).credentials;
  assert.ok(!credentials.includes(accessToken) && !credentials.includes(secret));
  const result = await createCharge(f);
  assert.equal(result.headers.get('location'), `/charges/${chargeId}`);
  assert.equal((await createCharge(f)).headers.get('location'), result.headers.get('location'));
  assert.equal(f.calls.filter(call => call.key === chargeId).length, 1);
  const detail = await f.agent.request(`/charges/${chargeId}`);
  assert.match(detail.text, /código|copia e cola/);
  assert.match(detail.text, /codigo-pix-de-teste/);
  assert.match((await f.agent.request('/charges')).text, /Cobrança de teste/);

  const now = new Date(Date.now() + 1000).toISOString();
  f.updatePayment({ status: 'approved', date_last_updated: now, date_approved: now });
  assert.equal((await webhook(f, 'wrong-secret')).status, 401);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');
  f.updatePayment({ transaction_amount: 0.01 });
  assert.equal((await webhook(f)).status, 500);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');

  f.updatePayment({ transaction_amount: 49.90 });
  assert.equal((await webhook(f)).status, 200);
  assert.equal((await webhook(f)).status, 200);
  f.updatePayment({ status: 'pending', date_last_updated: new Date().toISOString() });
  assert.equal((await webhook(f)).status, 200);
  assert.deepEqual(await f.db.prepare('SELECT status,paid_at FROM charges').first(), { status: 'paid', paid_at: now });
});

test('falha de emissão pode ser repetida com a mesma chave e credencial original', async t => {
  const f = await setup(t);
  await configure(f);
  f.failFirst();
  await createCharge(f);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'creation_error');
  const path = `/charges/${chargeId}`;
  assert.equal((await post(f.agent, path, `${path}/retry`, {})).status, 303);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');
  assert.deepEqual(f.calls.filter(call => call.key).map(call => call.key), [chargeId, chargeId]);
  const updatedAt = new Date(Date.now() + 1000).toISOString();
  f.updatePayment({ status: 'approved', date_last_updated: updatedAt, date_approved: updatedAt });
  assert.equal((await post(f.agent, path, path + "/refresh", {})).status, 303);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'paid');
});

test('cobranças e clientes de outra conta ficam fora do escopo', async t => {
  const f = await setup(t);
  await configure(f);
  await f.db.prepare("INSERT INTO accounts(id,name,created_at,updated_at) VALUES (2,'Outra conta',0,0)").run();
  await f.db.prepare(`INSERT INTO users(id,name,email,password,version,must_change,account_id)
    SELECT 2,'Outro usuário','other@example.com',password,?,0,2 FROM users WHERE id=1`).bind(crypto.randomUUID()).run();
  await f.db.prepare(`INSERT INTO customers(account_id,name,person_type,document,email,created_at,updated_at)
    VALUES (2,'Cliente privado','person','52998224725','other@example.com',0,0)`).run();
  assert.equal((await createCharge(f, { customer_id: '2' })).status, 422);
  await createCharge(f);
  const other = agent(f.mf);
  assert.equal((await post(other, '/login', '/login', { email: 'other@example.com', password: initial })).status, 303);
  assert.equal((await other.request(`/charges/${chargeId}`)).status, 404);
  assert.equal((await post(other, '/charges', `/charges/${chargeId}/refresh`, {})).status, 404);
  assert.doesNotMatch((await other.request('/charges')).text, /Cobrança de teste/);
  assert.doesNotMatch((await other.request('/account/payments')).text, new RegExp(integrationId));
});
