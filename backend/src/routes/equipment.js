import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';

export const equipmentRouter = Router();
equipmentRouter.use(requireAuth);

const uploadDir = process.env.UPLOAD_DIR || './data/uploads';

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // req.params.id is set once the route matches; property_id for a new
    // upload comes from the equipment row we already looked up in :id.
    const dir = path.join(uploadDir, 'equipment', String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});
const uploadPhoto = multer({ storage: photoStorage, limits: { fileSize: 20 * 1024 * 1024 } });

function getEquipmentOr404(id, res) {
  const e = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  if (!e) res.status(404).json({ error: 'Not found' });
  return e;
}

// Attaches req.propertyId/req.propertyRole for an equipment item's property.
function withEquipmentAccess(minRole) {
  return (req, res, next) => {
    const equipment = getEquipmentOr404(req.params.id, res);
    if (!equipment) return;
    req.equipment = equipment;
    req.params.propertyId = equipment.property_id;
    requirePropertyAccess({ minRole })(req, res, next);
  };
}

equipmentRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  const equipment = db
    .prepare('SELECT * FROM equipment WHERE property_id = ? ORDER BY name')
    .all(req.propertyId);
  const photoStmt = db.prepare(
    'SELECT id FROM equipment_photos WHERE equipment_id = ? ORDER BY created_at LIMIT 1'
  );
  res.json(equipment.map((e) => ({ ...e, cover_photo_id: photoStmt.get(e.id)?.id ?? null })));
});

equipmentRouter.post('/', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const { name, category, brand, model_number, serial_number, location, purchase_date, warranty_expiry, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db
    .prepare(
      `INSERT INTO equipment
       (property_id, name, category, brand, model_number, serial_number, location, purchase_date, warranty_expiry, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.propertyId,
      name,
      category || 'other',
      brand || null,
      model_number || null,
      serial_number || null,
      location || null,
      purchase_date || null,
      warranty_expiry || null,
      notes || null,
      req.user.id
    );
  res.status(201).json(db.prepare('SELECT * FROM equipment WHERE id = ?').get(info.lastInsertRowid));
});

equipmentRouter.get('/:id', withEquipmentAccess(), (req, res) => {
  const photos = db
    .prepare('SELECT id, file_name, mime_type, created_at FROM equipment_photos WHERE equipment_id = ? ORDER BY created_at')
    .all(req.equipment.id);
  const maintenance = db
    .prepare('SELECT * FROM maintenance_logs WHERE equipment_id = ? ORDER BY log_date DESC')
    .all(req.equipment.id);
  const documents = db
    .prepare('SELECT id, title, category, file_name FROM documents WHERE equipment_id = ? ORDER BY created_at DESC')
    .all(req.equipment.id);
  res.json({ ...req.equipment, photos, maintenance, documents, role: req.propertyRole });
});

equipmentRouter.put('/:id', withEquipmentAccess('owner'), (req, res) => {
  const e = req.equipment;
  const u = { ...e, ...req.body };
  db.prepare(
    `UPDATE equipment SET name=?, category=?, brand=?, model_number=?, serial_number=?, location=?, purchase_date=?, warranty_expiry=?, notes=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(u.name, u.category, u.brand, u.model_number, u.serial_number, u.location, u.purchase_date, u.warranty_expiry, u.notes, e.id);
  res.json(db.prepare('SELECT * FROM equipment WHERE id = ?').get(e.id));
});

equipmentRouter.delete('/:id', withEquipmentAccess('owner'), (req, res) => {
  const photos = db.prepare('SELECT file_path FROM equipment_photos WHERE equipment_id = ?').all(req.equipment.id);
  db.prepare('DELETE FROM equipment WHERE id = ?').run(req.equipment.id);
  for (const p of photos) fs.unlink(p.file_path, () => {});
  res.status(204).end();
});

// Photos parse first (multer needs to run before the :id-based access
// check can complete, same fix as the earlier document-upload bug) —
// here :id is already in the URL so access can be checked first, then
// upload; only the *body* fields (e.g. property_id on /documents) need
// multer-before-access. Order still: access check, then upload.
equipmentRouter.post('/:id/photos', withEquipmentAccess('owner'), uploadPhoto.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const info = db
    .prepare(
      `INSERT INTO equipment_photos (equipment_id, file_path, file_name, mime_type, file_size, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.equipment.id, req.file.path, req.file.originalname, req.file.mimetype, req.file.size, req.user.id);
  res.status(201).json(db.prepare('SELECT id, file_name, mime_type, created_at FROM equipment_photos WHERE id = ?').get(info.lastInsertRowid));
});

equipmentRouter.get('/:id/photos/:photoId', withEquipmentAccess(), (req, res) => {
  const photo = db
    .prepare('SELECT * FROM equipment_photos WHERE id = ? AND equipment_id = ?')
    .get(req.params.photoId, req.equipment.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.resolve(photo.file_path));
});

equipmentRouter.delete('/:id/photos/:photoId', withEquipmentAccess('owner'), (req, res) => {
  const photo = db
    .prepare('SELECT * FROM equipment_photos WHERE id = ? AND equipment_id = ?')
    .get(req.params.photoId, req.equipment.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM equipment_photos WHERE id = ?').run(photo.id);
  fs.unlink(photo.file_path, () => {});
  res.status(204).end();
});

equipmentRouter.post('/:id/maintenance', withEquipmentAccess(), (req, res) => {
  const { log_date, description, cost, performed_by, document_id } = req.body;
  if (!log_date || !description) return res.status(400).json({ error: 'log_date and description required' });
  const info = db
    .prepare(
      `INSERT INTO maintenance_logs (equipment_id, log_date, description, cost, performed_by, document_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.equipment.id, log_date, description, cost || null, performed_by || null, document_id || null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM maintenance_logs WHERE id = ?').get(info.lastInsertRowid));
});

equipmentRouter.delete('/:id/maintenance/:logId', withEquipmentAccess('owner'), (req, res) => {
  const log = db
    .prepare('SELECT * FROM maintenance_logs WHERE id = ? AND equipment_id = ?')
    .get(req.params.logId, req.equipment.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM maintenance_logs WHERE id = ?').run(log.id);
  res.status(204).end();
});
