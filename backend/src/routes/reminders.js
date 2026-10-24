import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { withResourceAccess } from '../middleware/resource.js';
import { isIsoDate, mergeFields, nonEmptyString, parseId, recurrenceError } from '../utils/http.js';
import { nextOccurrenceAfter } from '../utils/recurrence.js';
import { localToday } from '../utils/dates.js';

export const remindersRouter = Router();
remindersRouter.use(requireAuth);

export const REMINDER_CATEGORIES = ['maintenance', 'insurance_renewal', 'payment', 'other'];
const FIELDS = ['title', 'category', 'due_date', 'recurrence', 'recurrence_interval_days', 'lead_time_days', 'notify_email', 'notes', 'document_id', 'equipment_id'];

// Normalizes + validates a reminder payload (already merged with defaults).
function validate(f, propertyId) {
  if (!nonEmptyString(f.title)) return 'title required';
  if (!isIsoDate(f.due_date)) return 'due_date must be a YYYY-MM-DD date';
  if (!REMINDER_CATEGORIES.includes(f.category)) return `category must be one of ${REMINDER_CATEGORIES.join(', ')}`;
  const recurrenceProblem = recurrenceError(f.recurrence, f.recurrence_interval_days);
  if (recurrenceProblem) return recurrenceProblem;
  const lead = Number(f.lead_time_days);
  if (!Number.isInteger(lead) || lead < 0 || lead > 365) return 'lead_time_days must be a whole number between 0 and 365';
  if (f.document_id) {
    const ok = db.prepare('SELECT 1 FROM documents WHERE id = ? AND property_id = ?').get(parseId(Number(f.document_id)), propertyId);
    if (!ok) return 'document_id does not belong to this property';
  }
  if (f.equipment_id) {
    const ok = db.prepare('SELECT 1 FROM equipment WHERE id = ? AND property_id = ?').get(parseId(Number(f.equipment_id)), propertyId);
    if (!ok) return 'equipment_id does not belong to this property';
  }
  return null;
}

function normalize(f) {
  return {
    title: f.title.trim(),
    category: f.category,
    due_date: f.due_date,
    recurrence: f.recurrence,
    recurrence_interval_days: f.recurrence === 'custom' ? Number(f.recurrence_interval_days) : null,
    lead_time_days: Number(f.lead_time_days),
    notify_email: f.notify_email === 0 || f.notify_email === false || f.notify_email === '0' || f.notify_email === 'false' ? 0 : 1,
    notes: f.notes ?? null,
    document_id: f.document_id ? Number(f.document_id) : null,
    equipment_id: f.equipment_id ? Number(f.equipment_id) : null,
  };
}

remindersRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT r.*, e.name AS equipment_name FROM reminders r
         LEFT JOIN equipment e ON e.id = r.equipment_id
         WHERE r.property_id = ? ORDER BY r.due_date, r.id`
      )
      .all(req.propertyId)
  );
});

remindersRouter.post('/', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const defaults = { category: 'maintenance', recurrence: 'none', lead_time_days: 7, notify_email: 1 };
  const f = { ...defaults, ...mergeFields(req.body ?? {}, {}, FIELDS) };
  // mergeFields turns absent keys into null; fall back to defaults for those.
  for (const [k, v] of Object.entries(defaults)) if (f[k] === null) f[k] = v;
  const problem = validate(f, req.propertyId);
  if (problem) return res.status(400).json({ error: problem });
  const n = normalize(f);

  const info = db
    .prepare(
      `INSERT INTO reminders
       (property_id, document_id, equipment_id, title, category, due_date, recurrence, recurrence_interval_days, lead_time_days, notify_email, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.propertyId, n.document_id, n.equipment_id, n.title, n.category, n.due_date, n.recurrence, n.recurrence_interval_days, n.lead_time_days, n.notify_email, n.notes, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid));
});

remindersRouter.put('/:id', withResourceAccess('reminders', 'owner'), (req, res) => {
  const r = req.resource;
  const f = mergeFields(req.body ?? {}, r, FIELDS);
  const problem = validate(f, r.property_id);
  if (problem) return res.status(400).json({ error: problem });
  const n = normalize(f);

  db.prepare(
    `UPDATE reminders SET document_id=?, equipment_id=?, title=?, category=?, due_date=?, recurrence=?, recurrence_interval_days=?, lead_time_days=?, notify_email=?, notes=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(n.document_id, n.equipment_id, n.title, n.category, n.due_date, n.recurrence, n.recurrence_interval_days, n.lead_time_days, n.notify_email, n.notes, r.id);
  res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(r.id));
});

// Mark complete; if recurring, roll the due date forward to the next
// occurrence after today instead of closing it.
remindersRouter.post('/:id/complete', withResourceAccess('reminders'), (req, res) => {
  const r = req.resource;
  if (r.recurrence === 'none') {
    db.prepare("UPDATE reminders SET completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(r.id);
  } else {
    const nextDue = nextOccurrenceAfter(r.due_date, r.recurrence, r.recurrence_interval_days, localToday());
    db.prepare("UPDATE reminders SET due_date = ?, updated_at = datetime('now') WHERE id = ?").run(nextDue, r.id);
  }
  res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(r.id));
});

// Undo a completion of a one-off reminder.
remindersRouter.post('/:id/reopen', withResourceAccess('reminders'), (req, res) => {
  db.prepare("UPDATE reminders SET completed_at = NULL, updated_at = datetime('now') WHERE id = ?").run(req.resource.id);
  res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.resource.id));
});

remindersRouter.delete('/:id', withResourceAccess('reminders', 'owner'), (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(req.resource.id);
  res.status(204).end();
});
