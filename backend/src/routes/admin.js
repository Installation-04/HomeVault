import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupDatabase, db } from '../db/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { wrap } from '../utils/http.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// Everything that happened, newest first. `before` is the id of the last row
// you already have, so paging stays stable while new events keep arriving.
adminRouter.get('/audit', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const params = [before];
  let sql = 'SELECT id, at, user_id, actor, action, target, detail, ip, user_agent FROM audit_log WHERE id < ?';
  if (req.query.action) {
    sql += ' AND action = ?';
    params.push(String(req.query.action));
  }
  if (req.query.user_id) {
    sql += ' AND user_id = ?';
    params.push(Number(req.query.user_id));
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params);
  const events = rows.slice(0, limit);
  res.json({ events, next_before: rows.length > limit ? events[events.length - 1].id : null });
});

// A consistent copy of the database (accounts, records -- not uploaded files).
// Admin-only and audited; the file contains password hashes, so treat it as a secret.
adminRouter.get(
  '/backup',
  wrap(async (req, res) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homevault-dl-'));
    try {
      const file = await backupDatabase(dir, { keep: 1 });
      audit(req, 'backup_downloaded');
      res.set('Cache-Control', 'no-store');
      res.download(file, path.basename(file), (err) => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (err && !res.headersSent) res.status(500).json({ error: 'Could not send the backup' });
      });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  })
);
