import { audit } from './audit.js';
import { verifyPassword } from './crypto.js';
import { blocked, reauthThrottle } from './limits.js';
import { verifySecondFactor } from './mfa.js';
import { userById } from './users.js';

// Sensitive actions (changing 2FA, applying a software update) need the password
// again, so a hijacked session can't quietly do them. Sends the error response
// itself and returns null on failure; returns the user row on success.
export async function reauthenticate(req, res) {
  const gate = reauthThrottle.check(String(req.user.id));
  if (gate.blocked) {
    blocked(res, gate);
    return null;
  }
  const user = userById(req.user.id);
  const password = req.body?.current_password;
  const check = typeof password === 'string' ? await verifyPassword(password, user.password_hash) : { ok: false };
  if (!check.ok) {
    reauthThrottle.fail(String(req.user.id));
    audit(req, 'reauth_failed');
    res.status(400).json({ error: 'Current password is incorrect', code: 'bad_current_password' });
    return null;
  }
  reauthThrottle.reset(String(req.user.id));
  return user;
}

// Like reauthenticate, and when the account has two-factor authentication on it
// also needs a valid code (or recovery code).
export async function reauthenticateStrong(req, res) {
  const user = await reauthenticate(req, res);
  if (!user) return null;
  if (user.totp_enabled_at && !verifySecondFactor(user, { code: req.body?.code, recoveryCode: req.body?.recovery_code })) {
    audit(req, 'mfa_failed', { detail: { during: 'reauth' } });
    res.status(400).json({ error: 'That code is not valid', code: 'mfa_invalid' });
    return null;
  }
  return user;
}
