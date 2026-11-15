ALTER TABLE charges ADD COLUMN provider_api TEXT NOT NULL DEFAULT 'payments'
  CHECK(provider_api IN ('payments', 'orders'));

-- OAuth integrations are scoped by application as well as seller and environment.
-- The deterministic primary key deduplicates connections to the same application.
DROP INDEX payment_oauth_account_collector;
