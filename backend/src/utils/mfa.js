import { db } from '../db/index.js';
import { decryptSecret, sha256 } from './crypto.js';
import { generateRecoveryCodes, normalizeRecoveryCode, verifyTotp } from './totp.js';

const RECOVERY_COUNT = 10;

export const recoveryCodeHash = (code) => sha256(normalizeRecoveryCode(code));

// Replaces all recovery codes for a user and returns the new plaintext set
// (the only time they are ever visible).
export function issueRecoveryCodes(userId) {
  const codes = generateRecoveryCodes(RECOVERY_COUNT);
  const insert = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    for (const code of codes) insert.run(userId, recoveryCodeHash(code));
  })();
  return codes;
}

export const recoveryCodesRemaining = (userId) =>
  db.prepare('SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).c;

// Checks a TOTP code or a recovery code for a user with 2FA enabled.
// Returns 'totp', 'recovery' or null. A TOTP step can be used only once, and a
// recovery code is burned the moment it is accepted.
export function verifySecondFactor(user, { code, recoveryCode } = {}) {
  if (!user.totp_enabled_at || !user.totp_secret_enc) return null;

  if (recoveryCode) {
    const hash = recoveryCodeHash(recoveryCode);
    const burned = db
      .prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
      .run(user.id, hash).changes;
    return burned ? 'recovery' : null;
  }

  if (code) {
    const step = verifyTotp(decryptSecret(user.totp_secret_enc), code, { lastUsedStep: user.totp_last_step });
    if (step === null) return null;
    // Compare-and-set so two simultaneous requests can't both spend the same step.
    const claimed = db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?').run(step, user.id, step).changes;
    return claimed ? 'totp' : null;
  }
  return null;
}
