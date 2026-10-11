import { Router } from 'express';
import path from 'node:path';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { withResourceAccess } from '../middleware/resource.js';
import { httpError, isIsoDate, mergeFields, nonEmptyString, parseId } from '../utils/http.js';
import { discardUploadUnlessStored, makeUploader, removeFiles, storeUpload } from '../utils/uploads.js';

export const equipmentRouter = Router();
equipmentRouter.use(requireAuth);

const uploadPhoto = makeUploader({ maxBytes: 20 * 1024 * 1024, imagesOnly: true });

const FIELDS = ['name', 'category', 'brand', 'model_number', 'serial_number', 'location', 'purchase_date', 'warranty_expiry', 'notes'];

function equipmentError(f) {
  if (!nonEmptyString(f.name)) return 'name required';
  for (const key of ['purchase_date', 'warranty_expiry']) {
    if (f[key] && !isIsoDate(f[key])) return `${key} must be a YYYY-MM-DD date`;
  }
  return null;
}

equipmentRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT e.*,
           (SELECT id FROM equipment_photos WHERE equipment_id = e.id ORDER BY created_at, id LIMIT 1) AS cover_photo_id
         FROM equipment e WHERE e.property_id = ? ORDER BY e.name COLLATE NOCASE`
      )
      .all(req.propertyId)
  );
});

equipmentRouter.post('/', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const body = req.body ?? {};
  const f = mergeFields(body, {}, FIELDS);
  f.category = f.category || 'other';
  const problem = equipmentError(f);
  if (problem) return res.status(400).json({ error: problem });
  const info = db
    .prepare(
      `INSERT INTO equipment
       (property_id, name, category, brand, model_number, serial_number, location, purchase_date, warranty_expiry, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.propertyId,
      f.name.trim(),
      f.category,
      f.brand,
      f.model_number,
      f.serial_number,
      f.location,
      f.purchase_date,
      f.warranty_expiry,
      f.notes,
      req.user.id
    );
  res.status(201).json(db.prepare('SELECT * FROM equipment WHERE id = ?').get(info.lastInsertRowid));
});

equipmentRouter.get('/:id', withResourceAccess('equipment'), (req, res) => {
  const equipment = req.resource;
  const photos = db
    .prepare('SELECT id, file_name, mime_type, created_at FROM equipment_photos WHERE equipment_id = ? ORDER BY created_at, id')
    .all(equipment.id);
  const maintenance = db
    .prepare('SELECT * FROM maintenance_logs WHERE equipment_id = ? ORDER BY log_date DESC, id DESC')
    .all(equipment.id);
  const documents = db
    .prepare('SELECT id, title, category, file_name FROM documents WHERE equipment_id = ? ORDER BY created_at DESC')
    .all(equipment.id);
  res.json({ ...equipment, photos, maintenance, documents, role: req.propertyRole });
});

equipmentRouter.put('/:id', withResourceAccess('equipment', 'owner'), (req, res) => {
  const e = req.resource;
  const f = mergeFields(req.body ?? {}, e, FIELDS);
  f.category = f.category || 'other';
  const problem = equipmentError(f);
  if (problem) return res.status(400).json({ error: problem });
  db.prepare(
    `UPDATE equipment SET name=?, category=?, brand=?, model_number=?, serial_number=?, location=?, purchase_date=?, warranty_expiry=?, notes=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(f.name.trim(), f.category, f.brand, f.model_number, f.serial_number, f.location, f.purchase_date, f.warranty_expiry, f.notes, e.id);
  res.json(db.prepare('SELECT * FROM equipment WHERE id = ?').get(e.id));
});

equipmentRouter.delete('/:id', withResourceAccess('equipment', 'owner'), (req, res) => {
  const photos = db.prepare('SELECT file_path FROM equipment_photos WHERE equipment_id = ?').all(req.resource.id);
  db.prepare('DELETE FROM equipment WHERE id = ?').run(req.resource.id);
  removeFiles(photos.map((p) => p.file_path));
  res.status(204).end();
});

// Access is checked first here (the equipment id is in the URL), then the
// upload is parsed into a temp folder and moved into place on success.
equipmentRouter.post(
  '/:id/photos',
  withResourceAccess('equipment', 'owner'),
  uploadPhoto.single('file'),
  discardUploadUnlessStored,
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const storedPath = storeUpload(req.file, 'equipment', req.resource.id);
    try {
      const info = db
        .prepare(
          `INSERT INTO equipment_photos (equipment_id, file_path, file_name, mime_type, file_size, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(req.resource.id, storedPath, req.file.originalname, req.file.mimetype, req.file.size, req.user.id);
      res
        .status(201)
        .json(db.prepare('SELECT id, file_name, mime_type, created_at FROM equipment_photos WHERE id = ?').get(info.lastInsertRowid));
    } catch (err) {
      removeFiles([storedPath]);
      throw err;
    }
  }
);

equipmentRouter.get('/:id/photos/:photoId', withResourceAccess('equipment'), (req, res, next) => {
  const photo = db
    .prepare('SELECT * FROM equipment_photos WHERE id = ? AND equipment_id = ?')
    .get(parseId(req.params.photoId), req.resource.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.resolve(photo.file_path), { headers: { 'Cache-Control': 'private, max-age=86400' } }, (err) => {
    if (!err || res.headersSent) return;
    next(err.code === 'ENOENT' ? httpError(404, 'Photo file is missing from storage') : err);
  });
});

equipmentRouter.delete('/:id/photos/:photoId', withResourceAccess('equipment', 'owner'), (req, res) => {
  const photo = db
    .prepare('SELECT * FROM equipment_photos WHERE id = ? AND equipment_id = ?')
    .get(parseId(req.params.photoId), req.resource.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM equipment_photos WHERE id = ?').run(photo.id);
  removeFiles([photo.file_path]);
  res.status(204).end();
});

equipmentRouter.post('/:id/maintenance', withResourceAccess('equipment'), (req, res) => {
  const { log_date, description, cost, performed_by, document_id } = req.body ?? {};
  if (!isIsoDate(log_date) || !nonEmptyString(description)) {
    return res.status(400).json({ error: 'log_date (YYYY-MM-DD) and description required' });
  }
  const costValue = cost === undefined || cost === null || cost === '' ? null : Number(cost);
  if (costValue !== null && !Number.isFinite(costValue)) return res.status(400).json({ error: 'cost must be a number' });
  if (document_id) {
    const sameProperty = db
      .prepare('SELECT 1 FROM documents WHERE id = ? AND property_id = ?')
      .get(parseId(Number(document_id)), req.resource.property_id);
    if (!sameProperty) return res.status(400).json({ error: 'document_id does not belong to this property' });
  }
  const info = db
    .prepare(
      `INSERT INTO maintenance_logs (equipment_id, log_date, description, cost, performed_by, document_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.resource.id, log_date, description.trim(), costValue, performed_by || null, document_id || null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM maintenance_logs WHERE id = ?').get(info.lastInsertRowid));
});

equipmentRouter.delete('/:id/maintenance/:logId', withResourceAccess('equipment', 'owner'), (req, res) => {
  const log = db
    .prepare('SELECT * FROM maintenance_logs WHERE id = ? AND equipment_id = ?')
    .get(parseId(req.params.logId), req.resource.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM maintenance_logs WHERE id = ?').run(log.id);
  res.status(204).end();
});
