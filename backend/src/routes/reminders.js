import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { advanceDate } from '../utils/recurrence.js';

export const remindersRouter = Router();
remindersRouter.use(requireAuth);

remindersRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  res.json(
    db.prepare('SELECT * FROM reminders WHERE property_id = ? ORDER BY due_date').all(req.propertyId)
  );
});

remindersRouter.post('/', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const { document_id, title, category, due_date, recurrence, recurrence_interval_days, lead_time_days, notify_email, notes } =
    req.body;
  if (!title || !due_date) return res.status(400).json({ error: 'title and due_date required' });
  const info = db
    .prepare(
      `INSERT INTO reminders
       (property_id, document_id, title, category, due_date, recurrence, recurrence_interval_days, lead_time_days, notify_email, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.propertyId,
      document_id || null,
      title,
      category || 'maintenance',
      due_date,
      recurrence || 'none',
      recurrence_interval_days || null,
      lead_time_days ?? 7,
      notify_email ? 1 : 0,
      notes || null,
      req.user.id
    );
  res.status(201).json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid));
});

function getReminderOr404(id, res) {
  const r = db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
  if (!r) res.status(404).json({ error: 'Not found' });
  return r;
}

remindersRouter.put('/:id', requireAuth, (req, res) => {
  const r = getReminderOr404(req.params.id, res);
  if (!r) return;
  req.params.propertyId = r.property_id;
  requirePropertyAccess({ minRole: 'owner' })(req, res, () => {
    const fields = ['title', 'category', 'due_date', 'recurrence', 'recurrence_interval_days', 'lead_time_days', 'notify_email', 'notes'];
    const updated = { ...r, ...req.body };
    db.prepare(
      `UPDATE reminders SET title=?, category=?, due_date=?, recurrence=?, recurrence_interval_days=?, lead_time_days=?, notify_email=?, notes=?, updated_at=datetime('now')
       WHERE id = ?`
    ).run(
      updated.title,
      updated.category,
      updated.due_date,
      updated.recurrence,
      updated.recurrence_interval_days,
      updated.lead_time_days,
      updated.notify_email ? 1 : 0,
      updated.notes,
      r.id
    );
    res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(r.id));
  });
});

// Mark complete; if recurring, roll the due_date forward instead of just closing it.
remindersRouter.post('/:id/complete', requireAuth, (req, res) => {
  const r = getReminderOr404(req.params.id, res);
  if (!r) return;
  req.params.propertyId = r.property_id;
  requirePropertyAccess()(req, res, () => {
    if (r.recurrence === 'none') {
      db.prepare("UPDATE reminders SET completed_at = datetime('now') WHERE id = ?").run(r.id);
    } else {
      const nextDue = advanceDate(r.due_date, r.recurrence, r.recurrence_interval_days);
      db.prepare("UPDATE reminders SET due_date = ?, updated_at = datetime('now') WHERE id = ?").run(nextDue, r.id);
    }
    res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(r.id));
  });
});

remindersRouter.delete('/:id', requireAuth, (req, res) => {
  const r = getReminderOr404(req.params.id, res);
  if (!r) return;
  req.params.propertyId = r.property_id;
  requirePropertyAccess({ minRole: 'owner' })(req, res, () => {
    db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id);
    res.status(204).end();
  });
});
