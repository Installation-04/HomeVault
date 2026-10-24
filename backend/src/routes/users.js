import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../db/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { hashPassword } from '../utils/crypto.js';
import { audit } from '../utils/audit.js';
import { nonEmptyString, parseId, wrap } from '../utils/http.js';
import { passwordProblem } from '../utils/passwordPolicy.js';
import { revokeUserSessions } from '../utils/sessions.js';
import { looksLikeEmail, normalizeEmail, otherActiveAdmins, userById } from '../utils/users.js';

export const usersRouter = Router();
usersRouter.use(requireAuth, requireAdmin);

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const generateTempPassword = () => Array.from(randomBytes(16), (b) => ALPHABET[b % ALPHABET.length]).join('');

const listRow = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  is_admin: !!u.is_admin,
  locale: u.locale,
  disabled: !!u.disabled_at,
  totp_enabled: !!u.totp_enabled_at,
  must_change_password: !!u.must_change_password,
  last_login_at: u.last_login_at,
  created_at: u.created_at,
});

usersRouter.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(listRow));
});

// Admin-created accounts get a temporary password the person must replace at
// first sign-in (the admin never needs to know the real one).
usersRouter.post(
  '/',
  wrap(async (req, res) => {
    const { email, password, name, is_admin, must_change_password } = req.body ?? {};
    const cleanEmail = normalizeEmail(email);
    if (!nonEmptyString(name) || !cleanEmail || !password) return res.status(400).json({ error: 'email, password, name required' });
    if (!looksLikeEmail(cleanEmail)) return res.status(400).json({ error: 'A valid email address is required' });
    const problem = passwordProblem(password, { email: cleanEmail, name });
    if (problem) return res.status(400).json({ error: problem });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail)) return res.status(409).json({ error: 'Email already in use' });

    const hash = await hashPassword(password);
    const mustChange = must_change_password === false ? 0 : 1;
    const info = db
      .prepare('INSERT INTO users (email, password_hash, name, is_admin, must_change_password) VALUES (?, ?, ?, ?, ?)')
      .run(cleanEmail, hash, name.trim().slice(0, 100), is_admin ? 1 : 0, mustChange);
    audit(req, 'user_created', { target: cleanEmail, detail: { is_admin: !!is_admin } });
    res.status(201).json({ id: Number(info.lastInsertRowid), email: cleanEmail, name: name.trim(), must_change_password: !!mustChange });
  })
);

function loadTarget(req, res) {
  const id = parseId(req.params.id);
  const target = id ? userById(id) : null;
  if (!target) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return target;
}

usersRouter.patch('/:id', (req, res) => {
  const target = loadTarget(req, res);
  if (!target) return;
  const { name, is_admin, disabled } = req.body ?? {};
  const self = target.id === req.user.id;

  if (name !== undefined && !nonEmptyString(name)) return res.status(400).json({ error: 'name cannot be empty' });

  const demoting = is_admin === false && target.is_admin;
  const disabling = disabled === true && !target.disabled_at;
  if (self && (demoting || disabling)) {
    return res.status(400).json({ error: "You can't remove your own admin access or disable your own account. Ask another admin." });
  }
  if ((demoting || disabling) && target.is_admin && otherActiveAdmins(target.id) === 0) {
    return res.status(400).json({ error: 'There must always be at least one active admin' });
  }

  db.prepare('UPDATE users SET name = ?, is_admin = ?, disabled_at = ? WHERE id = ?').run(
    name !== undefined ? name.trim().slice(0, 100) : target.name,
    is_admin === undefined ? target.is_admin : is_admin ? 1 : 0,
    disabled === undefined ? target.disabled_at : disabled ? target.disabled_at ?? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
    target.id
  );

  if (disabling) revokeUserSessions(target.id);
  if (is_admin !== undefined && !!is_admin !== !!target.is_admin) audit(req, is_admin ? 'user_promoted' : 'user_demoted', { target: target.email });
  if (disabling) audit(req, 'user_disabled', { target: target.email });
  if (disabled === false && target.disabled_at) audit(req, 'user_enabled', { target: target.email });

  res.json(listRow(userById(target.id)));
});

usersRouter.post(
  '/:id/reset-password',
  wrap(async (req, res) => {
    const target = loadTarget(req, res);
    if (!target) return;
    if (target.id === req.user.id) return res.status(400).json({ error: 'Use "Change password" for your own account' });

    const temp = req.body?.temp_password ?? generateTempPassword();
    const problem = passwordProblem(temp, { email: target.email, name: target.name });
    if (problem) return res.status(400).json({ error: problem });

    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await hashPassword(temp), target.id);
    revokeUserSessions(target.id);
    audit(req, 'user_password_reset', { target: target.email });
    // Shown once: the admin passes it on; the person must change it at next sign-in.
    res.json({ temp_password: temp });
  })
);

usersRouter.post('/:id/reset-2fa', (req, res) => {
  const target = loadTarget(req, res);
  if (!target) return;
  db.transaction(() => {
    db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0 WHERE id = ?').run(target.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(target.id);
  })();
  revokeUserSessions(target.id);
  audit(req, 'user_mfa_reset', { target: target.email });
  res.status(204).end();
});

usersRouter.delete('/:id', (req, res) => {
  const target = loadTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  if (target.is_admin && otherActiveAdmins(target.id) === 0) return res.status(400).json({ error: 'There must always be at least one active admin' });

  // Records the person created keep pointing at them, so only an account with
  // no history can be removed outright. Everyone else should be disabled.
  const authored = ['properties', 'documents', 'equipment', 'equipment_photos', 'maintenance_logs', 'reminders', 'tasks', 'expenses'].reduce(
    (sum, table) => sum + db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE created_by = ?`).get(target.id).c,
    0
  );
  if (authored > 0) {
    return res.status(409).json({
      error: 'This account has created records, so it cannot be deleted. Disable it instead to block sign-in while keeping the history.',
      code: 'has_history',
    });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  audit(req, 'user_deleted', { target: target.email });
  res.status(204).end();
});
