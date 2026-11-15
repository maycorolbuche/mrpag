CREATE TABLE charge_notification_settings (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  before_due INTEGER NOT NULL DEFAULT 0 CHECK(before_due IN (0,1)),
  due_today INTEGER NOT NULL DEFAULT 0 CHECK(due_today IN (0,1)),
  overdue INTEGER NOT NULL DEFAULT 0 CHECK(overdue IN (0,1)),
  confirmation INTEGER NOT NULL DEFAULT 1 CHECK(confirmation IN (0,1))
);
ALTER TABLE charge_emails ADD COLUMN purpose TEXT NOT NULL DEFAULT 'charge'
  CHECK(purpose IN ('charge','before_due','due_today','overdue','confirmation'));

CREATE INDEX charge_notification_due ON charges(due_date,status) WHERE provider_id IS NOT NULL;

CREATE TRIGGER queue_paid_charge_email
AFTER UPDATE OF status ON charges
WHEN NEW.status='paid' AND OLD.status IS NOT 'paid'
  AND NEW.public_token IS NOT NULL
  AND COALESCE((SELECT confirmation FROM charge_notification_settings WHERE account_id=NEW.account_id),1)=1
  AND COALESCE(NEW.notification_email,json_extract(NEW.provider_payload,'$.payer.email'),'')<>''
BEGIN
  INSERT INTO charge_emails(id,charge_id,recipient,bcc,kind,purpose,created_at,next_at)
  VALUES ('confirmation/'||NEW.id,NEW.id,COALESCE(NEW.notification_email,json_extract(NEW.provider_payload,'$.payer.email')),
    NEW.issuer_email,'initial','confirmation',unixepoch()*1000,unixepoch()*1000)
  ON CONFLICT(id) DO NOTHING;
END;
