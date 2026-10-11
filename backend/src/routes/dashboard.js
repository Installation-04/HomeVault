import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { addDays, localToday } from '../utils/dates.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

// How far ahead "expiring soon" looks, and how long a recent expiry keeps
// showing up (so a lapsed policy doesn't vanish the day after it expires).
export const SOON_DAYS = 30;
export const RECENTLY_EXPIRED_DAYS = 30;

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

  const today = localToday();
  const soon = addDays(today, SOON_DAYS);
  const since = addDays(today, -RECENTLY_EXPIRED_DAYS);
  const year = today.slice(0, 4);

  const overdueStmt = db.prepare(
    `SELECT id, title, category, due_date FROM reminders
     WHERE property_id = ? AND completed_at IS NULL AND due_date < ?
     ORDER BY due_date LIMIT 10`
  );
  const upcomingStmt = db.prepare(
    `SELECT id, title, category, due_date, lead_time_days FROM reminders
     WHERE property_id = ? AND completed_at IS NULL AND due_date >= ? AND due_date <= ?
     ORDER BY due_date LIMIT 10`
  );
  const expiringDocsStmt = db.prepare(
    `SELECT id, title, category, expiry_date FROM documents
     WHERE property_id = ? AND expiry_date >= ? AND expiry_date <= ?
     ORDER BY expiry_date LIMIT 10`
  );
  const expiringEquipmentStmt = db.prepare(
    `SELECT id, name, warranty_expiry FROM equipment
     WHERE property_id = ? AND warranty_expiry >= ? AND warranty_expiry <= ?
     ORDER BY warranty_expiry LIMIT 10`
  );
  const countsStmt = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM documents WHERE property_id = @id) AS documents,
       (SELECT COUNT(*) FROM equipment WHERE property_id = @id) AS equipment,
       (SELECT COUNT(*) FROM reminders WHERE property_id = @id AND completed_at IS NULL) AS open_reminders`
  );
  const expensesStmt = db.prepare(
    `SELECT currency, ROUND(SUM(amount), 2) AS total FROM expenses
     WHERE property_id = ? AND strftime('%Y', expense_date) = ?
     GROUP BY currency ORDER BY currency`
  );

  res.json(
    properties.map((p) => ({
      ...p,
      overdue_reminders: overdueStmt.all(p.id, today),
      upcoming_reminders: upcomingStmt.all(p.id, today, soon),
      expiring_documents: expiringDocsStmt.all(p.id, since, soon),
      expiring_equipment: expiringEquipmentStmt.all(p.id, since, soon),
      counts: countsStmt.get({ id: p.id }),
      expenses_ytd: expensesStmt.all(p.id, year),
    }))
  );
});
