ALTER TABLE payment_integrations ADD COLUMN oauth_collector_id TEXT;
ALTER TABLE payment_integrations ADD COLUMN oauth_live_mode INTEGER;
ALTER TABLE payment_integrations ADD COLUMN oauth_refresh_until INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX payment_oauth_account_collector
  ON payment_integrations(account_id, oauth_collector_id, oauth_live_mode)
  WHERE oauth_collector_id IS NOT NULL;

CREATE INDEX charges_provider_id ON charges(provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE payment_oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_token TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX payment_oauth_states_session ON payment_oauth_states(session_token);
