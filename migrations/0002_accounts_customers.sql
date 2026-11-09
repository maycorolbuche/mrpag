CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 120),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Each pre-existing user starts in their own account, preserving all credentials.
INSERT INTO accounts(id,name,created_at,updated_at)
SELECT id, substr('Conta de ' || name,1,120), unixepoch()*1000, unixepoch()*1000 FROM users;
ALTER TABLE users ADD COLUMN account_id INTEGER REFERENCES accounts(id);
UPDATE users SET account_id=id;
CREATE INDEX users_account ON users(account_id);
CREATE TRIGGER users_account_required_insert BEFORE INSERT ON users
WHEN NEW.account_id IS NULL BEGIN SELECT RAISE(ABORT,'users.account_id is required'); END;
CREATE TRIGGER users_account_required_update BEFORE UPDATE OF account_id ON users
WHEN NEW.account_id IS NULL BEGIN SELECT RAISE(ABORT,'users.account_id is required'); END;
ALTER TABLE sessions ADD COLUMN account_id INTEGER REFERENCES accounts(id);
UPDATE sessions SET account_id=(SELECT account_id FROM users WHERE users.id=sessions.user_id) WHERE user_id IS NOT NULL;
CREATE INDEX sessions_account ON sessions(account_id);
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  person_type TEXT NOT NULL CHECK(person_type IN ('person','company')),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 150),
  trade_name TEXT NOT NULL DEFAULT '',
  document TEXT,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  street TEXT NOT NULL DEFAULT '',
  number TEXT NOT NULL DEFAULT '',
  complement TEXT NOT NULL DEFAULT '',
  neighborhood TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id,document)
);
CREATE INDEX customers_account_name ON customers(account_id,name COLLATE NOCASE,id);
CREATE INDEX customers_account_active ON customers(account_id,active);
