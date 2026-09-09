import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { advanceDate } from '../utils/recurrence.js';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

tasksRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks WHERE property_id = ? ORDER BY event_date').all(req.propertyId));
});

tasksRouter.post('/', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const { document_id, title, event_date, recurrence, recurrence_interval_days, notes } = req.body;
  if (!title || !event_date) return res.status(400).json({ error: 'title and event_date required' });
  const info = db
    .prepare(
      `INSERT INTO tasks (property_id, document_id, title, event_date, recurrence, recurrence_interval_days, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.propertyId,
      document_id || null,
      title,
      event_date,
      recurrence || 'none',
      recurrence_interval_days || null,
      notes || null,
      req.user.id
    );
  res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
});

function getTaskOr404(id, res) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) res.status(404).json({ error: 'Not found' });
  return t;
}

tasksRouter.put('/:id', requireAuth, (req, res) => {
  const t = getTaskOr404(req.params.id, res);
  if (!t) return;
  req.params.propertyId = t.property_id;
  requirePropertyAccess({ minRole: 'owner' })(req, res, () => {
    const updated = { ...t, ...req.body };
    db.prepare(
      `UPDATE tasks SET title=?, event_date=?, recurrence=?, recurrence_interval_days=?, notes=?, updated_at=datetime('now') WHERE id = ?`
    ).run(updated.title, updated.event_date, updated.recurrence, updated.recurrence_interval_days, updated.notes, t.id);
    res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id));
  });
});

tasksRouter.post('/:id/complete', requireAuth, (req, res) => {
  const t = getTaskOr404(req.params.id, res);
  if (!t) return;
  req.params.propertyId = t.property_id;
  requirePropertyAccess()(req, res, () => {
    if (t.recurrence === 'none') {
      db.prepare("UPDATE tasks SET completed_at = datetime('now') WHERE id = ?").run(t.id);
    } else {
      const nextDate = advanceDate(t.event_date, t.recurrence, t.recurrence_interval_days);
      db.prepare("UPDATE tasks SET event_date = ?, updated_at = datetime('now') WHERE id = ?").run(nextDate, t.id);
    }
    res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id));
  });
});

tasksRouter.delete('/:id', requireAuth, (req, res) => {
  const t = getTaskOr404(req.params.id, res);
  if (!t) return;
  req.params.propertyId = t.property_id;
  requirePropertyAccess({ minRole: 'owner' })(req, res, () => {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    res.status(204).end();
  });
});
