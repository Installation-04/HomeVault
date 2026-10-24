import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { decryptSecret, encryptSecret, verifyPassword } from '../utils/crypto.js';
import { audit } from '../utils/audit.js';
import { blocked, reauthThrottle } from '../utils/limits.js';
import { issueRecoveryCodes, recoveryCodesRemaining, verifySecondFactor } from '../utils/mfa.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../utils/totp.js';
import { revokeUserSessions } from '../utils/sessions.js';
import { userById } from '../utils/users.js';
import { wrap } from '../utils/http.js';

export const twoFactorRouter = Router();
twoFactorRouter.use(requireAuth);

// Changing 2FA settings needs the password again, so a hijacked session can't
// quietly switch off (or take over) the second factor.
async function reauthenticate(req, res) {
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

twoFactorRouter.get('/status', (req, res) => {
  const user = userById(req.user.id);
  res.json({
    enabled: !!user.totp_enabled_at,
    enabled_at: user.totp_enabled_at,
    enrolling: !user.totp_enabled_at && !!user.totp_pending_enc,
    recovery_codes_remaining: user.totp_enabled_at ? recoveryCodesRemaining(user.id) : 0,
  });
});

// Step 1: generate a secret (not active yet) and hand back what the authenticator app needs.
twoFactorRouter.post(
  '/setup',
  wrap(async (req, res) => {
    const user = await reauthenticate(req, res);
    if (!user) return;
    if (user.totp_enabled_at) return res.status(409).json({ error: 'Two-factor authentication is already on' });

    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_pending_enc = ? WHERE id = ?').run(encryptSecret(secret), user.id);
    res.json({ secret, otpauth_url: otpauthUrl({ secret, account: user.email }) });
  })
);

// Step 2: prove the app is set up correctly by entering a code, then it switches on.
twoFactorRouter.post(
  '/enable',
  wrap(async (req, res) => {
    const user = userById(req.user.id);
    if (user.totp_enabled_at) return res.status(409).json({ error: 'Two-factor authentication is already on' });
    if (!user.totp_pending_enc) return res.status(400).json({ error: 'Start the setup first' });

    const gate = reauthThrottle.check(String(user.id));
    if (gate.blocked) return blocked(res, gate);

    const step = verifyTotp(decryptSecret(user.totp_pending_enc), req.body?.code);
    if (step === null) {
      reauthThrottle.fail(String(user.id));
      audit(req, 'mfa_enroll_failed');
      return res.status(400).json({ error: 'That code is not valid. Check the time on your phone and try again.', code: 'mfa_invalid' });
    }
    reauthThrottle.reset(String(user.id));

    db.prepare(
      "UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = datetime('now'), totp_last_step = ? WHERE id = ?"
    ).run(step, user.id);
    const recoveryCodes = issueRecoveryCodes(user.id);
    revokeUserSessions(user.id, req.sessionId);
    audit(req, 'mfa_enabled');
    res.json({ recovery_codes: recoveryCodes });
  })
);

twoFactorRouter.post(
  '/disable',
  wrap(async (req, res) => {
    const user = await reauthenticate(req, res);
    if (!user) return;
    if (!user.totp_enabled_at) return res.status(409).json({ error: 'Two-factor authentication is not on' });
    if (!verifySecondFactor(user, { code: req.body?.code, recoveryCode: req.body?.recovery_code })) {
      audit(req, 'mfa_failed', { detail: { during: 'disable' } });
      return res.status(400).json({ error: 'That code is not valid', code: 'mfa_invalid' });
    }
    db.transaction(() => {
      db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0 WHERE id = ?').run(user.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
    })();
    revokeUserSessions(user.id, req.sessionId);
    audit(req, 'mfa_disabled');
    res.status(204).end();
  })
);

twoFactorRouter.post(
  '/recovery-codes',
  wrap(async (req, res) => {
    const user = await reauthenticate(req, res);
    if (!user) return;
    if (!user.totp_enabled_at) return res.status(409).json({ error: 'Two-factor authentication is not on' });
    if (!verifySecondFactor(user, { code: req.body?.code })) {
      return res.status(400).json({ error: 'That code is not valid', code: 'mfa_invalid' });
    }
    audit(req, 'recovery_codes_regenerated');
    res.json({ recovery_codes: issueRecoveryCodes(user.id) });
  })
);
