import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';

export const calendarRouter = Router();
calendarRouter.use(requireAuth);

// Merged calendar feed for a property: reminders + tasks, optional date range.
calendarRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  const { from, to } = req.query;
  const range = (col) => {
    const clauses = [];
    const params = [];
    if (from) {
      clauses.push(`${col} >= ?`);
      params.push(from);
    }
    if (to) {
      clauses.push(`${col} <= ?`);
      params.push(to);
    }
    return { clause: clauses.length ? 'AND ' + clauses.join(' AND ') : '', params };
  };

  const r = range('due_date');
  const reminders = db
    .prepare(`SELECT id, title, due_date AS date, category, completed_at FROM reminders WHERE property_id = ? ${r.clause}`)
    .all(req.propertyId, ...r.params)
    .map((x) => ({ ...x, type: 'reminder' }));

  const t = range('event_date');
  const tasks = db
    .prepare(`SELECT id, title, event_date AS date, completed_at FROM tasks WHERE property_id = ? ${t.clause}`)
    .all(req.propertyId, ...t.params)
    .map((x) => ({ ...x, type: 'task' }));

  const events = [...reminders, ...tasks].sort((a, b) => (a.date < b.date ? -1 : 1));
  res.json(events);
});
