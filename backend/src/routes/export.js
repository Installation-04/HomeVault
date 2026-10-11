import { Router } from 'express';
import archiver from 'archiver';
import fs from 'node:fs';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';

export const exportRouter = Router();
exportRouter.use(requireAuth);

// Keeps client-supplied names from escaping their folder inside the zip
// ("zip slip") or from breaking the Content-Disposition header.
const safeName = (s) => String(s ?? '').replace(/[\\/\0]/g, '_').replace(/^\.+/, '_');

// "Estate transfer" bundle: zip of every document + a plain-text summary
// of the property, equipment, reminders, tasks and expenses. Useful for
// handing off ownership or keeping an offline archive.
exportRouter.get('/property/:propertyId/bundle.zip', requirePropertyAccess(), (req, res, next) => {
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.propertyId);
  if (!property) return res.status(404).json({ error: 'Not found' });

  const documents = db.prepare('SELECT * FROM documents WHERE property_id = ? ORDER BY id').all(req.propertyId);
  const equipment = db.prepare('SELECT * FROM equipment WHERE property_id = ? ORDER BY name').all(req.propertyId);
  const maintenance = db
    .prepare(
      `SELECT m.*, e.name AS equipment_name FROM maintenance_logs m
       JOIN equipment e ON e.id = m.equipment_id WHERE e.property_id = ? ORDER BY m.log_date`
    )
    .all(req.propertyId);
  const reminders = db.prepare('SELECT * FROM reminders WHERE property_id = ? ORDER BY due_date').all(req.propertyId);
  const tasks = db.prepare('SELECT * FROM tasks WHERE property_id = ? ORDER BY event_date').all(req.propertyId);
  const expenses = db.prepare('SELECT * FROM expenses WHERE property_id = ? ORDER BY expense_date').all(req.propertyId);

  // A file can go missing from the volume (manual cleanup, partial restore).
  // Skip it and say so, rather than failing the whole export.
  const entryName = (d) => `documents/${d.id}-${safeName(d.file_name)}`;
  const present = documents.filter((d) => fs.existsSync(d.file_path));
  const missing = documents.filter((d) => !present.includes(d));

  const summaryLines = [
    `HomeVault export — ${property.name}`,
    `Generated: ${new Date().toISOString()}`,
    `Address: ${property.address || 'n/a'}`,
    `Type: ${property.type || 'n/a'}`,
    `Purchase date: ${property.purchase_date || 'n/a'}`,
    '',
    '== Documents ==',
    ...documents.map(
      (d) =>
        `- [${d.category}] ${d.title} (${d.document_date || 'n/a'}, expires ${d.expiry_date || 'n/a'}) -> ${
          present.includes(d) ? entryName(d) : 'FILE MISSING FROM STORAGE'
        }`
    ),
    '',
    '== Equipment ==',
    ...equipment.map(
      (e) =>
        `- ${e.name} [${e.category}] ${[e.brand, e.model_number].filter(Boolean).join(' ')}${e.serial_number ? ` S/N ${e.serial_number}` : ''}` +
        ` — location ${e.location || 'n/a'}, purchased ${e.purchase_date || 'n/a'}, warranty until ${e.warranty_expiry || 'n/a'}`
    ),
    '',
    '== Maintenance history ==',
    ...maintenance.map(
      (m) =>
        `- ${m.log_date} ${m.equipment_name}: ${m.description}${m.cost != null ? ` (${m.cost})` : ''}${m.performed_by ? ` by ${m.performed_by}` : ''}`
    ),
    '',
    '== Reminders ==',
    ...reminders.map((r) => `- ${r.title} due ${r.due_date} (${r.category}, ${r.recurrence})${r.completed_at ? ' [done]' : ''}`),
    '',
    '== Tasks ==',
    ...tasks.map((t) => `- ${t.title} on ${t.event_date}${t.completed_at ? ' [done]' : ''}`),
    '',
    '== Expenses ==',
    ...expenses.map(
      (e) => `- ${e.expense_date} ${e.category} ${e.amount} ${e.currency}${e.is_home_office ? ' (home office)' : ''}${e.description ? ` — ${e.description}` : ''}`
    ),
  ];
  if (missing.length) {
    summaryLines.push('', `Note: ${missing.length} document file(s) were missing from storage and could not be included.`);
  }

  res.attachment(`homevault-${safeName(property.name)}-export.zip`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (err) => console.warn('Export warning:', err.message));
  archive.on('error', (err) => {
    if (!res.headersSent) next(err);
    else res.destroy(err);
  });
  // Stop reading files if the client disconnects mid-download.
  let finished = false;
  archive.on('end', () => {
    finished = true;
  });
  res.on('close', () => {
    if (!finished) archive.abort();
  });
  archive.pipe(res);

  archive.append(summaryLines.join('\n'), { name: 'summary.txt' });
  for (const d of present) archive.file(d.file_path, { name: entryName(d) });
  archive.finalize();
});
