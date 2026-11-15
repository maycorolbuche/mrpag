import { businessDate } from './charge-emails.js';

const settingsPath = '/account/notifications';

export async function notificationSettings({ request, db, accountId, body, show, redirect }) {
  if (request.method === 'POST') {
    await db.prepare(`INSERT INTO charge_notification_settings(account_id,before_due,due_today,overdue,confirmation)
      VALUES (?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET before_due=excluded.before_due,
      due_today=excluded.due_today,overdue=excluded.overdue,confirmation=excluded.confirmation`)
      .bind(accountId, ...['before_due','due_today','overdue','confirmation'].map(name => Number(body[name] === 'on'))).run();
    return redirect(settingsPath + '?saved=1');
  }
  const notifications = await db.prepare('SELECT * FROM charge_notification_settings WHERE account_id=?').bind(accountId).first();
  return show('charge-notifications', { notifications: notifications || { confirmation: 1 } });
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
