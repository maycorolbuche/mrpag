ALTER TABLE charges ADD COLUMN issuer_email TEXT;
ALTER TABLE charge_emails ADD COLUMN bcc TEXT;

DROP TRIGGER queue_initial_charge_email;
CREATE TRIGGER queue_initial_charge_email
AFTER UPDATE OF status, pix_code, pix_image ON charges
WHEN NEW.status='pending' AND NEW.provider_id IS NOT NULL
  AND NEW.public_token IS NOT NULL AND (NEW.pix_code IS NOT NULL OR NEW.pix_image IS NOT NULL)
  AND NEW.auto_email=1
  AND (OLD.provider_id IS NULL OR OLD.status!='pending' OR (OLD.pix_code IS NULL AND OLD.pix_image IS NULL))
  AND coalesce(json_extract(NEW.provider_payload,'$.payer.email'),'')!=''
BEGIN
  INSERT INTO charge_emails(id,charge_id,recipient,bcc,kind,created_at,next_at)
  VALUES ('initial/'||NEW.id, NEW.id, json_extract(NEW.provider_payload,'$.payer.email'), NEW.issuer_email, 'initial',
    unixepoch()*1000, unixepoch()*1000)
  ON CONFLICT(id) DO NOTHING;
END;
