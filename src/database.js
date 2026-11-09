import { DatabaseSync } from 'node:sqlite';
import session from 'express-session';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1,
      password_changed_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS resets (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  return db;
}

export class SqliteStore extends session.Store {
  constructor(db) { super(); this.db = db; }
  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT data FROM sessions WHERE sid=? AND expires>?').get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (error) { cb(error); }
  }
  set(sid, value, cb = () => {}) {
    try {
      this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)').run(sid, JSON.stringify(value), new Date(value.cookie.expires).getTime());
      cb();
    } catch (error) { cb(error); }
  }
  destroy(sid, cb = () => {}) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(); } catch (error) { cb(error); }
  }
}
