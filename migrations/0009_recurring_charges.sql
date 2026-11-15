CREATE TABLE charge_recurring_series (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  customer_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  interval_months INTEGER NOT NULL CHECK(interval_months IN (1,2,6,12)),
  due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 31),
  lead_days INTEGER NOT NULL CHECK(lead_days BETWEEN 0 AND 28),
  next_due_date TEXT NOT NULL,
  next_issue_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','ended')),
  issuer_email TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id,id),
  FOREIGN KEY(account_id,customer_id) REFERENCES customers(account_id,id)
);
ALTER TABLE charges ADD COLUMN recurring_series_id TEXT REFERENCES charge_recurring_series(id);
CREATE UNIQUE INDEX charge_one_per_cycle ON charges(recurring_series_id,due_date) WHERE recurring_series_id IS NOT NULL;
CREATE INDEX recurring_series_schedule ON charge_recurring_series(status,next_issue_date);
CREATE INDEX recurring_series_account ON charge_recurring_series(account_id,id);
