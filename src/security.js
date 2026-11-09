import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const token = () => randomBytes(32).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [salt, key] = encoded.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(key, 'hex'));
}
export function passwordError(password, confirmation) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) return 'Use uma senha com 12 a 128 caracteres.';
  if (password !== confirmation) return 'A confirmação não corresponde à nova senha.';
  return null;
}
// Persisted limits survive restarts. Do not use untrusted forwarding headers as identity.
export function limited(db, key, max, minutes = 15) {
  const now = Date.now();
  db.prepare('DELETE FROM attempts WHERE expires<=?').run(now);
  db.prepare('INSERT INTO attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(digest(key), now + minutes * 60000);
  return db.prepare('SELECT count FROM attempts WHERE key=?').get(digest(key)).count > max;
}
