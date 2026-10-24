import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { likePattern } from '../utils/http.js';

export const searchRouter = Router();
searchRouter.use(requireAuth);

const PER_TYPE = 6;

// One search box for everything the signed-in person can see, across all of
// their properties. Every value is bound as a parameter; the only SQL we build
// is a run of `?` placeholders sized to the number of properties.
searchRouter.get('/', (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ q, documents: [], equipment: [], reminders: [], tasks: [], expenses: [] });

  const properties = req.user.is_admin
    ? db.prepare('SELECT id, name FROM properties').all()
    : db.prepare('SELECT p.id, p.name FROM properties p JOIN property_access pa ON pa.property_id = p.id WHERE pa.user_id = ?').all(req.user.id);
  if (properties.length === 0) return res.json({ q, documents: [], equipment: [], reminders: [], tasks: [], expenses: [] });

  const names = new Map(properties.map((p) => [p.id, p.name]));
  const marks = properties.map(() => '?').join(',');
  const ids = properties.map((p) => p.id);
  const like = likePattern(q);
  const match = (columns) => columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ');
  const run = (sql, columns, order) => {
    const rows = db
      .prepare(`${sql} WHERE property_id IN (${marks}) AND (${match(columns)}) ORDER BY ${order} LIMIT ${PER_TYPE}`)
      .all(...ids, ...columns.map(() => like));
    return rows.map((r) => ({ ...r, property_name: names.get(r.property_id) }));
  };

  res.json({
    q,
    documents: run('SELECT id, property_id, title, category, expiry_date FROM documents', ['title', 'notes', 'tags', 'file_name'], 'updated_at DESC'),
    equipment: run(
      'SELECT id, property_id, name, brand, model_number, location FROM equipment',
      ['name', 'brand', 'model_number', 'serial_number', 'location', 'notes'],
      'name COLLATE NOCASE'
    ),
    reminders: run('SELECT id, property_id, title, due_date, completed_at FROM reminders', ['title', 'notes'], 'completed_at IS NOT NULL, due_date'),
    tasks: run('SELECT id, property_id, title, event_date, completed_at FROM tasks', ['title', 'notes'], 'completed_at IS NOT NULL, event_date'),
    expenses: run('SELECT id, property_id, category, amount, currency, expense_date, description FROM expenses', ['description', 'category'], 'expense_date DESC'),
  });
});
