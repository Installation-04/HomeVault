import crypto from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
import { deriveKey } from '../config.js';

const scrypt = promisify(crypto.scrypt);

// ---- password hashing -------------------------------------------------------
//
// scrypt (memory-hard, built into Node, runs on the libuv thread pool) instead
// of bcryptjs, which is pure JS and blocks the event loop for every login.
// Parameters follow the OWASP minimum for scrypt: N=2^15, r=8, p=1 (~32 MB).
// Hashes are self-describing so the parameters can be raised later and old
// hashes upgraded at next login.

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 96 * 1024 * 1024;
const FORMAT = 'scrypt';
export const MAX_PASSWORD_LENGTH = 256;

// Each scrypt needs ~32 MB; cap concurrency so a burst of logins cannot
// balloon memory (the login rate limiter is the other half of this defence).
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
const limited = createLimiter(2);

const derive = (password, salt, { N, r, p, keylen }) =>
  limited(() => scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }));

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt, SCRYPT);
  return [FORMAT, SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

const isPowerOfTwo = (n) => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;

// Rejects stored parameters we would never have written (and ones that could be
// abused to make verification burn huge amounts of memory or time).
function parseScrypt(stored) {
  const [fmt, N, r, p, salt, hash] = stored.split('$');
  if (fmt !== FORMAT || !salt || !hash) return null;
  const parsed = { N: Number(N), r: Number(r), p: Number(p), salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
  const sane =
    isPowerOfTwo(parsed.N) && parsed.N >= 1024 && parsed.N <= 2 ** 20 &&
    Number.isInteger(parsed.r) && parsed.r >= 1 && parsed.r <= 16 &&
    Number.isInteger(parsed.p) && parsed.p >= 1 && parsed.p <= 8 &&
    parsed.salt.length >= 8 && parsed.hash.length >= 16 && parsed.hash.length <= 128;
  return sane ? parsed : null;
}

// Resolves to { ok, needsRehash }. Never throws on malformed stored hashes.
export async function verifyPassword(password, stored) {
  const no = { ok: false, needsRehash: false };
  if (typeof password !== 'string' || typeof stored !== 'string' || password.length > MAX_PASSWORD_LENGTH) return no;
  try {
    if (stored.startsWith(`${FORMAT}$`)) {
      const parsed = parseScrypt(stored);
      if (!parsed) return no;
      const candidate = await derive(password, parsed.salt, { ...parsed, keylen: parsed.hash.length });
      const ok = candidate.length === parsed.hash.length && crypto.timingSafeEqual(candidate, parsed.hash);
      const weaker = parsed.N < SCRYPT.N || parsed.r < SCRYPT.r || parsed.p < SCRYPT.p;
      return { ok, needsRehash: ok && weaker };
    }
    // Legacy bcrypt hashes from earlier versions: verify, then upgrade on login.
    if (stored.startsWith('$2')) {
      const ok = await bcrypt.compare(password, stored);
      return { ok, needsRehash: ok };
    }
  } catch {
    /* corrupt hash: treat as a failed login, not a server error */
  }
  return no;
}

// Spent on unknown accounts so "no such user" costs the same as "wrong password".
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('homevault-dummy-password');
  await verifyPassword(password, dummyHash);
}

// ---- tokens -----------------------------------------------------------------

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Short-lived signed tokens (e.g. "password was right, now send a 2FA code").
// Not JWT: a fixed algorithm, no header to confuse, nothing to configure.
const signKey = () => deriveKey('sign:v1');

export function signPayload(payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = crypto.createHmac('sha256', signKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPayload(token) {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = crypto.createHmac('sha256', signKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

// ---- encryption at rest (TOTP secrets) -------------------------------------

const dataKey = () => deriveKey('data:v1');

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(blob) {
  const [v, iv, tag, enc] = String(blob).split(':');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}
