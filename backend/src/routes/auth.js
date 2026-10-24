import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db/index.js';
import { requireAuth, requireSession } from '../middleware/auth.js';
import { usersRouter } from './users.js';
import { twoFactorRouter } from './twoFactor.js';
import { burnPasswordCheck, hashPassword, safeEqual, signPayload, verifyPassword, verifyPayload } from '../utils/crypto.js';
import { audit } from '../utils/audit.js';
import { nonEmptyString, wrap } from '../utils/http.js';
import { verifySecondFactor, recoveryCodesRemaining } from '../utils/mfa.js';
import { passwordProblem } from '../utils/passwordPolicy.js';
import { clearSessionCookie, createSession, listSessions, loadSession, revokeSession, revokeUserSessions } from '../utils/sessions.js';
import { blocked, loginThrottle, mfaThrottle, reauthThrottle } from '../utils/limits.js';
import { LOCALES, looksLikeEmail, normalizeEmail, publicUser, userByEmail, userById, userCount } from '../utils/users.js';
import { intEnv } from '../config.js';

export const authRouter = Router();

// Two independent brakes on password guessing:
//  - per client address (stops one machine trying many accounts),
//  - per account (stops many machines trying one account).
// Only failures count, so normal use never trips either.
const ipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: intEnv('LOGIN_RATE_LIMIT', 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.', code: 'rate_limited' }),
});
const MFA_TOKEN_TTL_SECONDS = 5 * 60;

// ---- first-run setup --------------------------------------------------------

authRouter.get('/status', (req, res) => {
  const needsSetup = userCount() === 0;
  res.json({ needs_setup: needsSetup, setup_token_required: needsSetup && Boolean(process.env.SETUP_TOKEN) });
});

// Only allowed while no users exist. If SETUP_TOKEN is configured it is also
// required, so a stranger who reaches a freshly started, still-empty instance
// cannot claim the admin account before its owner does.
authRouter.post(
  '/setup',
  ipLimiter,
  wrap(async (req, res) => {
    if (userCount() > 0) return res.status(403).json({ error: 'Setup already completed' });
    const { email, password, name, setup_token } = req.body ?? {};

    if (process.env.SETUP_TOKEN && !safeEqual(setup_token ?? '', process.env.SETUP_TOKEN)) {
      audit(req, 'setup_failed', { user: null, actor: normalizeEmail(email), detail: { reason: 'bad_setup_token' } });
      return res.status(403).json({ error: 'The setup token is missing or incorrect', code: 'setup_token' });
    }
    if (!nonEmptyString(name) || !email || !password) return res.status(400).json({ error: 'email, password, name required' });
    const cleanEmail = normalizeEmail(email);
    if (!looksLikeEmail(cleanEmail)) return res.status(400).json({ error: 'A valid email address is required' });
    const problem = passwordProblem(password, { email: cleanEmail, name });
    if (problem) return res.status(400).json({ error: problem });

    const hash = await hashPassword(password);
    // Re-check inside the write so two simultaneous setups can't both succeed.
    const info = db.transaction(() => {
      if (userCount() > 0) return null;
      return db
        .prepare('INSERT INTO users (email, password_hash, name, is_admin, locale) VALUES (?, ?, ?, 1, ?)')
        .run(cleanEmail, hash, name.trim(), LOCALES.includes(process.env.DEFAULT_LOCALE) ? process.env.DEFAULT_LOCALE : 'en');
    })();
    if (!info) return res.status(403).json({ error: 'Setup already completed' });

    const user = userById(info.lastInsertRowid);
    createSession(req, res, user);
    audit(req, 'setup_completed', { user });
    res.status(201).json({ user: publicUser(user) });
  })
);

// ---- sign in / out ----------------------------------------------------------

authRouter.post(
  '/login',
  ipLimiter,
  wrap(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== 'string') return res.status(400).json({ error: 'email and password required' });

    const gate = loginThrottle.check(email);
    if (gate.blocked) {
      audit(req, 'login_blocked', { user: null, actor: email });
      return blocked(res, gate);
    }

    const user = userByEmail(email);
    let result = { ok: false, needsRehash: false };
    if (user) result = await verifyPassword(password, user.password_hash);
    else await burnPasswordCheck(password);

    if (!user || !result.ok || user.disabled_at) {
      loginThrottle.fail(email);
      audit(req, 'login_failed', { user: user ?? null, actor: email, detail: { reason: !user ? 'unknown_user' : user.disabled_at && result.ok ? 'disabled' : 'bad_password' } });
      return res.status(401).json({ error: 'Invalid credentials', code: 'invalid_credentials' });
    }
    loginThrottle.reset(email);

    // Quietly upgrade legacy bcrypt hashes (and any weaker scrypt parameters).
    if (result.needsRehash) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
    }

    if (user.totp_enabled_at) {
      return res.json({ mfa_required: true, mfa_token: signPayload({ uid: user.id, purpose: 'mfa' }, MFA_TOKEN_TTL_SECONDS) });
    }

    createSession(req, res, user);
    audit(req, 'login_success', { user });
    res.json({ user: publicUser(user) });
  })
);

