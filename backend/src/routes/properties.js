import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { isIsoDate, nonEmptyString, parseId } from '../utils/http.js';
import { removeFiles } from '../utils/uploads.js';
import { audit } from '../utils/audit.js';

export const propertiesRouter = Router();
propertiesRouter.use(requireAuth);

// Each row carries the caller's role so the UI can hide controls they can't use
// (admins act as owner everywhere).
function propertiesForUser(userId, isAdmin) {
  if (isAdmin) return db.prepare("SELECT *, 'owner' AS role FROM properties ORDER BY name COLLATE NOCASE").all();
  return db
    .prepare(
      `SELECT p.*, pa.role FROM properties p
       JOIN property_access pa ON pa.property_id = p.id
       WHERE pa.user_id = ? ORDER BY p.name COLLATE NOCASE`
    )
    .all(userId);
}

// Shared by create + update. Returns an error message or null.
function propertyError({ name, purchase_date }) {
  if (!nonEmptyString(name)) return 'name required';
  if (purchase_date && !isIsoDate(purchase_date)) return 'purchase_date must be a YYYY-MM-DD date';
  return null;
}

propertiesRouter.get('/', (req, res) => {
  res.json(propertiesForUser(req.user.id, req.user.is_admin));
});

propertiesRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  const problem = propertyError(body);
  if (problem) return res.status(400).json({ error: problem });
  const { name, address, type, purchase_date, notes } = body;

  const create = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO properties (name, address, type, purchase_date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(name.trim(), address || null, type || null, purchase_date || null, notes || null, req.user.id);
    db.prepare('INSERT INTO property_access (property_id, user_id, role) VALUES (?, ?, ?)').run(
      info.lastInsertRowid,
      req.user.id,
      'owner'
    );
    return info.lastInsertRowid;
  });
  const created = db.prepare('SELECT * FROM properties WHERE id = ?').get(create());
  audit(req, 'property_created', { target: created.name });
  res.status(201).json(created);
});

propertiesRouter.get('/:propertyId', requirePropertyAccess(), (req, res) => {
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.propertyId);
  if (!property) return res.status(404).json({ error: 'Not found' });
  res.json({ ...property, role: req.propertyRole });
});

propertiesRouter.put('/:propertyId', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const body = req.body ?? {};
  const problem = propertyError(body);
  if (problem) return res.status(400).json({ error: problem });
  const { name, address, type, purchase_date, notes } = body;
  db.prepare(
    `UPDATE properties SET name = ?, address = ?, type = ?, purchase_date = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(name.trim(), address || null, type || null, purchase_date || null, notes || null, req.propertyId);
  res.json(db.prepare('SELECT * FROM properties WHERE id = ?').get(req.propertyId));
});

propertiesRouter.delete('/:propertyId', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  // Rows cascade away with the property; the files on disk would not.
  const files = [
    ...db.prepare('SELECT file_path FROM documents WHERE property_id = ?').all(req.propertyId),
    ...db
      .prepare(
        `SELECT ep.file_path FROM equipment_photos ep
         JOIN equipment e ON e.id = ep.equipment_id WHERE e.property_id = ?`
      )
      .all(req.propertyId),
  ].map((r) => r.file_path);

  const name = db.prepare('SELECT name FROM properties WHERE id = ?').get(req.propertyId)?.name;
  db.prepare('DELETE FROM properties WHERE id = ?').run(req.propertyId);
  removeFiles(files);
  audit(req, 'property_deleted', { target: name, detail: { files_removed: files.length } });
  res.status(204).end();
});

const ownerCount = (propertyId) =>
  db.prepare("SELECT COUNT(*) AS c FROM property_access WHERE property_id = ? AND role = 'owner'").get(propertyId).c;

// Share a property with another user (family member).
propertiesRouter.post('/:propertyId/share', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const { email, role } = req.body ?? {};
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email ?? '').trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newRole = role === 'owner' ? 'owner' : 'viewer';
  const existing = db
    .prepare('SELECT role FROM property_access WHERE property_id = ? AND user_id = ?')
    .get(req.propertyId, user.id);
  if (existing?.role === 'owner' && newRole !== 'owner' && ownerCount(req.propertyId) <= 1) {
    return res.status(400).json({ error: 'A property must keep at least one owner' });
  }

  db.prepare(
    `INSERT INTO property_access (property_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(property_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(req.propertyId, user.id, newRole);
  audit(req, 'property_shared', { target: String(email).trim().toLowerCase(), detail: { property_id: req.propertyId, role: newRole } });
  res.status(204).end();
});

// Who has access (owners only: it exposes household email addresses).
propertiesRouter.get('/:propertyId/members', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT u.id AS user_id, u.email, u.name, pa.role FROM property_access pa
         JOIN users u ON u.id = pa.user_id WHERE pa.property_id = ?
         ORDER BY pa.role = 'owner' DESC, u.name COLLATE NOCASE`
      )
      .all(req.propertyId)
  );
});

propertiesRouter.delete('/:propertyId/members/:userId', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const userId = parseId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Invalid user id' });
  const access = db
    .prepare('SELECT role FROM property_access WHERE property_id = ? AND user_id = ?')
    .get(req.propertyId, userId);
  if (!access) return res.status(404).json({ error: 'Not found' });
  if (access.role === 'owner' && ownerCount(req.propertyId) <= 1) {
    return res.status(400).json({ error: 'A property must keep at least one owner' });
  }
  db.prepare('DELETE FROM property_access WHERE property_id = ? AND user_id = ?').run(req.propertyId, userId);
  audit(req, 'property_access_removed', { target: String(userId), detail: { property_id: req.propertyId } });
  res.status(204).end();
});
