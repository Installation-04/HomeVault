import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { withResourceAccess } from '../middleware/resource.js';
import { httpError, isIsoDate, likePattern, mergeFields, nonEmptyString, parseId } from '../utils/http.js';
import { discardUploadUnlessStored, makeUploader, removeFiles, storeUpload } from '../utils/uploads.js';

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

export const DOCUMENT_CATEGORIES = ['invoice', 'warranty', 'insurance', 'contract', 'photo', 'maintenance', 'tax', 'other'];

const upload = makeUploader({ maxBytes: 50 * 1024 * 1024 });

const SELECT_WITH_EQUIPMENT = `SELECT d.*, e.name AS equipment_name FROM documents d
  LEFT JOIN equipment e ON e.id = d.equipment_id`;

// Returns an error message, or null when the (merged) document fields are valid.
function documentError(fields, propertyId) {
  if (!nonEmptyString(fields.title)) return 'title required';
  if (!DOCUMENT_CATEGORIES.includes(fields.category)) return `category must be one of ${DOCUMENT_CATEGORIES.join(', ')}`;
  for (const key of ['document_date', 'expiry_date']) {
    if (fields[key] && !isIsoDate(fields[key])) return `${key} must be a YYYY-MM-DD date`;
  }
  if (fields.equipment_id !== null && fields.equipment_id !== undefined) {
    const equipmentId = parseId(Number(fields.equipment_id));
    const owns = equipmentId && db.prepare('SELECT 1 FROM equipment WHERE id = ? AND property_id = ?').get(equipmentId, propertyId);
    if (!owns) return 'equipment_id does not belong to this property';
  }
  return null;
}

documentsRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  const { q, category, tag, equipment_id } = req.query;
  let sql = `${SELECT_WITH_EQUIPMENT} WHERE d.property_id = ?`;
  const params = [req.propertyId];
  if (q) {
    sql += " AND (d.title LIKE ? ESCAPE '\\' OR d.notes LIKE ? ESCAPE '\\' OR d.tags LIKE ? ESCAPE '\\')";
    const pattern = likePattern(q);
    params.push(pattern, pattern, pattern);
  }
  if (category) {
    sql += ' AND d.category = ?';
    params.push(category);
  }
  if (tag) {
    sql += " AND d.tags LIKE ? ESCAPE '\\'";
    params.push(likePattern(tag));
  }
  if (equipment_id) {
    sql += ' AND d.equipment_id = ?';
    params.push(Number(equipment_id));
  }
  sql += ' ORDER BY d.document_date DESC, d.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// multer has to parse the multipart body before property_id is known, so the
// file goes to a private temp folder first; the property access check runs
// next and only then is the file moved into its property folder.
documentsRouter.post(
  '/',
  upload.single('file'),
  discardUploadUnlessStored,
  requirePropertyAccess({ minRole: 'owner' }),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const b = req.body;
    const fields = {
      title: nonEmptyString(b.title) ? b.title.trim() : req.file.originalname,
      category: b.category || 'other',
      document_date: b.document_date || null,
      expiry_date: b.expiry_date || null,
      equipment_id: b.equipment_id || null,
      notes: b.notes || null,
      tags: b.tags || null,
    };
    const problem = documentError(fields, req.propertyId);
    if (problem) return res.status(400).json({ error: problem });

    const storedPath = storeUpload(req.file, req.propertyId);
    try {
      const info = db
        .prepare(
          `INSERT INTO documents
           (property_id, equipment_id, title, category, file_path, file_name, mime_type, file_size, document_date, expiry_date, notes, tags, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          req.propertyId,
          fields.equipment_id ? Number(fields.equipment_id) : null,
          fields.title,
          fields.category,
          storedPath,
          req.file.originalname,
          req.file.mimetype,
          req.file.size,
          fields.document_date,
          fields.expiry_date,
          fields.notes,
          fields.tags,
          req.user.id
        );
      res.status(201).json(db.prepare(`${SELECT_WITH_EQUIPMENT} WHERE d.id = ?`).get(info.lastInsertRowid));
    } catch (err) {
      removeFiles([storedPath]);
      throw err;
    }
  }
);

documentsRouter.get('/:id', withResourceAccess('documents'), (req, res) => {
  res.json(db.prepare(`${SELECT_WITH_EQUIPMENT} WHERE d.id = ?`).get(req.resource.id));
});

documentsRouter.get('/:id/download', withResourceAccess('documents'), (req, res, next) => {
  const doc = req.resource;
  res.download(doc.file_path, doc.file_name, (err) => {
    if (!err) return;
    if (res.headersSent) return;
    if (err.code === 'ENOENT') return next(httpError(404, 'The file for this document is missing from storage'));
    next(err);
  });
});

documentsRouter.put('/:id', withResourceAccess('documents', 'owner'), (req, res) => {
  const doc = req.resource;
  const fields = mergeFields(req.body ?? {}, doc, ['title', 'category', 'document_date', 'expiry_date', 'notes', 'tags', 'equipment_id']);
  const problem = documentError(fields, doc.property_id);
  if (problem) return res.status(400).json({ error: problem });

  db.prepare(
    `UPDATE documents SET title = ?, category = ?, document_date = ?, expiry_date = ?, notes = ?, tags = ?, equipment_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    fields.title.trim(),
    fields.category,
    fields.document_date,
    fields.expiry_date,
    fields.notes,
    fields.tags,
    fields.equipment_id ? Number(fields.equipment_id) : null,
    doc.id
  );
  res.json(db.prepare(`${SELECT_WITH_EQUIPMENT} WHERE d.id = ?`).get(doc.id));
});

documentsRouter.delete('/:id', withResourceAccess('documents', 'owner'), (req, res) => {
  const doc = req.resource;
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  removeFiles([doc.file_path]);
  res.status(204).end();
});
