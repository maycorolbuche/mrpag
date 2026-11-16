import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fixture, agent, login, post, initial } from './helpers.js';

const secret = 'test-webhook-secret-not-real';
const accessToken = 'test-access-token-not-real';
const integrationId = crypto.randomUUID();
const chargeId = crypto.randomUUID();
const orderId = 'ORD01HRYFWNYRE1MR1E60MW3X0T2P';

async function setup(t, { origin, mailApi, bindings = {}, expectedPayer = 'pix@example.com' } = {}) {
  const calls = [];
  let payment;
  let failureStatus;
  let cancellationFailure;
  let refreshFailure;
  const f = await fixture({
    bindings: { PAYMENT_INTEGRATION_KEY: 'a'.repeat(64), ...(origin ? { APP_URL: origin } : {}), ...bindings },
    mailApi,
    async paymentApi(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, key: request.headers.get('x-idempotency-key'), token: request.headers.get('authorization') });
      if (path === '/users/me') return Response.json({ id: 123 });
      if (path.endsWith('/cancel') || request.method === 'PUT') {
        if (cancellationFailure) return Response.json({}, { status: cancellationFailure });
        const now = new Date(Date.now() + 1000).toISOString();
        if (request.method === 'PUT') {
          assert.equal(path, '/v1/payments/321');
          assert.deepEqual(await request.json(), { status: 'cancelled' });
          Object.assign(payment, { status: 'cancelled', status_detail: 'by_collector', date_last_updated: now });
        } else {
          assert.equal(path, `/v1/orders/${orderId}/cancel`);
          assert.equal(request.headers.get('x-idempotency-key'), 'cancel-' + chargeId);
          Object.assign(payment, { status: 'canceled', status_detail: 'canceled_transaction', last_updated_date: now });
          Object.assign(payment.transactions.payments[0], { status: 'canceled', status_detail: 'canceled_transaction' });
        }
        return Response.json(payment);
      }
      if (request.method === 'GET' && refreshFailure) return Response.json({}, { status: refreshFailure });
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
          assert.equal(payload.payer.email, expectedPayer);
          assert.equal(payload.payer.first_name, 'João');
          assert.equal(payload.payer.last_name, 'da Silva Neto');
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
    VALUES (1,'João da Silva Neto','person','52998224725','pix@example.com',0,0)`).run();
  return {
    ...f, calls,
    failFirst(status) { failureStatus = status; },
    failCancellation(status) { cancellationFailure = status; },
    failRefresh(status) { refreshFailure = status; },
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
  return f.mf.dispatchFetch(`${f.agent.origin}/webhooks/mercado-pago/${integrationId}?data.id=${id}&type=${id === '321' ? 'payment' : 'order'}`, {
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
  assert.equal((await post(other, '/charges', `/charges/${chargeId}/cancel`, {})).status, 404);
  assert.ok(!f.calls.some(call => call.path.endsWith('/cancel')));
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

test('Pix enviado por e-mail tem link público, reenvio idempotente e baixa pelo mesmo link', async t => {
  const origin = 'https://pag.example.com';
  const keys = [];
  const f = await setup(t, {
    origin,
    mailApi(request) {
      keys.push(request.headers.get('Idempotency-Key'));
      return Response.json({ id: 'email-test' });
    },
  });
  await configure(f);
  await Promise.all([createCharge(f), createCharge(f)]);
  const worker = await f.mf.getWorker();
  for (const hour of ['03:00', '10:59', '13:00']) {
    await runChargeCron(worker, hour);
  }
  assert.equal(f.messages.length, 0);
  assert.deepEqual(await f.db.prepare('SELECT status,attempt_count FROM charge_emails').first(),
    { status: 'queued', attempt_count: 0 });
  // The cron has no session and must use the address captured at issuance.
  await f.db.prepare("UPDATE users SET email='operator@example.com' WHERE id=1").run();
  const run = () => runChargeCron(worker);
  await Promise.all([run(), run()]);
  assert.equal(f.messages.length, 1);
  assert.equal(keys[0], 'initial/' + chargeId);
  assert.deepEqual(f.messages[0].to, ['pix@example.com']);
  assert.equal(f.messages[0].subject, 'Você tem um novo pagamento — MR Pag');
  assert.match(f.messages[0].text, /Descrição: Cobrança de teste/);
  assert.match(f.messages[0].html, /<h1[^>]*>Cobrança de teste<\/h1>/);
  assert.deepEqual(f.messages[0].bcc, ['admin@mrpag.local']);
  const url = new URL(f.messages[0].text.match(/https:\/\/[^\s]+/)[0]);
  assert.equal(url.origin, origin);
  assert.match(url.pathname, /^\/pay\/[a-f0-9]{64}$/);
  const publicAgent = agent(f.mf, origin);
  const page = await publicAgent.request(url.pathname);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.match(page.text, /codigo-pix-de-teste/);
  assert.match(page.text, /id="payment-title">Valor a pagar<\/h1>/);
  assert.match(page.text, /<dt>Descrição<\/dt><dd>Cobrança de teste<\/dd>/);
  assert.doesNotMatch(page.text, /pix@example.com|52998224725|João da Silva Neto/);
  const statusUrl = url.pathname + '/status';
  const statusPage = await publicAgent.request(statusUrl);
  assert.equal(statusPage.status, 200);
  assert.equal(statusPage.headers.get('cache-control'), 'no-store');
  assert.deepEqual(JSON.parse(statusPage.text), { status: 'pending' });
  assert.equal((await publicAgent.request('/pay/' + 'f'.repeat(64) + '/status')).status, 404);
  assert.equal((await publicAgent.request('/pay/' + 'f'.repeat(64))).status, 404);
  assert.equal((await publicAgent.request(url.pathname, { method: 'POST' })).status, 405);

  const path = `/charges/${chargeId}`;
  const detail = await f.agent.request(path);
  assert.match(detail.text, /Aceito pelo serviço de e-mail/);
  const mail_request_id = detail.text.match(/name="mail_request_id" value="([^"]+)"/)[1];
  await post(f.agent, path, path + '/email', { mail_request_id });
  await runChargeCron(worker, '13:00');
  await post(f.agent, path, path + '/email', { mail_request_id });
  await runChargeCron(worker, '13:00');
  assert.equal(f.messages.length, 2);
  assert.match(keys[1], /^manual\//);
  assert.ok(f.messages[1].text.includes(url.href));
  assert.deepEqual(f.messages[1].bcc, ['operator@example.com']);

  f.approveOrder(new Date(Date.now() + 1000).toISOString());
  assert.equal((await webhook(f)).status, 200);
  const paid = await publicAgent.request(url.pathname);
  assert.match(paid.text, /<strong>Paga<\/strong>/);
  assert.match(paid.text, /id="payment-title">Valor pago<\/h1>/);
  assert.doesNotMatch(paid.text, /codigo-pix-de-teste|payment-status\.js/);
  assert.deepEqual(JSON.parse((await publicAgent.request(statusUrl)).text), { status: 'paid' });
  await post(f.agent, path, path + '/email', { mail_request_id: crypto.randomUUID() });
  await post(f.agent, path, path + '/refresh', {});
  await runChargeCron(worker, '13:00');
  assert.equal(f.messages.length, 3);
  assert.match(f.messages[2].subject, /Pagamento confirmado/);
  assert.equal(keys[2], 'confirmation/' + chargeId);
  assert.deepEqual(f.messages[2].to, ['pix@example.com']);
  assert.deepEqual(f.messages[2].bcc, ['admin@mrpag.local']);
});

test('uma falha temporária do serviço de e-mail é registrada e usa a mesma chave na nova tentativa', async t => {
  const keys = [];
  const f = await setup(t, {
    origin: 'https://pag.example.com',
    mailApi(request) {
      keys.push(request.headers.get('Idempotency-Key'));
      return Response.json({}, { status: keys.length === 1 ? 503 : 200 });
    },
  });
  await configure(f);
  await createCharge(f);
  const worker = await f.mf.getWorker();
  await runChargeCron(worker);
  const first = await f.db.prepare('SELECT status,next_at FROM charge_emails').first();
  assert.equal(first.status, 'queued');
  assert.ok(first.next_at > Date.now());
  await f.db.prepare('UPDATE charge_emails SET next_at=0').run();
  await runChargeCron(worker);
  assert.deepEqual(keys, ['initial/' + chargeId, 'initial/' + chargeId]);
  assert.deepEqual((await f.db.prepare('SELECT result FROM charge_email_attempts ORDER BY number').all())
    .results.map(row => row.result), ['mail_http_503', 'sent']);
});

test('cron SMTP registra configuração incompleta e não repete um envio interrompido após DATA', async t => {
  const f = await setup(t, { origin: 'https://pag.example.com', bindings: { MAIL_MODE: 'smtp' } });
  await configure(f);
  await createCharge(f);
  const worker = await f.mf.getWorker();
  await runChargeCron(worker);
  assert.equal((await f.db.prepare('SELECT result FROM charge_email_attempts').first()).result, 'mail_not_configured');

  await f.db.batch([
    f.db.prepare("UPDATE charge_emails SET status='sending',next_at=0,lease_until=1"),
    f.db.prepare("UPDATE charge_email_attempts SET result='smtp_data_started',finished_at=NULL"),
  ]);
  await runChargeCron(worker);
  assert.deepEqual(await f.db.prepare('SELECT status,attempt_count FROM charge_emails').first(),
    { status: 'failed', attempt_count: 1 });
  assert.equal((await f.db.prepare('SELECT result FROM charge_email_attempts').first()).result, 'mail_smtp_delivery_unknown');
  assert.equal(f.messages.length, 0);
});

test('cancelamento confirmado no Mercado Pago atualiza a cobrança e remove o Pix do link público', async t => {
  const f = await setup(t);
  await configure(f);
  await createCharge(f);
  const path = `/charges/${chargeId}`;
  assert.match((await f.agent.request(path)).text, /Confirmar cancelamento/);
  assert.equal((await f.agent.request(path + '/cancel')).status, 404);
  const result = await post(f.agent, path, path + '/cancel', {});
  assert.equal(result.headers.get('location'), path);
  const detail = await f.agent.request(path);
  assert.match(detail.text, /<strong>Cancelada<\/strong>/);
  assert.doesNotMatch(detail.text, /Confirmar cancelamento|codigo-pix-de-teste/);

  const { public_token } = await f.db.prepare('SELECT public_token FROM charges').first();
  const publicPage = await agent(f.mf).request('/pay/' + public_token);
  assert.match(publicPage.text, /<strong>Cancelada<\/strong>/);
  assert.doesNotMatch(publicPage.text, /codigo-pix-de-teste/);
  await post(f.agent, path, path + '/cancel', {});
  assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1);

  f.updatePayment({ status: 'action_required', last_updated_date: new Date(Date.now() + 2000).toISOString() });
  await post(f.agent, path, path + '/refresh', {});
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'cancelled');
});

test('cancelamento recusado mantém o Pix pendente e concilia um pagamento que acabou de entrar', async t => {
  const f = await setup(t);
  await configure(f);
  await createCharge(f);
  const path = `/charges/${chargeId}`;
  f.failCancellation(409);
  const refusal = await post(f.agent, path, path + '/cancel', {});
  assert.equal(refusal.status, 502);
  assert.match(refusal.text, /O cancelamento não foi confirmado/);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'pending');

  f.approveOrder(new Date(Date.now() + 1000).toISOString());
  const reconciled = await post(f.agent, path, path + '/cancel', {});
  assert.equal(reconciled.status, 303);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'paid');
  await post(f.agent, path, path + '/cancel', {});
  assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 2);
});

test('cancelamento de cobrança legada usa a API Payments', async t => {
  const f = await setup(t);
  await configure(f);
  const payload = JSON.stringify({ external_reference: chargeId, transaction_amount: 49.90, payment_method_id: 'pix' });
  await f.db.prepare(`INSERT INTO charges(id,account_id,customer_id,integration_id,description,amount_cents,
    due_date,provider_payload,created_at) VALUES (?,1,1,?,'Pix legado',4990,?,?,?)`)
    .bind(chargeId, integrationId, new Date(Date.now() + 86400000).toISOString().slice(0, 10), payload, Date.now()).run();
  const path = `/charges/${chargeId}`;
  await post(f.agent, path, path + '/retry', {});
  const result = await post(f.agent, path, path + '/cancel', {});
  assert.equal(result.status, 303);
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'cancelled');
});

test('recorrência gera uma cobrança por ciclo, reutiliza e-mail e permite editar, pausar e encerrar', async t => {
  const f = await setup(t, { origin: 'https://pag.example.com',
    bindings: { MERCADO_PAGO_PAYER_EMAIL_DOMAIN: 'mxsoft.com.br' }, expectedPayer: 'pix@mxsoft.com.br' });
  await configure(f);
  const root = '/charges/recurring';
  const id = crypto.randomUUID();
  const due = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + 86400000));
  const fields = { request_id: id, customer_id: '1', description: 'Mensalidade', amount: '49,90',
    interval_months: '2', first_due: due, lead_days: '5' };
  assert.equal((await post(f.agent, root + '/new', root, { ...fields, interval_months: '3' })).status, 422);
  assert.equal((await post(f.agent, root + '/new', root, fields)).headers.get('location'), root + '/' + id);
  assert.match((await f.agent.request('/charges')).text, /Bimestral/);
  const path = root + '/' + id;
  const worker = await f.mf.getWorker();
  const run = () => runChargeCron(worker);
  await post(f.agent, path, path + '/pause', {});
  await run();
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM charges').first()).n, 0);

  await post(f.agent, path, path + '/resume', {});
  await Promise.all([run(), run()]);
  await run();
  const charge = await f.db.prepare('SELECT id,amount_cents,due_date,recurring_series_id FROM charges').first();
  assert.equal(charge.recurring_series_id, id);
  assert.equal(charge.due_date, due);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM charges').first()).n, 1);
  assert.ok(f.calls.filter(call => call.key).every(call => call.key === charge.id));
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0].bcc, ['admin@mrpag.local']);
  assert.deepEqual(f.messages[0].to, ['pix@example.com']);
  assert.match(f.messages[0].text, /Descrição: Mensalidade/);
  assert.match(f.messages[0].html, /Mensalidade/);
  assert.match((await f.agent.request(path)).text, new RegExp('/charges/' + charge.id));
  assert.match((await f.agent.request('/charges/' + charge.id)).text, /Ver série/);
  await createCharge(f);
  const listing = (await f.agent.request('/charges')).text;
  assert.match(listing, /Cobranças Recorrentes[\s\S]*Cobranças Avulsas/);
  assert.ok(listing.includes('/charges/recurring/' + id));
  assert.ok(listing.includes('/charges/' + chargeId));
  assert.ok(!listing.includes('/charges/' + charge.id));
  assert.equal((await f.agent.request(root + '?page=2')).headers.get('location'), '/charges?recurringPage=2#recorrentes');
  const expected = new Date(due + 'T12:00:00Z');
  const day = expected.getUTCDate();
  expected.setUTCDate(1);
  expected.setUTCMonth(expected.getUTCMonth() + 2);
  const monthEnd = new Date(Date.UTC(expected.getUTCFullYear(), expected.getUTCMonth() + 1, 0)).getUTCDate();
  expected.setUTCDate(Math.min(day, monthEnd));
  assert.equal((await f.db.prepare('SELECT next_due_date FROM charge_recurring_series').first()).next_due_date,
    expected.toISOString().slice(0, 10));

  await post(f.agent, path, path, { description: 'Mensalidade atualizada', amount: '59,90', lead_days: '3' });
  assert.equal((await f.db.prepare('SELECT amount_cents FROM charge_recurring_series').first()).amount_cents, 5990);
  assert.equal((await f.db.prepare('SELECT amount_cents FROM charges').first()).amount_cents, 4990);
  await post(f.agent, path, path + '/end', {});
  await post(f.agent, '/charges/new', path + '/resume', {});
  assert.equal((await f.db.prepare('SELECT status FROM charge_recurring_series').first()).status, 'ended');
  await f.db.prepare("UPDATE charges SET status='creation_error',provider_id=NULL,created_at=0 WHERE id=?").bind(charge.id).run();
  assert.match((await f.agent.request('/charges')).text, /Emissão a conferir/);
  assert.match((await f.agent.request(path)).text, /Confira a emissão no Mercado Pago/);
});

test('recorrências aceitam os quatro intervalos e preservam a referência ao ajustar meses curtos', async t => {
  const f = await setup(t, { bindings: { MAIL_MODE: 'disabled' } });
  await configure(f);
  const root = '/charges/recurring';
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const ids = [];
  for (const interval of [1, 2, 6, 12]) {
    const id = crypto.randomUUID();
    ids.push(id);
    const response = await post(f.agent, root + '/new', root, {
      request_id: id, customer_id: '1', description: 'Serviço', amount: '49,90',
      interval_months: String(interval), first_due: tomorrow, lead_days: '0',
    });
    assert.equal(response.status, 303);
  }
  const listing = await f.agent.request('/charges');
  for (const label of ['Mensal', 'Bimestral', 'Semestral', 'Anual']) assert.match(listing.text, new RegExp('>' + label + '<'));
  // An annual February cycle keeps the day-31 reference and uses the last available day.
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const [year, month] = today.split('-').map(Number);
  const targetYear = month <= 2 ? year : year + 1;
  const currentDate = `${targetYear - 1}-02-28`;
  await f.db.prepare(`UPDATE charge_recurring_series SET due_day=31,next_due_date=?,next_issue_date=?
    WHERE id=?`).bind(currentDate, currentDate, ids[3]).run();
  const worker = await f.mf.getWorker();
  await runChargeCron(worker);
  const targetDay = new Date(Date.UTC(targetYear,2,0)).getUTCDate();
  const expected = `${targetYear}-02-${targetDay}`;
  const actual = await f.db.prepare('SELECT next_due_date FROM charge_recurring_series WHERE id=?').bind(ids[3]).first();
  const days = [(await f.db.prepare('SELECT due_date FROM charges WHERE recurring_series_id=?').bind(ids[3]).first())?.due_date, actual.next_due_date];
  assert.ok(days.includes(expected) || (today >= expected && days.includes(`${targetYear + 1}-02-${new Date(Date.UTC(targetYear + 1,2,0)).getUTCDate()}`)));
});

test('domínio opcional muda somente o e-mail do Mercado Pago na cobrança avulsa e no retry', async t => {
  const f = await setup(t, { origin: 'https://pag.example.com',
    bindings: { MERCADO_PAGO_PAYER_EMAIL_DOMAIN: ' MXSoft.com.br ' }, expectedPayer: 'pix@mxsoft.com.br' });
  await configure(f);
  f.failFirst(503);
  await createCharge(f);
  const path = `/charges/${chargeId}`;
  assert.equal((await post(f.agent, path, path + '/retry', {})).status, 303);
  const charge = await f.db.prepare('SELECT provider_payload, notification_email, status FROM charges').first();
  assert.equal(charge.status, 'pending');
  assert.equal(JSON.parse(charge.provider_payload).payer.email, 'pix@mxsoft.com.br');
  assert.equal(charge.notification_email, 'pix@example.com');
  const worker = await f.mf.getWorker();
  await runChargeCron(worker);
  assert.deepEqual(f.messages[0].to, ['pix@example.com']);
});

test('domínio em branco mantém o endereço real e o gatilho antigo continua compatível', async t => {
  const f = await setup(t, { bindings: { MERCADO_PAGO_PAYER_EMAIL_DOMAIN: '  ' } });
  await configure(f);
  f.failFirst(503);
  await createCharge(f);
  await f.db.prepare('UPDATE charges SET notification_email=NULL').run();
  const path = `/charges/${chargeId}`;
  await post(f.agent, path, path + '/retry', {});
  assert.equal((await f.db.prepare('SELECT recipient FROM charge_emails').first()).recipient, 'pix@example.com');
});

function notificationDate(offset = 0) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' })
    .format(new Date(Date.now() + offset * 86400000));
}

function runChargeCron(worker, utcTime = '11:00') {
  const scheduledTime = Date.parse(`${notificationDate()}T${utcTime}:00Z`);
  return worker.scheduled({ cron: '*/5 * * * *', scheduledTime });
}

test('lembrete habilitado consulta o Mercado Pago, usa e-mail real e sai uma vez', async t => {
  const f = await setup(t, { origin: 'https://pag.example.com',
    bindings: { MERCADO_PAGO_PAYER_EMAIL_DOMAIN: 'mxsoft.com.br' }, expectedPayer: 'pix@mxsoft.com.br' });
  await configure(f);
  const settings = '/account/notifications';
  assert.match((await f.agent.request(settings)).text, /Lembretes de vencimento/);
  assert.equal((await post(f.agent, settings, settings, { before_due: 'on', confirmation: 'on' })).status, 303);
  await createCharge(f, { due_date: notificationDate(3) });
  const worker = await f.mf.getWorker();
  await runChargeCron(worker, '13:00');
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM charge_emails WHERE purpose='before_due'").first()).n, 0);
  const run = () => runChargeCron(worker);
  await run();
  await run();
  const reminders = f.messages.filter(message => message.subject.startsWith('Aviso de vencimento'));
  assert.equal(reminders.length, 1);
  assert.deepEqual(reminders[0].to, ['pix@example.com']);
  assert.equal(f.calls.filter(call => call.path === '/v1/orders/' + orderId).length, 1);
});

test('lembrete adia falha de consulta e é dispensado se o pagamento já entrou no Mercado Pago', async t => {
  const f = await setup(t, { origin: 'https://pag.example.com' });
  await configure(f);
  const settings = '/account/notifications';
  await post(f.agent, settings, settings, { before_due: 'on' });
  await createCharge(f, { due_date: notificationDate(3) });
  const worker = await f.mf.getWorker();
  const run = () => runChargeCron(worker);
  f.failRefresh(503);
  await run();
  const attempt = () => f.db.prepare(`SELECT e.status,a.result FROM charge_emails e JOIN charge_email_attempts a
    ON a.email_id=e.id AND a.number=e.attempt_count WHERE e.purpose='before_due'`).first();
  assert.deepEqual(await attempt(), { status: 'queued', result: 'mail_payment_check_failed' });

  f.failRefresh(null);
  f.approveOrder(new Date(Date.now() + 1000).toISOString());
  await f.db.prepare("UPDATE charge_emails SET next_at=0 WHERE purpose='before_due'").run();
  await run();
  assert.deepEqual(await attempt(), { status: 'skipped', result: 'charge_unavailable' });
  assert.equal((await f.db.prepare('SELECT status FROM charges').first()).status, 'paid');
  assert.equal(f.messages.filter(message => /Aviso de vencimento|confirmado/.test(message.subject)).length, 0);
});

test('modelos de teste são enviados apenas ao usuário autenticado sem gravar cobranças, fila ou preferências', async t => {
  const f = await setup(t);
  const path = '/account/notifications';
  const models = ['charge','before_due','due_today','overdue','confirmation'];
  const outsider = agent(f.mf);
  assert.equal((await outsider.request(path)).headers.get('location'), '/login');
  for (const model of models) {
    const preview = await post(f.agent, path, path + '?preview=' + model, {
      email: 'forged@example.com', before_due: 'on',
    });
    assert.equal(preview.headers.get('location'), path + '?test=sent');
  }
  assert.equal((await post(f.agent, path, path + '?preview=unknown', {})).status, 400);
  assert.equal(f.messages.length, models.length);
  assert.deepEqual(f.messages.map(message => message.subject), [
    'Você tem um novo pagamento',
    'Aviso de vencimento: faltam 3 dias',
    'Aviso de vencimento: sua cobrança vence hoje',
    'Aviso de atraso: sua cobrança venceu há 3 dias',
    'Pagamento confirmado',
  ].map(subject => `[Teste] ${subject} — MR Pag`));
  for (const message of f.messages) {
    assert.deepEqual(message.to, ['admin@mrpag.local']);
    assert.match(message.html, /E-mail de teste/);
    assert.match(message.html, /<h1[^>]*>Mensalidade de serviços — exemplo<\/h1>/);
    assert.doesNotMatch(message.html, /href=/);
    assert.match(message.text, /dados fictícios/);
    assert.doesNotMatch(message.text + message.html, /\bPix\b/i);
  }
  for (const table of ['charges','charge_emails','charge_notification_settings']) {
    assert.equal((await f.db.prepare(`SELECT count(*) AS total FROM ${table}`).first()).total, 0);
  }
});

test('nova tentativa enfileirada antes da atualização preserva o corpo original do Resend', async t => {
  const f = await setup(t, { origin: 'https://pag.example.com' });
  await configure(f);
  await createCharge(f);
  await f.db.prepare('UPDATE charge_emails SET attempt_count=1,layout_version=0,next_at=0').run();
  const worker = await f.mf.getWorker();
  await runChargeCron(worker);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].html, undefined);
  assert.match(f.messages[0].text, /^Você recebeu uma cobrança Pix pelo MR Pag\./);
  assert.match(f.messages[0].text, /Consulte a cobrança:\nhttps:/);
});