// Second step of a 2FA login: the password was right, now prove the device.
authRouter.post(
  '/login/mfa',
  ipLimiter,
  wrap(async (req, res) => {
    const payload = verifyPayload(req.body?.mfa_token);
    if (!payload || payload.purpose !== 'mfa') {
      return res.status(401).json({ error: 'Your sign-in expired. Please start again.', code: 'mfa_expired' });
    }
    const user = userById(payload.uid);
    if (!user || user.disabled_at || !user.totp_enabled_at) {
      return res.status(401).json({ error: 'Your sign-in expired. Please start again.', code: 'mfa_expired' });
    }

    const gate = mfaThrottle.check(String(user.id));
    if (gate.blocked) {
      audit(req, 'mfa_blocked', { user });
      return blocked(res, gate);
    }

    const method = verifySecondFactor(user, { code: req.body?.code, recoveryCode: req.body?.recovery_code });
    if (!method) {
      mfaThrottle.fail(String(user.id));
      audit(req, 'mfa_failed', { user });
      return res.status(401).json({ error: 'That code is not valid', code: 'mfa_invalid' });
    }
    mfaThrottle.reset(String(user.id));

    createSession(req, res, user, { mfa: true });
    audit(req, 'login_success', { user, detail: { second_factor: method } });
    if (method === 'recovery') audit(req, 'recovery_code_used', { user, detail: { remaining: recoveryCodesRemaining(user.id) } });
    res.json({ user: publicUser(user), recovery_codes_remaining: method === 'recovery' ? recoveryCodesRemaining(user.id) : undefined });
  })
);

// Idempotent and allowed without a session, so "log out" always clears the cookie.
authRouter.post('/logout', (req, res) => {
  const session = loadSession(req);
  if (session) {
    revokeSession(session.sessionId, session.user.id);
    audit(req, 'logout', { user: session.user });
  }
  clearSessionCookie(req, res);
  res.status(204).end();
});

// ---- who am I ---------------------------------------------------------------

authRouter.get('/me', requireSession, (req, res) => {
  const user = userById(req.user.id);
  res.json(publicUser(user));
});

authRouter.patch('/me', requireAuth, (req, res) => {
  const { name, locale } = req.body ?? {};
  if (name !== undefined && !nonEmptyString(name)) return res.status(400).json({ error: 'name cannot be empty' });
  if (locale !== undefined && !LOCALES.includes(locale)) return res.status(400).json({ error: `locale must be one of ${LOCALES.join(', ')}` });
  const current = userById(req.user.id);
  db.prepare('UPDATE users SET name = ?, locale = ? WHERE id = ?').run(
    name !== undefined ? name.trim().slice(0, 100) : current.name,
    locale ?? current.locale,
    req.user.id
  );
  res.json(publicUser(userById(req.user.id)));
});

// ---- password ---------------------------------------------------------------

// A wrong current password is a 400, not a 401: the SPA reads 401 as
// "session expired" and would log the person out mid-form.
authRouter.post(
  '/password',
  requireSession,
  wrap(async (req, res) => {
    const { current_password, new_password } = req.body ?? {};
    const gate = reauthThrottle.check(String(req.user.id));
    if (gate.blocked) return blocked(res, gate);

    const user = userById(req.user.id);
    const check = typeof current_password === 'string' ? await verifyPassword(current_password, user.password_hash) : { ok: false };
    if (!check.ok) {
      reauthThrottle.fail(String(req.user.id));
      audit(req, 'password_change_failed', { detail: { reason: 'bad_current_password' } });
      return res.status(400).json({ error: 'Current password is incorrect', code: 'bad_current_password' });
    }
    reauthThrottle.reset(String(req.user.id));

    const problem = passwordProblem(new_password, { email: user.email, name: user.name });
    if (problem) return res.status(400).json({ error: problem });
    if (new_password === current_password) return res.status(400).json({ error: 'Choose a password different from the current one' });

    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(new_password), user.id);
    // Anyone who had the old password (or a stolen session) is signed out everywhere else.
    const revoked = revokeUserSessions(user.id, req.sessionId);
    audit(req, 'password_changed', { detail: { other_sessions_revoked: revoked } });
    res.status(204).end();
  })
);

// ---- sessions & activity ----------------------------------------------------

authRouter.get('/sessions', requireAuth, (req, res) => {
  res.json(listSessions(req.user.id).map((s) => ({ ...s, current: s.id === req.sessionId })));
});

authRouter.delete('/sessions', requireAuth, (req, res) => {
  const revoked = revokeUserSessions(req.user.id, req.sessionId);
  audit(req, 'sessions_revoked_all', { detail: { count: revoked } });
  res.json({ revoked });
});

authRouter.delete('/sessions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !revokeSession(id, req.user.id)) return res.status(404).json({ error: 'Not found' });
  audit(req, 'session_revoked', { target: String(id) });
  if (id === req.sessionId) clearSessionCookie(req, res);
  res.status(204).end();
});

// The signed-in person's own recent security events.
authRouter.get('/activity', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  res.json(
    db
      .prepare('SELECT id, at, action, target, detail, ip, user_agent FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(req.user.id, limit)
  );
});

authRouter.use('/2fa', twoFactorRouter);
authRouter.use('/users', usersRouter);
