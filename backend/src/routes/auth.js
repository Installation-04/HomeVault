import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { jwtSecret } from '../config.js';
import { nonEmptyString } from '../utils/http.js';

export const authRouter = Router();

const LOCALES = ['en', 'fr'];
const MIN_PASSWORD = 8;
const MAX_PASSWORD_BYTES = 72; // bcrypt silently ignores anything beyond this

// Only failed attempts count, so normal use never trips it. LOGIN_RATE_LIMIT
// is read when the app is created (tests lower it).
const failedAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT) || 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' }),
});

// Compared against when the email is unknown so response time doesn't reveal
// which addresses have accounts.
const DUMMY_HASH = bcrypt.hashSync('homevault-dummy-password', 10);

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin },
    jwtSecret(),
    { expiresIn: '30d' }
  );
}

const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
const looksLikeEmail = (email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

function passwordError(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters`;
  }
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  return null;
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin, locale: user.locale };
}

// Shared validation for setup + admin-created accounts.
function validateNewAccount({ email, password, name }) {
  if (!nonEmptyString(name) || !email || !password) return 'email, password, name required';
  if (!looksLikeEmail(normalizeEmail(email))) return 'A valid email address is required';
  return passwordError(password);
}

// First-run setup: only allowed when no users exist yet.
authRouter.post('/setup', failedAttemptLimiter, (req, res) => {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (existing.c > 0) return res.status(403).json({ error: 'Setup already completed' });

  const problem = validateNewAccount(req.body ?? {});
  if (problem) return res.status(400).json({ error: problem });

  const { email, password, name } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (email, password_hash, name, is_admin, locale) VALUES (?, ?, ?, 1, ?)')
    .run(normalizeEmail(email), hash, name.trim(), LOCALES.includes(process.env.DEFAULT_LOCALE) ? process.env.DEFAULT_LOCALE : 'en');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

authRouter.post('/login', failedAttemptLimiter, (req, res) => {
  const { email, password } = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
  const valid = bcrypt.compareSync(typeof password === 'string' ? password : '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, is_admin, locale FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(publicUser(user));
});

// Update own profile: display name and preferred language (used for emails).
authRouter.patch('/me', requireAuth, (req, res) => {
  const { name, locale } = req.body ?? {};
  if (name !== undefined && !nonEmptyString(name)) return res.status(400).json({ error: 'name cannot be empty' });
  if (locale !== undefined && !LOCALES.includes(locale)) {
    return res.status(400).json({ error: `locale must be one of ${LOCALES.join(', ')}` });
  }
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  db.prepare('UPDATE users SET name = ?, locale = ? WHERE id = ?').run(
    name !== undefined ? name.trim() : current.name,
    locale ?? current.locale,
    req.user.id
  );
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
});

// Deliberately a 400 (not 401) for a wrong current password: the SPA treats a
// 401 as "session expired" and would log the user out.
authRouter.post('/password', requireAuth, failedAttemptLimiter, (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (typeof current_password !== 'string' || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const problem = passwordError(new_password);
  if (problem) return res.status(400).json({ error: problem });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  res.status(204).end();
});

// Admin-only: list household accounts.
authRouter.get('/users', requireAuth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  res.json(
    db.prepare('SELECT id, email, name, is_admin, locale, created_at FROM users ORDER BY name COLLATE NOCASE').all()
      .map((u) => ({ ...u, is_admin: !!u.is_admin }))
  );
});

// Admin-only: invite/create a family member account.
authRouter.post('/users', requireAuth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const problem = validateNewAccount(req.body ?? {});
  if (problem) return res.status(400).json({ error: problem });

  const { email, password, name } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
      .run(normalizeEmail(email), hash, name.trim());
    res.status(201).json({ id: info.lastInsertRowid, email: normalizeEmail(email), name: name.trim() });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Email already in use' });
    throw e;
  }
});
