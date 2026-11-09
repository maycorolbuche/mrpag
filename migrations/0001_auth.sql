CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password TEXT NOT NULL,
  version TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,
  password_changed_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX users_version ON users(version);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  version TEXT,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires);
CREATE TABLE resets (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX resets_user ON resets(user_id);
CREATE INDEX resets_expiry ON resets(expires);
CREATE TABLE attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX attempts_expiry ON attempts(expires);
