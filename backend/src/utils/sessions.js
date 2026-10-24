import { db } from '../db/index.js';
import { intEnv } from '../config.js';
import { randomToken, sha256 } from './crypto.js';

// Login sessions live in the database, not in the token. The browser only ever
// holds a random 256-bit value in an HttpOnly cookie, so:
//   - script injected into the page cannot read it,
//   - it never appears in a URL, log line or Referer header,
//   - "log out", "revoke that device" and "password changed" take effect at once.

const PLAIN = 'hv_session';
const HOST_PREFIXED = '__Host-hv_session'; // browsers only accept this name on Secure, path=/ cookies with no Domain
const MAX_SESSIONS_PER_USER = 20;
const TOUCH_INTERVAL = '-5 minutes';

export const sessionDays = () => intEnv('SESSION_DAYS', 30);
export const idleDays = () => intEnv('SESSION_IDLE_DAYS', 14);

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        /* malformed escape: ignore this cookie */
      }
    }
  }
  return out;
}

export function useSecureCookies(req) {
  const mode = process.env.COOKIE_SECURE || 'auto';
  if (mode === 'always' || process.env.FORCE_HTTPS === 'true') return true;
  if (mode === 'never') return false;
  return Boolean(req.secure); // honors X-Forwarded-Proto when TRUST_PROXY is set
}

export function tokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[HOST_PREFIXED] || cookies[PLAIN] || null;
}

const baseCookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'strict',
  path: '/',
  secure: useSecureCookies(req),
});

const insertSession = db.prepare(
  `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip, used_mfa)
   VALUES (?, ?, datetime('now', ?), ?, ?, ?)`
);
const trimSessions = db.prepare(
  `UPDATE sessions SET revoked_at = datetime('now')
   WHERE user_id = ? AND revoked_at IS NULL AND id NOT IN (
     SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT ${MAX_SESSIONS_PER_USER})`
);
const touchSession = db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ? AND last_seen_at < datetime('now', ?)");
const markLogin = db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?");

// Creates a session and sets its cookie. Returns the public session id.
export function createSession(req, res, user, { mfa = false } = {}) {
  const token = randomToken(32);
  const info = insertSession.run(
    user.id,
    sha256(token),
    `+${sessionDays()} days`,
    String(req.get('user-agent') || '').slice(0, 200),
    String(req.ip || '').slice(0, 64),
    mfa ? 1 : 0
  );
  trimSessions.run(user.id, user.id);
  markLogin.run(user.id);

  const opts = baseCookieOptions(req);
  res.clearCookie(opts.secure ? PLAIN : HOST_PREFIXED, { ...opts, secure: !opts.secure });
  res.cookie(opts.secure ? HOST_PREFIXED : PLAIN, token, { ...opts, maxAge: sessionDays() * 86_400_000 });
  return { id: Number(info.lastInsertRowid), token };
}

export function clearSessionCookie(req, res) {
  const opts = baseCookieOptions(req);
  res.clearCookie(PLAIN, { ...opts, secure: false });
  res.clearCookie(HOST_PREFIXED, { ...opts, secure: true });
}

const findSession = db.prepare(
  `SELECT s.id AS session_id, s.used_mfa,
          u.id, u.email, u.name, u.is_admin, u.locale, u.must_change_password, u.totp_enabled_at
   FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')
     AND s.last_seen_at > datetime('now', ?) AND u.disabled_at IS NULL`
);

// Resolves the request's cookie to { user, sessionId }, or null.
export function loadSession(req) {
  const token = tokenFromRequest(req);
  if (!token || token.length > 200) return null;
  const row = findSession.get(sha256(token), `-${idleDays()} days`);
  if (!row) return null;
  touchSession.run(row.session_id, TOUCH_INTERVAL);
  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      is_admin: !!row.is_admin,
      locale: row.locale,
      must_change_password: !!row.must_change_password,
      totp_enabled: !!row.totp_enabled_at,
    },
  };
}

const revokeOne = db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL");
const revokeAll = db.prepare(
  "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id != ?)"
);

export const revokeSession = (sessionId, userId) => revokeOne.run(sessionId, userId).changes > 0;

// Revokes every active session for a user, optionally keeping one (the caller's own).
export const revokeUserSessions = (userId, exceptSessionId = null) =>
  revokeAll.run(userId, exceptSessionId, exceptSessionId).changes;

export function listSessions(userId) {
  return db
    .prepare(
      `SELECT id, created_at, last_seen_at, expires_at, user_agent, ip, used_mfa
       FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now') AND last_seen_at > datetime('now', ?)
       ORDER BY last_seen_at DESC`
    )
    .all(userId, `-${idleDays()} days`)
    .map((s) => ({ ...s, used_mfa: !!s.used_mfa }));
}
