import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fixture, agent, login, post, initial } from './helpers.js';

const secret = 'test-webhook-secret-not-real';
const accessToken = 'test-access-token-not-real';
const integrationId = crypto.randomUUID();
const chargeId = crypto.randomUUID();
const orderId = 'ORD01HRYFWNYRE1MR1E60MW3X0T2P';

async function setup(t) {
  const calls = [];
  let payment;
  let failureStatus;
  const f = await fixture({
    bindings: { PAYMENT_INTEGRATION_KEY: 'a'.repeat(64) },
    async paymentApi(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, key: request.headers.get('x-idempotency-key'), token: request.headers.get('authorization') });
      if (path === '/users/me') return Response.json({ id: 123 });
      if (request.method === 'POST') {
        const payload = await request.json();
        if (path === '/v1/payments') {
          payment = {
            ...payload, id: 321, collector_id: 123, currency_id: 'BRL', status: 'pending',
            date_last_updated: new Date().toISOString(),
          };
        } else {
          assert.equal(path, '/v1/orders');
          assert.equal(payload.processing_mode, 'automatic');
          assert.equal(payload.total_amount, '49.90');
          assert.equal(payload.notification_url, undefined);
          const pix = payload.transactions.payments[0];
          assert.equal(pix.amount, payload.total_amount);
          assert.match(pix.expiration_time, /^P\d+DT\d+H\d+M\d+S$/);
          payment = {
            ...payload, id: orderId, country_code: 'BRA', status: 'action_required', status_detail: 'waiting_transfer',
            last_updated_date: new Date().toISOString(),
            transactions: { payments: [{
              ...pix, status: 'action_required', status_detail: 'waiting_transfer',
              payment_method: { ...pix.payment_method, qr_code: 'codigo-pix-de-teste', qr_code_base64: 'aW1hZ2U=' },
            }] },
          };
        }
        if (failureStatus) {
          const status = failureStatus;
          failureStatus = null;
          return Response.json({ message: 'detalhe-privado-do-provedor' }, { status });
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
    failFirst(status) { failureStatus = status; },
    updatePayment(values) { Object.assign(payment, values); },
    approveOrder(at) {
      Object.assign(payment, { status: 'processed', status_detail: 'accredited',
        total_paid_amount: '49.90', last_updated_date: at });
      Object.assign(payment.transactions.payments[0], { status: 'processed', status_detail: 'accredited' });
    },
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

function webhook(f, signingSecret = secret, id = orderId, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const requestId = 'request-notification-test';
  const signature = createHmac('sha256', signingSecret).update(`id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  return f.mf.dispatchFetch(`http://localhost:8787/webhooks/mercado-pago/${integrationId}?data.id=${id}&type=${id === '321' ? 'payment' : 'order'}`, {
    method: 'POST', body, headers: { 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${signature}` },
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
  f.approveOrder(now);
  assert.equal((await webhook(f, 'wrong-secret')).status, 401);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');
  f.updatePayment({ total_amount: '0.01' });
  assert.equal((await webhook(f)).status, 500);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');

  f.updatePayment({ total_amount: '49.90' });
  assert.equal((await webhook(f)).status, 200);
  assert.equal((await webhook(f)).status, 200);
  f.updatePayment({ status: 'action_required', last_updated_date: new Date().toISOString() });
  assert.equal((await webhook(f)).status, 200);
  assert.deepEqual(await f.db.prepare('SELECT status,paid_at FROM charges').first(), { status: 'paid', paid_at: now });
});

test('falha de emissão pode ser repetida com a mesma chave e credencial original', async t => {
  const f = await setup(t);
  await configure(f);
  f.failFirst(401);
  await createCharge(f);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'creation_error');
  const path = `/charges/${chargeId}`;
  const failed = await f.agent.request(path);
  assert.match(failed.text, /Mercado Pago \(HTTP 401\)/);
  assert.match(failed.text, /Access Token/);
  assert.doesNotMatch(failed.text, /detalhe-privado-do-provedor/);
  assert.equal((await post(f.agent, path, `${path}/retry`, {})).status, 303);
  assert.doesNotMatch((await f.agent.request(path)).text, /HTTP 401/);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');
  assert.deepEqual(f.calls.filter(call => call.key).map(call => call.key), [chargeId, chargeId]);
  const updatedAt = new Date(Date.now() + 1000).toISOString();
  f.approveOrder(updatedAt);
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

test('uma cobrança existente sem versão explícita continua usando Payments para emissão e baixa', async t => {
  const f = await setup(t);
  await configure(f);
  const payload = JSON.stringify({ external_reference: chargeId, transaction_amount: 49.90, payment_method_id: 'pix' });
  await f.db.prepare(`INSERT INTO charges(id,account_id,customer_id,integration_id,description,amount_cents,
    due_date,provider_payload,created_at) VALUES (?,1,1,?,'Pix legado',4990,?,?,?)`)
    .bind(chargeId, integrationId, new Date(Date.now() + 86400000).toISOString().slice(0, 10), payload, Date.now()).run();
  const path = `/charges/${chargeId}`;
  assert.equal((await post(f.agent, path, path + '/retry', {})).status, 303);
  assert.equal(f.calls.at(-1).path, '/v1/payments');
  f.updatePayment({ status: 'approved', date_last_updated: new Date(Date.now() + 1000).toISOString() });
  assert.equal((await webhook(f, secret, '321')).status, 200);
  assert.equal(f.calls.at(-1).path, '/v1/payments/321');
  assert.deepEqual(await f.db.prepare('SELECT status,provider_api FROM charges').first(),
    { status: 'paid', provider_api: 'payments' });
});

test('webhook Order recupera emissão sem ID salvo usando a referência, sem confiar no status do evento', async t => {
  const f = await setup(t);
  await configure(f);
  f.failFirst(503);
  await createCharge(f);
  const getCharge = () => f.db.prepare('SELECT status,provider_id FROM charges').first();
  assert.deepEqual(await getCharge(), { status: 'creation_error', provider_id: null });
  const notification = JSON.stringify({ data: {
    id: orderId, external_reference: chargeId, status: 'processed', status_detail: 'accredited',
  } });
  assert.equal((await webhook(f, secret, orderId, notification)).status, 200);
  assert.deepEqual(await getCharge(), { status: 'pending', provider_id: orderId });
  assert.equal(f.calls.at(-1).path, '/v1/orders/' + orderId);
});
