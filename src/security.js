const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
export const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
async function derive(password, salt, pepper) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const input = await crypto.subtle.sign('HMAC', key, encoder.encode(password));
  const material = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, material, 256));
}
// Workers WebCrypto caps PBKDF2 at 100k iterations. A separate secret pepper is mandatory.
export async function hashPassword(password, pepper) {
  if (!pepper || pepper.length < 32) throw new Error('PASSWORD_PEPPER deve ter pelo menos 32 caracteres.');
  const salt = token();
  return `pbkdf2-sha256:100000:${salt}:${await derive(password, salt, pepper)}`;
}
export async function verifyPassword(password, encoded, pepper) {
  const [algorithm, iterations, salt, expected] = encoded.split(':');
  if (algorithm !== 'pbkdf2-sha256' || iterations !== '100000' || !salt || !/^[a-f0-9]{64}$/.test(expected || '')) return false;
  const actual = await derive(password, salt, pepper);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
export function passwordError(password, confirmation) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) return 'Use uma senha com 12 a 128 caracteres.';
  return password !== confirmation ? 'A confirmação não corresponde à nova senha.' : null;
}
export async function limited(db, key, max, now = Date.now()) {
  const row = await db.prepare(`INSERT INTO attempts(key,count,expires) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
    expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING count`)
    .bind(await digest(key), now + 900000, now, now).first();
  return row.count > max;
}
