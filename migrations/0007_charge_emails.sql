ALTER TABLE charges ADD COLUMN public_token TEXT;
ALTER TABLE charges ADD COLUMN auto_email INTEGER NOT NULL DEFAULT 0 CHECK(auto_email IN (0,1));
UPDATE charges SET public_token=lower(hex(randomblob(32)));
CREATE UNIQUE INDEX charges_public_token ON charges(public_token);

CREATE TABLE charge_emails (
  id TEXT PRIMARY KEY,
  charge_id TEXT NOT NULL REFERENCES charges(id),
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('initial','manual')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','skipped')),
  created_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX charge_emails_due ON charge_emails(next_at) WHERE status IN ('queued','sending');
CREATE INDEX charge_emails_history ON charge_emails(charge_id,created_at);

CREATE TABLE charge_email_attempts (
  email_id TEXT NOT NULL REFERENCES charge_emails(id),
  number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT,
  PRIMARY KEY(email_id,number)
);

CREATE TRIGGER queue_initial_charge_email
AFTER UPDATE OF status, pix_code, pix_image ON charges
WHEN NEW.status='pending' AND NEW.provider_id IS NOT NULL
  AND NEW.public_token IS NOT NULL AND (NEW.pix_code IS NOT NULL OR NEW.pix_image IS NOT NULL)
  AND NEW.auto_email=1
  AND (OLD.provider_id IS NULL OR OLD.status!='pending' OR (OLD.pix_code IS NULL AND OLD.pix_image IS NULL))
  AND coalesce(json_extract(NEW.provider_payload,'$.payer.email'),'')!=''
BEGIN
  INSERT INTO charge_emails(id,charge_id,recipient,kind,created_at,next_at)
  VALUES ('initial/'||NEW.id, NEW.id, json_extract(NEW.provider_payload,'$.payer.email'), 'initial',
    unixepoch()*1000, unixepoch()*1000)
  ON CONFLICT(id) DO NOTHING;
END;

CREATE TRIGGER record_charge_email_attempt
AFTER UPDATE OF attempt_count ON charge_emails
WHEN NEW.attempt_count>OLD.attempt_count
BEGIN
  UPDATE charge_email_attempts SET finished_at=NEW.lease_until-120000,result='interrupted'
  WHERE email_id=NEW.id AND finished_at IS NULL;
  INSERT INTO charge_email_attempts(email_id,number,started_at) VALUES (NEW.id,NEW.attempt_count,NEW.lease_until-120000);
END;
