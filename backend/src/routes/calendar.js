import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';

export const calendarRouter = Router();
calendarRouter.use(requireAuth);

const MAX_EXTERNAL_ITEMS = 3000;

const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

// Events read from subscribed calendars. One entry per day an event covers (so the month grid can
// draw it on each day), flagged `continues` after the first. Read-only: the source calendar is the master.
function externalEvents(propertyId, from, to) {
  const clauses = ['e.property_id = ?'];
  const params = [propertyId];
  if (from) {
    clauses.push('e.end_date >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('e.start_date <= ?');
    params.push(to);
  }
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.location, e.start_date, e.start_time, e.end_date, e.end_time, e.all_day, i.name AS source
       FROM external_events e JOIN integrations i ON i.id = e.integration_id
       WHERE ${clauses.join(' AND ')} ORDER BY e.start_date, e.start_time LIMIT 5000`
    )
    .all(...params);

  const out = [];
  for (const e of rows) {
    let day = from && e.start_date < from ? from : e.start_date;
    const last = to && e.end_date > to ? to : e.end_date;
    for (let guard = 0; day <= last && guard < 31; guard += 1, day = addDays(day, 1)) {
      if (out.length >= MAX_EXTERNAL_ITEMS) return out;
      out.push({
        type: 'external',
        id: e.id,
        title: e.title,
        date: day,
        time: day === e.start_date ? e.start_time : null,
        end_time: day === e.end_date ? e.end_time : null,
        all_day: Boolean(e.all_day),
        location: e.location,
        source: e.source,
        continues: day !== e.start_date,
        completed_at: null,
      });
    }
  }
  return out;
}

// Merged calendar feed for a property: reminders + tasks + events from subscribed calendars, optional date range.
calendarRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  const { from, to } = req.query;
  // ?only=external: just the events read from subscribed calendars (the Calendar page loads them separately).
  if (req.query.only === 'external') return res.json(externalEvents(req.propertyId, from, to));
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

  const external = externalEvents(req.propertyId, from, to);

  const events = [...reminders, ...tasks, ...external].sort((a, b) => (a.date === b.date ? (a.time ?? '').localeCompare(b.time ?? '') : a.date < b.date ? -1 : 1));
  res.json(events);
});
