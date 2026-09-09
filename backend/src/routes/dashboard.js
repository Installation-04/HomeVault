import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get('/', (req, res) => {
  const properties = req.user.is_admin
    ? db.prepare('SELECT * FROM properties ORDER BY name').all()
    : db
        .prepare(
          `SELECT p.* FROM properties p
           JOIN property_access pa ON pa.property_id = p.id
           WHERE pa.user_id = ? ORDER BY p.name`
        )
        .all(req.user.id);

  const upcomingStmt = db.prepare(
    `SELECT id, title, category, due_date, lead_time_days FROM reminders
     WHERE property_id = ? AND completed_at IS NULL AND date(due_date) <= date('now', '+30 days')
     ORDER BY due_date LIMIT 10`
  );
  const expiringStmt = db.prepare(
    `SELECT id, title, category, expiry_date FROM documents
     WHERE property_id = ? AND expiry_date IS NOT NULL AND date(expiry_date) <= date('now', '+30 days')
     ORDER BY expiry_date LIMIT 10`
  );

  const summary = properties.map((p) => ({
    ...p,
    upcoming_reminders: upcomingStmt.all(p.id),
    expiring_documents: expiringStmt.all(p.id),
  }));

  res.json(summary);
});
