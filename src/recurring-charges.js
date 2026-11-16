import { businessDate, chargeMoney, displayDueDate } from './charge-emails.js';
import { chargeLabels, currentIntegration, formAmount, insertPixCharge, issue, maximumRetryAge, uuid, validDueDate } from './payments.js';

const root = '/charges/recurring';
const frequencies = { 1: 'Mensal', 2: 'Bimestral', 6: 'Semestral', 12: 'Anual' };
const states = { active: 'Ativa', paused: 'Pausada', ended: 'Encerrada' };

function offsetDays(date, days) {
  const moment = new Date(date + 'T12:00:00Z');
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

export function nextCycle(dueDate, interval, day) {
  const [year, month] = dueDate.split('-').map(Number);
  const end = new Date(Date.UTC(year, month - 1 + interval + 1, 0));
  end.setUTCDate(Math.min(end.getUTCDate(), day));
  return end.toISOString().slice(0, 10);
}

function upcoming(row, today) {
  let due = row.next_due_date;
  while (due < today) due = nextCycle(due, row.interval_months, row.due_day);
  return due;
}

function decorate(row) {
  return { ...row, frequency: frequencies[row.interval_months], state: states[row.status],
    amount: chargeMoney.format(row.amount_cents / 100), due: displayDueDate(row.next_due_date) };
}

export async function recurringRoutes({ request, url, db, accountId, actorEmail, body, show, redirect }) {
  const path = url.pathname;
  const today = businessDate(new Date());
  if (path === root && request.method === 'GET') {
    const offset = Math.max(0, Math.min(100000, ((parseInt(url.searchParams.get('page'), 10) || 1) - 1) * 25));
    const { results } = await db.prepare(`SELECT r.*,u.name AS customer_name,
      EXISTS (SELECT 1 FROM charges c WHERE c.recurring_series_id=r.id AND c.provider_id IS NULL
        AND c.status IN ('creating','creation_error') AND c.created_at<?) AS emission_review
      FROM charge_recurring_series r
      JOIN customers u ON u.id=r.customer_id AND u.account_id=r.account_id WHERE r.account_id=?
      ORDER BY r.status='ended',r.next_issue_date,r.id LIMIT 26 OFFSET ?`).bind(Date.now() - maximumRetryAge, accountId, offset).all();
    return show('recurring-list', { seriesRows: results.slice(0, 25).map(decorate),
      chargePage: offset / 25 + 1, nextPage: results.length > 25 });
  }

  const [, id, action] = path.match(/^\/charges\/recurring\/([a-f0-9-]+)(?:\/(pause|resume|end))?$/) || [];
  const creating = path === root + '/new' || (path === root && request.method === 'POST');
  if (!creating && !uuid.test(id || '')) return null;
  const row = creating ? null : await db.prepare(`SELECT r.*,u.name AS customer_name,
    u.active=1 AND u.email<>'' AND u.document IS NOT NULL AS customer_ready FROM charge_recurring_series r
    JOIN customers u ON u.id=r.customer_id AND u.account_id=r.account_id WHERE r.id=? AND r.account_id=?`)
    .bind(id, accountId).first();
  if (!creating && !row) return null;

  if (action) {
    if (request.method !== 'POST') return null;
    const [before, after] = { pause: ['active','paused'], resume: ['paused','active'],
      end: [row.status,'ended'] }[action];
    const due = action === 'resume' ? upcoming(row, today) : row.next_due_date;
    await db.prepare(`UPDATE charge_recurring_series SET status=?,next_due_date=?,next_issue_date=?,revision=revision+1
      WHERE id=? AND account_id=? AND status=? AND revision=? AND status!='ended'`)
      .bind(after, due, offsetDays(due, -row.lead_days), id, accountId, before, row.revision).run();
    return redirect(root + '/' + id);
  }

  const customers = creating ? (await db.prepare(`SELECT id,name FROM customers WHERE account_id=? AND active=1
    AND email<>'' AND document IS NOT NULL ORDER BY name,id`).bind(accountId).all()).results : [];
  const cycles = row ? (await db.prepare(`SELECT id,due_date,status,amount_cents,provider_id,created_at FROM charges
    WHERE account_id=? AND recurring_series_id=? ORDER BY due_date DESC LIMIT 25`).bind(accountId,id).all()).results : [];
  const recurringWarning = row?.status === 'active' && !row.customer_ready
    ? 'A emissão fica aguardando um cadastro de cliente ativo com e-mail e CPF ou CNPJ.' : null;
  const fields = request.method === 'POST' ? body : row
    ? { ...row, amount: (row.amount_cents / 100).toFixed(2).replace('.', ',') }
    : { request_id: crypto.randomUUID(), interval_months: 1, first_due: offsetDays(today, 5), lead_days: 5 };
  const render = (error = null, status = 200) => show('recurring-detail', {
    recurringSeries: row ? decorate(row) : null, recurringFields: fields, customers, cycles: cycles.map(cycle => ({ ...cycle,
      needsReview: !cycle.provider_id && ['creating','creation_error'].includes(cycle.status) &&
        cycle.created_at < Date.now() - maximumRetryAge,
      label: chargeLabels[cycle.status === 'pending' && cycle.due_date < today ? 'expired' : cycle.status] })),
    frequencies, error, today, recurringWarning,
    fmtDue: displayDueDate, fmtMoney: cents => chargeMoney.format(cents / 100),
  }, status);
  if (request.method === 'GET') return render();
  if (row?.status === 'ended') return render('Esta recorrência foi encerrada.', 409);
  const cents = formAmount(body.amount || '');
  const description = (body.description || '').trim();
  const lead = body.lead_days || '';
  if (!cents || !description || description.length > 150 || !/^(?:[0-9]|1[0-9]|2[0-8])$/.test(lead)) {
    return render('Informe descrição, valor positivo e antecedência de 0 a 28 dias.', 422);
  }
  if (row) {
    const edited = await db.prepare(`UPDATE charge_recurring_series SET description=?,amount_cents=?,lead_days=?,next_issue_date=?,revision=revision+1
      WHERE id=? AND account_id=? AND status!='ended' AND revision=?`)
      .bind(description, cents, Number(lead), offsetDays(row.next_due_date, -Number(lead)), id, accountId, row.revision).run();
    if (!edited.meta.changes) return render('A recorrência mudou enquanto você editava. Atualize a página e tente novamente.', 409);
    return redirect(root + '/' + id);
  }

  const date = body.first_due || '';
  const moment = new Date(date + 'T12:00:00Z');
  const frequency = body.interval_months;
  if (!uuid.test(body.request_id || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < today || !Number.isFinite(moment.valueOf()) ||
      moment.toISOString().slice(0, 10) !== date || !Object.hasOwn(frequencies, frequency)) {
    return render('Informe a frequência e um primeiro vencimento válido a partir de hoje.', 422);
  }
  const customer = customers.find(entry => String(entry.id) === body.customer_id);
  if (!customer) return render('Selecione um cliente ativo com e-mail e CPF ou CNPJ cadastrados.', 422);
  if (!await currentIntegration(db, accountId)) return render('Configure o Mercado Pago em Cobranças → Integrações.', 422);
  await db.prepare(`INSERT INTO charge_recurring_series(id,account_id,customer_id,description,amount_cents,
    interval_months,due_day,lead_days,next_due_date,next_issue_date,issuer_email)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(body.request_id,accountId,customer.id,description,cents,Number(frequency),moment.getUTCDate(),
      Number(lead),date,offsetDays(date,-Number(lead)),actorEmail).run();
  return redirect(root + '/' + body.request_id);
}

async function scheduleCycle(env, series, today) {
  const db = env.DB;
  const due = upcoming(series, today);
  const issueDate = offsetDays(due, -series.lead_days);
  const canIssue = issueDate <= today && validDueDate(due);
  const next = canIssue || (due === today && !validDueDate(due))
    ? nextCycle(due, series.interval_months, series.due_day) : due;
  if (!canIssue && next === series.next_due_date) return;
  const advance = (nextDue, requireCharge) => db.prepare(`UPDATE charge_recurring_series
    SET next_due_date=?,next_issue_date=?,revision=revision+1 WHERE id=? AND account_id=?
    AND status='active' AND revision=? AND next_due_date=?
    ${requireCharge ? 'AND EXISTS (SELECT 1 FROM charges WHERE recurring_series_id=? AND due_date=?)' : ''}`)
    .bind(nextDue,offsetDays(nextDue,-series.lead_days),series.id,series.account_id,series.revision,series.next_due_date,
      ...(requireCharge ? [series.id, due] : []));
  if (!canIssue) {
    await advance(next, false).run();
    return;
  }
  const integration = await currentIntegration(db, series.account_id);
  if (!integration) return;
  const customer = { id: series.customer_id, name: series.customer_name, email: series.customer_email, document: series.customer_document };
  const insert = insertPixCharge(db, env, { id: crypto.randomUUID(), accountId: series.account_id, integrationId: integration.id,
    customer, description: series.description, cents: series.amount_cents, dueDate: due, actorEmail: series.issuer_email, series });
  await db.batch([insert, advance(next, true)]);
}

export async function dispatchRecurringCharges(env) {
  const today = businessDate(new Date());
  const { results: series } = await env.DB.prepare(`SELECT r.*,u.name AS customer_name,u.email AS customer_email,u.document AS customer_document
    FROM charge_recurring_series r JOIN customers u ON u.id=r.customer_id AND u.account_id=r.account_id
    JOIN payment_integration_defaults d ON d.account_id=r.account_id
    WHERE r.status='active' AND r.next_issue_date<=? AND u.active=1 AND u.email<>'' AND u.document IS NOT NULL
    ORDER BY r.next_issue_date,r.id LIMIT 5`).bind(today).all();
  for (const row of series) await scheduleCycle(env, row, today);
  const { results: charges } = await env.DB.prepare(`SELECT * FROM charges WHERE recurring_series_id IS NOT NULL
    AND provider_id IS NULL AND status IN ('creating','creation_error') AND created_at>=?
    AND due_date>=? ORDER BY created_at,id LIMIT 5`).bind(Date.now() - maximumRetryAge,today).all();
  for (const charge of charges) await issue({ db: env.DB, env }, charge);
}
