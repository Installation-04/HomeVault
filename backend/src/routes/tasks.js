import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { withResourceAccess } from '../middleware/resource.js';
import { isIsoDate, mergeFields, nonEmptyString, parseId, recurrenceError } from '../utils/http.js';
import { nextOccurrenceAfter } from '../utils/recurrence.js';
import { localToday } from '../utils/dates.js';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const FIELDS = ['title', 'event_date', 'recurrence', 'recurrence_interval_days', 'notes', 'document_id'];

function validate(f, propertyId) {
  if (!nonEmptyString(f.title)) return 'title required';
  if (!isIsoDate(f.event_date)) return 'event_date must be a YYYY-MM-DD date';
  const recurrenceProblem = recurrenceError(f.recurrence, f.recurrence_interval_days);
  if (recurrenceProblem) return recurrenceProblem;
  if (f.document_id) {
    const ok = db.prepare('SELECT 1 FROM documents WHERE id = ? AND property_id = ?').get(parseId(Number(f.document_id)), propertyId);
    if (!ok) return 'document_id does not belong to this property';
  }
  return null;
}

const normalize = (f) => ({
  title: f.title.trim(),
  event_date: f.event_date,
  recurrence: f.recurrence,
  recurrence_interval_days: f.recurrence === 'custom' ? Number(f.recurrence_interval_days) : null,
  notes: f.notes ?? null,
  document_id: f.document_id ? Number(f.document_id) : null,
});

tasksRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks WHERE property_id = ? ORDER BY event_date, id').all(req.propertyId));
});

tasksRouter.post('/', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const f = mergeFields(req.body ?? {}, {}, FIELDS);
  f.recurrence = f.recurrence || 'none';
  const problem = validate(f, req.propertyId);
  if (problem) return res.status(400).json({ error: problem });
  const n = normalize(f);

  const info = db
    .prepare(
      `INSERT INTO tasks (property_id, document_id, title, event_date, recurrence, recurrence_interval_days, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.propertyId, n.document_id, n.title, n.event_date, n.recurrence, n.recurrence_interval_days, n.notes, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid));
});

tasksRouter.put('/:id', withResourceAccess('tasks', 'owner'), (req, res) => {
  const t = req.resource;
  const f = mergeFields(req.body ?? {}, t, FIELDS);
  const problem = validate(f, t.property_id);
  if (problem) return res.status(400).json({ error: problem });
  const n = normalize(f);

  db.prepare(
    `UPDATE tasks SET document_id=?, title=?, event_date=?, recurrence=?, recurrence_interval_days=?, notes=?, updated_at=datetime('now') WHERE id = ?`
  ).run(n.document_id, n.title, n.event_date, n.recurrence, n.recurrence_interval_days, n.notes, t.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id));
});

tasksRouter.post('/:id/complete', withResourceAccess('tasks'), (req, res) => {
  const t = req.resource;
  if (t.recurrence === 'none') {
    db.prepare("UPDATE tasks SET completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(t.id);
  } else {
    const nextDate = nextOccurrenceAfter(t.event_date, t.recurrence, t.recurrence_interval_days, localToday());
    db.prepare("UPDATE tasks SET event_date = ?, updated_at = datetime('now') WHERE id = ?").run(nextDate, t.id);
  }
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id));
});

tasksRouter.post('/:id/reopen', withResourceAccess('tasks'), (req, res) => {
  db.prepare("UPDATE tasks SET completed_at = NULL, updated_at = datetime('now') WHERE id = ?").run(req.resource.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.resource.id));
});

tasksRouter.delete('/:id', withResourceAccess('tasks', 'owner'), (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.resource.id);
  res.status(204).end();
});
