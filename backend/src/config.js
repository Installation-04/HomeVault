import { randomBytes } from 'node:crypto';

export const PLACEHOLDER_SECRET = 'change-me-to-a-long-random-string';
const MIN_SECRET_LENGTH = 16;

const isNonNegativeInt = (v) => /^\d+$/.test(String(v));

// Returns a list of human-readable problems with the environment. Only the
// JWT secret is enforced strictly, and only in production: anyone who knows
// the placeholder from the public .env.example could otherwise mint an
// admin token for the instance.
export function configProblems(env = process.env) {
  const problems = [];

  if (env.NODE_ENV === 'production') {
    const secret = env.JWT_SECRET;
    if (!secret) {
      problems.push('JWT_SECRET is not set. Generate one with: openssl rand -hex 32');
    } else if (secret === PLACEHOLDER_SECRET) {
      problems.push('JWT_SECRET is still the placeholder from .env.example. Generate one with: openssl rand -hex 32');
    } else if (secret.length < MIN_SECRET_LENGTH) {
      problems.push(`JWT_SECRET is too short (${secret.length} chars); use at least ${MIN_SECRET_LENGTH}.`);
    }
  }

  if (env.PORT && !isNonNegativeInt(env.PORT)) problems.push(`PORT must be a number, got "${env.PORT}".`);
  if (env.EXPIRY_NOTICE_DAYS && !isNonNegativeInt(env.EXPIRY_NOTICE_DAYS)) {
    problems.push(`EXPIRY_NOTICE_DAYS must be a non-negative number of days, got "${env.EXPIRY_NOTICE_DAYS}".`);
  }
  if (env.LOGIN_RATE_LIMIT && !isNonNegativeInt(env.LOGIN_RATE_LIMIT)) {
    problems.push(`LOGIN_RATE_LIMIT must be a number, got "${env.LOGIN_RATE_LIMIT}".`);
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
export function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is not set');
  }
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString('hex');
    console.warn('JWT_SECRET is not set; using a temporary secret. Sessions will reset on restart.');
  }
  return ephemeralSecret;
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
