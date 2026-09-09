import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// First-run setup: only allowed when no users exist yet.
authRouter.post('/setup', (req, res) => {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (existing.c > 0) return res.status(403).json({ error: 'Setup already completed' });

  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, name required' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (email, password_hash, name, is_admin) VALUES (?, ?, ?, 1)')
    .run(email.toLowerCase(), hash, name);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ token: signToken(user), user: { id: user.id, email: user.email, name: user.name, is_admin: true } });
});

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({
    token: signToken(user),
    user: { id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin, locale: user.locale },
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, is_admin, locale FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// Admin-only: invite/create a family member account.
authRouter.post('/users', requireAuth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, name required' });
  }
  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
      .run(email.toLowerCase(), hash, name);
    res.status(201).json({ id: info.lastInsertRowid, email, name });
  } catch (e) {
    res.status(409).json({ error: 'Email already in use' });
  }
});
