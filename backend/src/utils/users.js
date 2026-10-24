import { db } from '../db/index.js';

export const LOCALES = ['en', 'fr'];

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
export const looksLikeEmail = (email) => email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

// What the API reveals about an account. Never include hashes or secrets.
export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    is_admin: !!row.is_admin,
    locale: row.locale,
    must_change_password: !!row.must_change_password,
    totp_enabled: !!row.totp_enabled_at,
  };
}

export const userById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export const userByEmail = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));

// Active (not disabled) admins, optionally ignoring one account -- used to make
// sure the household can never be left without anyone able to administer it.
export function otherActiveAdmins(exceptUserId) {
  return db
    .prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND disabled_at IS NULL AND id != ?')
    .get(exceptUserId).c;
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}
