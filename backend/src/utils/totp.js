import crypto from 'node:crypto';

// RFC 6238 time-based one-time passwords, compatible with Google Authenticator,
// Authy, 1Password, Bitwarden, Aegis, etc. (SHA-1, 6 digits, 30 s step -- the
// only combination every authenticator app supports).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

export const totpAt = (secretB32, ms = Date.now()) => hotp(base32Decode(secretB32), stepAt(ms));

// Accepts the current step and one either side (clock drift / slow typing).
// `lastUsedStep` blocks replay: a code that was already accepted -- or an
// older one -- can never be used again. Returns the matched step, or null.
export function verifyTotp(secretB32, code, { lastUsedStep = 0, ms = Date.now(), window = 1 } = {}) {
  const normalized = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const secret = base32Decode(secretB32);
  const current = stepAt(ms);
  let matched = null;
  // No early return: every candidate is checked so timing doesn't reveal which step matched.
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    const expected = Buffer.from(hotp(secret, step));
    const given = Buffer.from(normalized);
    if (crypto.timingSafeEqual(expected, given) && step > lastUsedStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUrl({ secret, account, issuer = 'HomeVault' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// Recovery codes: 10 characters from an unambiguous alphabet, shown as xxxxx-xxxxx.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = Array.from(crypto.randomBytes(10), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export const normalizeRecoveryCode = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
