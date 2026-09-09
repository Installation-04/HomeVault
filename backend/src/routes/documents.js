import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

const uploadDir = process.env.UPLOAD_DIR || './data/uploads';
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadDir, String(req.body.property_id || req.params.propertyId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

documentsRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  const { q, category, tag } = req.query;
  let sql = 'SELECT * FROM documents WHERE property_id = ?';
  const params = [req.propertyId];
  if (q) {
    sql += ' AND (title LIKE ? OR notes LIKE ? OR tags LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (tag) {
    sql += ' AND tags LIKE ?';
    params.push(`%${tag}%`);
  }
  sql += ' ORDER BY document_date DESC, created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

documentsRouter.post('/', requirePropertyAccess({ minRole: 'owner' }), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const { title, category, document_date, expiry_date, notes, tags } = req.body;
  const info = db
    .prepare(
      `INSERT INTO documents
       (property_id, title, category, file_path, file_name, mime_type, file_size, document_date, expiry_date, notes, tags, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.propertyId,
      title || req.file.originalname,
      category || 'other',
      req.file.path,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      document_date || null,
      expiry_date || null,
      notes || null,
      tags || null,
      req.user.id
    );
  res.status(201).json(db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid));
});

function getDocOr404(id, res) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!doc) res.status(404).json({ error: 'Not found' });
  return doc;
}

documentsRouter.get('/:id', requireAuth, (req, res) => {
  const doc = getDocOr404(req.params.id, res);
  if (!doc) return;
  req.params.propertyId = doc.property_id;
  requirePropertyAccess()(req, res, () => res.json(doc));
});

documentsRouter.get('/:id/download', requireAuth, (req, res) => {
  const doc = getDocOr404(req.params.id, res);
  if (!doc) return;
  req.params.propertyId = doc.property_id;
  requirePropertyAccess()(req, res, () => res.download(doc.file_path, doc.file_name));
});

documentsRouter.put('/:id', requireAuth, (req, res) => {
  const doc = getDocOr404(req.params.id, res);
  if (!doc) return;
  req.params.propertyId = doc.property_id;
  requirePropertyAccess({ minRole: 'owner' })(req, res, () => {
    const { title, category, document_date, expiry_date, notes, tags } = req.body;
    db.prepare(
      `UPDATE documents SET title = ?, category = ?, document_date = ?, expiry_date = ?, notes = ?, tags = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      title ?? doc.title,
      category ?? doc.category,
      document_date ?? doc.document_date,
      expiry_date ?? doc.expiry_date,
      notes ?? doc.notes,
      tags ?? doc.tags,
      doc.id
    );
    res.json(db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id));
  });
});

documentsRouter.delete('/:id', requireAuth, (req, res) => {
  const doc = getDocOr404(req.params.id, res);
  if (!doc) return;
  req.params.propertyId = doc.property_id;
  requirePropertyAccess({ minRole: 'owner' })(req, res, () => {
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    fs.unlink(doc.file_path, () => {});
    res.status(204).end();
  });
});
