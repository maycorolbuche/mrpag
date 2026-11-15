CREATE TABLE payment_integrations (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK(provider = 'mercado-pago'),
  credentials TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, id)
);
CREATE TABLE payment_integration_defaults (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  integration_id TEXT NOT NULL,
  FOREIGN KEY(account_id, integration_id) REFERENCES payment_integrations(account_id, id)
);
CREATE UNIQUE INDEX customers_account_id ON customers(account_id, id);
CREATE TABLE charges (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  customer_id INTEGER NOT NULL,
  integration_id TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  due_date TEXT NOT NULL,
  provider_payload TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'creating',
  provider_updated_at INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  pix_code TEXT,
  pix_image TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(account_id, customer_id) REFERENCES customers(account_id, id),
  FOREIGN KEY(account_id, integration_id) REFERENCES payment_integrations(account_id, id),
  UNIQUE(integration_id, provider_id)
);
CREATE INDEX charges_account_created ON charges(account_id, created_at DESC, id);
