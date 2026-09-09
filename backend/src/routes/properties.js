import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';

export const propertiesRouter = Router();
propertiesRouter.use(requireAuth);

function propertiesForUser(userId, isAdmin) {
  if (isAdmin) return db.prepare('SELECT * FROM properties ORDER BY name').all();
  return db
    .prepare(
      `SELECT p.* FROM properties p
       JOIN property_access pa ON pa.property_id = p.id
       WHERE pa.user_id = ? ORDER BY p.name`
    )
    .all(userId);
}

propertiesRouter.get('/', (req, res) => {
  res.json(propertiesForUser(req.user.id, req.user.is_admin));
});

propertiesRouter.post('/', (req, res) => {
  const { name, address, type, purchase_date, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db
    .prepare(
      'INSERT INTO properties (name, address, type, purchase_date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(name, address || null, type || null, purchase_date || null, notes || null, req.user.id);
  db.prepare('INSERT INTO property_access (property_id, user_id, role) VALUES (?, ?, ?)').run(
    info.lastInsertRowid,
    req.user.id,
    'owner'
  );
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(property);
});

propertiesRouter.get('/:propertyId', requirePropertyAccess(), (req, res) => {
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.propertyId);
  if (!property) return res.status(404).json({ error: 'Not found' });
  res.json({ ...property, role: req.propertyRole });
});

propertiesRouter.put('/:propertyId', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const { name, address, type, purchase_date, notes } = req.body;
  db.prepare(
    `UPDATE properties SET name = ?, address = ?, type = ?, purchase_date = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(name, address || null, type || null, purchase_date || null, notes || null, req.propertyId);
  res.json(db.prepare('SELECT * FROM properties WHERE id = ?').get(req.propertyId));
});

propertiesRouter.delete('/:propertyId', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  db.prepare('DELETE FROM properties WHERE id = ?').run(req.propertyId);
  res.status(204).end();
});

// Share a property with another user (family member).
propertiesRouter.post('/:propertyId/share', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const { email, role } = req.body;
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare(
    `INSERT INTO property_access (property_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(property_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(req.propertyId, user.id, role === 'owner' ? 'owner' : 'viewer');
  res.status(204).end();
});
