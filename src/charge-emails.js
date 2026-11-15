import { sendChargeEmail } from './mail.js';

export const businessDate = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(date);
export const chargeMoney = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const displayDueDate = date => date.split('-').reverse().join('/');
export const paymentLink = (origin, token) => `${origin}/pay/${token}`;

const lease = 120_000;
const retryDelays = [5, 30, 120].map(minutes => minutes * 60_000);
const maxAge = 20 * 60 * 60_000;

export async function chargeEmailHistory(db, chargeId) {
  const { results } = await db.prepare(`SELECT e.kind,e.recipient,e.status,e.created_at,a.number,a.started_at,a.result
    FROM charge_emails e LEFT JOIN charge_email_attempts a ON a.email_id=e.id
    WHERE e.charge_id=? ORDER BY e.created_at DESC,e.id DESC,a.number DESC LIMIT 30`).bind(chargeId).all();
  return results;
}

export async function queueManualChargeEmail(db, charge, requestId, actorEmail) {
  const now = Date.now();
  await db.prepare(`INSERT INTO charge_emails(id,charge_id,recipient,bcc,kind,created_at,next_at)
    SELECT ?,c.id,u.email,?,'manual',?,? FROM charges c
    JOIN customers u ON u.id=c.customer_id AND u.account_id=c.account_id
    WHERE c.id=? AND c.account_id=? AND u.email<>'' AND c.status='pending'
      AND c.due_date>=? AND c.provider_id IS NOT NULL AND c.public_token IS NOT NULL
      AND (c.pix_code IS NOT NULL OR c.pix_image IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM charge_emails e WHERE e.charge_id=c.id AND e.status IN ('queued','sending'))
    ON CONFLICT(id) DO NOTHING`)
    .bind(`manual/${charge.id}/${requestId}`, actorEmail, now, now, charge.id, charge.account_id, businessDate(new Date(now))).run();
}

async function finish(db, job, status, result, nextAt = 0) {
  const now = Date.now();
  await db.batch([
    db.prepare(`UPDATE charge_email_attempts SET finished_at=?,result=? WHERE email_id=? AND number=?
      AND EXISTS (SELECT 1 FROM charge_emails WHERE id=? AND status='sending' AND lease_until=?)`)
      .bind(now, result, job.id, job.attempt_count, job.id, job.lease_until),
    db.prepare(`UPDATE charge_emails SET status=?,next_at=?,lease_until=0
      WHERE id=? AND status='sending' AND lease_until=?`)
      .bind(status, nextAt, job.id, job.lease_until),
  ]);
}

async function deliver(env, origin, id) {
  const db = env.DB;
  const now = Date.now();
  const job = await db.prepare(`UPDATE charge_emails SET status='sending',lease_until=?,attempt_count=attempt_count+1
    WHERE id=? AND status IN ('queued','sending') AND next_at<=? AND lease_until<=?
    AND NOT EXISTS (SELECT 1 FROM charge_email_attempts a WHERE a.email_id=charge_emails.id
      AND a.number=charge_emails.attempt_count AND a.result='smtp_data_started')
    RETURNING *`)
    .bind(now + lease, id, now, now).first();
  if (!job) {
    const stale = await db.prepare(`SELECT e.* FROM charge_emails e JOIN charge_email_attempts a
      ON a.email_id=e.id AND a.number=e.attempt_count
      WHERE e.id=? AND e.status='sending' AND e.lease_until<=? AND a.result='smtp_data_started'`).bind(id, now).first();
    if (stale) await finish(db, stale, 'failed', 'mail_smtp_delivery_unknown');
    return;
  }

  const charge = await db.prepare('SELECT status,due_date,amount_cents,public_token,provider_id FROM charges WHERE id=?')
    .bind(job.charge_id).first();
  if (charge.status !== 'pending' || !charge.provider_id || charge.due_date < businessDate(new Date(now))) {
    await finish(db, job, 'skipped', 'charge_unavailable');
    return;
  }
  if (now - job.created_at >= maxAge || job.attempt_count > retryDelays.length + 1) {
    await finish(db, job, 'failed', 'retry_window_closed');
    return;
  }

  let result = 'sent';
  try {
    await sendChargeEmail(env, {
      email: job.recipient, bcc: job.bcc, url: paymentLink(origin, charge.public_token),
      amount: chargeMoney.format(charge.amount_cents / 100),
      dueDate: displayDueDate(charge.due_date), idempotencyKey: job.id,
      async beforeSmtpData() {
        const marked = await db.prepare(`UPDATE charge_email_attempts SET result='smtp_data_started'
          WHERE email_id=? AND number=? AND finished_at IS NULL
          AND EXISTS (SELECT 1 FROM charge_emails WHERE id=? AND status='sending' AND lease_until=? AND lease_until>?)`)
          .bind(job.id, job.attempt_count, job.id, job.lease_until, Date.now()).run();
        if (!marked.meta.changes) throw new Error('mail_transport_error');
      },
    });
  } catch (error) {
    result = /^mail_(not_configured|invalid_recipient|http_\d{3}|smtp_([45]\d{2}|auth_unavailable|delivery_unknown))$/.test(error.message) ? error.message : 'mail_transport_error';
  }
  if (result === 'sent') {
    await finish(db, job, 'sent', result);
    return;
  }
  const delay = retryDelays[job.attempt_count - 1];
  const transient = /^(mail_transport_error|mail_http_(409|429|5\d{2})|mail_smtp_4\d{2})$/.test(result);
  const retryAt = delay && transient ? Date.now() + delay : 0;
  await finish(db, job, retryAt ? 'queued' : 'failed', result, retryAt);
}

export async function dispatchChargeEmails(env, origin) {
  const now = Date.now();
  const { results } = await env.DB.prepare(`SELECT id FROM charge_emails WHERE status IN ('queued','sending')
    AND next_at<=? AND lease_until<=? ORDER BY next_at,id LIMIT 10`).bind(now, now).all();
  await Promise.all(results.map(({ id }) => deliver(env, origin, id)));
}
