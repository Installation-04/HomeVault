import { db } from '../db/index.js';
import { requirePropertyAccess } from './auth.js';
import { parseId } from '../utils/http.js';

const ALLOWED_TABLES = new Set(['documents', 'equipment', 'reminders', 'tasks', 'expenses']);

// For routes like /:id on a table that has a property_id column: loads the
// row into req.resource (404 if missing), then enforces the usual property
// access rule against the row's own property. `table` is always a literal
// from the route files, never request input.
export function withResourceAccess(table, minRole = 'viewer') {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`withResourceAccess: unsupported table ${table}`);
  const stmt = db.prepare(`SELECT * FROM ${table} WHERE id = ?`);
  const check = requirePropertyAccess({ minRole });
  return (req, res, next) => {
    const id = parseId(req.params.id);
    const row = id ? stmt.get(id) : null;
    if (!row) return res.status(404).json({ error: 'Not found' });
    req.resource = row;
    req.params.propertyId = String(row.property_id);
    check(req, res, next);
  };
}
