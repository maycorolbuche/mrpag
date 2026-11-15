import { businessDate, chargeMoney, displayDueDate } from './charge-emails.js';
import { isChargeEmailPurpose, sendChargeEmail } from './mail.js';

const settingsPath = '/account/notifications';

export async function notificationSettings({ request, url, env, db, accountId, actorEmail, body, show, redirect }) {
  const render = async (error = null, status = 200) => {
    const notifications = await db.prepare('SELECT * FROM charge_notification_settings WHERE account_id=?').bind(accountId).first();
    return show('charge-notifications', {
      notifications: notifications || { confirmation: 1 }, error,
      success: request.method === 'GET' && url.searchParams.get('test') === 'sent'
        ? 'E-mail de teste aceito pelo serviço de envio.' : null,
    }, status);
  };
  if (request.method === 'POST' && url.searchParams.has('preview')) {
    const purpose = url.searchParams.get('preview');
    if (!isChargeEmailPurpose(purpose)) return render('Modelo de e-mail inválido.', 400);
    const offset = { charge: 7, before_due: 3, due_today: 0, overdue: -3, confirmation: 0 }[purpose];
    const due = new Date(businessDate(new Date()) + 'T12:00:00Z');
    due.setUTCDate(due.getUTCDate() + offset);
    try {
      await sendChargeEmail(env, {
        email: actorEmail, purpose, amount: chargeMoney.format(149.90),
        dueDate: displayDueDate(due.toISOString().slice(0, 10)), preview: true,
      });
      return redirect(settingsPath + '?test=sent');
    } catch (error) {
      return render(error.message === 'mail_not_configured'
        ? 'Configure o serviço de e-mail do MR Pag antes de enviar um teste.'
        : 'O serviço de e-mail não confirmou o envio de teste. Confira as configurações e tente novamente.', 502);
    }
  }
  if (request.method === 'POST') {
    await db.prepare(`INSERT INTO charge_notification_settings(account_id,before_due,due_today,overdue,confirmation)
      VALUES (?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET before_due=excluded.before_due,
      due_today=excluded.due_today,overdue=excluded.overdue,confirmation=excluded.confirmation`)
      .bind(accountId, ...['before_due','due_today','overdue','confirmation'].map(name => Number(body[name] === 'on'))).run();
    return redirect(settingsPath + '?saved=1');
  }
  return render();
}

export async function queueChargeReminders(db, now = new Date()) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(now);
  if (Number(time) < 8) return;
  const today = businessDate(now);
  const timestamp = Date.now();
  if (today !== businessDate(new Date(timestamp))) return;
  await db.prepare(`WITH alerts(purpose,due_date) AS (
    VALUES ('before_due',date(?,'+3 days')),('due_today',?),('overdue',date(?,'-3 days'))
  )
  INSERT INTO charge_emails(id,charge_id,recipient,bcc,kind,purpose,created_at,next_at)
  SELECT alerts.purpose||'/'||c.id,c.id,COALESCE(c.notification_email,json_extract(c.provider_payload,'$.payer.email')),
    c.issuer_email,'initial',alerts.purpose,?,?
  FROM alerts JOIN charges c ON c.due_date=alerts.due_date
    JOIN charge_notification_settings n ON n.account_id=c.account_id
  WHERE c.provider_id IS NOT NULL AND c.public_token IS NOT NULL AND
    COALESCE(c.notification_email,json_extract(c.provider_payload,'$.payer.email'),'')<>''
    AND ((alerts.purpose='before_due' AND n.before_due=1 AND c.status='pending')
      OR (alerts.purpose='due_today' AND n.due_today=1 AND c.status='pending')
      OR (alerts.purpose='overdue' AND n.overdue=1 AND c.status IN ('pending','expired')))
    AND NOT EXISTS (SELECT 1 FROM charge_emails e WHERE e.id=alerts.purpose||'/'||c.id)
  ORDER BY c.id,alerts.purpose LIMIT 100
  ON CONFLICT(id) DO NOTHING`).bind(today,today,today,timestamp,timestamp).run();
}
