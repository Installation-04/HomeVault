import { createHash, hkdfSync, randomBytes } from 'node:crypto';

export const PLACEHOLDER_SECRET = 'change-me-to-a-long-random-string';
const MIN_SECRET_LENGTH = 16;

const isNonNegativeInt = (v) => /^\d+$/.test(String(v));
const isPositiveInt = (v) => /^[1-9]\d*$/.test(String(v));

// APP_SECRET is the preferred name; JWT_SECRET is still honored so existing
// deployments keep working after upgrading (sessions are no longer JWTs, but
// the same secret now signs short-lived tokens and derives encryption keys).
export function configuredSecret(env = process.env) {
  return env.APP_SECRET || env.JWT_SECRET || '';
}

// Returns a list of human-readable problems with the environment. The secret
// is enforced strictly, and only in production: anyone who knows the
// placeholder from the public .env.example could otherwise forge login
// challenges and decrypt stored 2FA secrets.
export function configProblems(env = process.env) {
  const problems = [];

  if (env.NODE_ENV === 'production') {
    const secret = configuredSecret(env);
    if (!secret) {
      problems.push('APP_SECRET is not set. Generate one with: openssl rand -hex 32');
    } else if (secret === PLACEHOLDER_SECRET) {
      problems.push('APP_SECRET is still the placeholder from .env.example. Generate one with: openssl rand -hex 32');
    } else if (secret.length < MIN_SECRET_LENGTH) {
      problems.push(`APP_SECRET is too short (${secret.length} chars); use at least ${MIN_SECRET_LENGTH}.`);
    }
    if (env.DATA_KEY && env.DATA_KEY.length < MIN_SECRET_LENGTH) {
      problems.push(`DATA_KEY is too short (${env.DATA_KEY.length} chars); use at least ${MIN_SECRET_LENGTH}.`);
    }
    if (env.SETUP_TOKEN && env.SETUP_TOKEN.length < 8) {
      problems.push('SETUP_TOKEN is too short; use at least 8 characters.');
    }
  }

  if (env.PORT && !isNonNegativeInt(env.PORT)) problems.push(`PORT must be a number, got "${env.PORT}".`);
  if (env.EXPIRY_NOTICE_DAYS && !isNonNegativeInt(env.EXPIRY_NOTICE_DAYS)) {
    problems.push(`EXPIRY_NOTICE_DAYS must be a non-negative number of days, got "${env.EXPIRY_NOTICE_DAYS}".`);
  }
  for (const name of ['LOGIN_RATE_LIMIT', 'SESSION_DAYS', 'SESSION_IDLE_DAYS', 'BACKUP_KEEP', 'AUDIT_RETENTION_DAYS']) {
    if (env[name] && !isPositiveInt(env[name])) problems.push(`${name} must be a positive whole number, got "${env[name]}".`);
  }
  if (env.COOKIE_SECURE && !['auto', 'always', 'never'].includes(env.COOKIE_SECURE)) {
    problems.push('COOKIE_SECURE must be one of: auto, always, never.');
  }
  if (env.FORCE_HTTPS && !['true', 'false', ''].includes(env.FORCE_HTTPS)) {
    problems.push('FORCE_HTTPS must be true or false.');
  }

  if (env.UPDATE_CHECK && !['true', 'false'].includes(env.UPDATE_CHECK)) problems.push('UPDATE_CHECK must be true or false.');
  if (env.UPDATE_REPO && !/^[\w.-]+\/[\w.-]+$/.test(env.UPDATE_REPO)) problems.push('UPDATE_REPO must look like owner/name.');
  if (env.UPDATE_API_BASE) {
    try {
      if (!['http:', 'https:'].includes(new URL(env.UPDATE_API_BASE).protocol)) throw new Error('scheme');
    } catch {
      problems.push('UPDATE_API_BASE must be an http(s) URL.');
    }
  }

  return problems;
}

export function assertConfig(env = process.env) {
  const problems = configProblems(env);
  if (problems.length) {
    throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }
}

let ephemeralSecret = null;

// Outside production a missing secret is tolerated with a random per-process
// one (logins just don't survive a restart) so `npm run dev` works out of the box.
export function appSecret() {
  const secret = configuredSecret();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_SECRET is not set');
  }
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString('hex');
    console.warn('APP_SECRET is not set; using a temporary secret. 2FA enrolments will not survive a restart.');
  }
  return ephemeralSecret;
}

// Independent 32-byte keys for different purposes, derived with HKDF so a leak
// of one derived value says nothing about the others. DATA_KEY (when set)
// separates "encrypt things at rest" from "sign short-lived tokens", so
// rotating APP_SECRET doesn't make stored 2FA secrets unreadable.
export function deriveKey(purpose) {
  const material = process.env.DATA_KEY && purpose.startsWith('data:') ? process.env.DATA_KEY : appSecret();
  return Buffer.from(hkdfSync('sha256', createHash('sha256').update(material).digest(), 'homevault', purpose, 32));
}

// Express "trust proxy" accepts a hop count, a boolean, or a subnet list.
// Needed behind Traefik/Nginx so rate limiting sees the real client IP.
export function trustProxySetting(value = process.env.TRUST_PROXY) {
  if (value === undefined || value === '') return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return 1;
  if (value === 'false') return false;
  return value;
}

export const intEnv = (name, fallback) => {
  const raw = process.env[name];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
};
