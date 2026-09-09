import { Router } from 'express';
import archiver from 'archiver';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';

export const exportRouter = Router();
exportRouter.use(requireAuth);

// "Estate transfer" bundle: zip of every document + a plain-text summary
// of properties, reminders, tasks and expenses. Useful for handing off
// ownership or keeping an offline archive.
exportRouter.get('/property/:propertyId/bundle.zip', requirePropertyAccess(), (req, res) => {
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.propertyId);
  const documents = db.prepare('SELECT * FROM documents WHERE property_id = ?').all(req.propertyId);
  const reminders = db.prepare('SELECT * FROM reminders WHERE property_id = ?').all(req.propertyId);
  const tasks = db.prepare('SELECT * FROM tasks WHERE property_id = ?').all(req.propertyId);
  const expenses = db.prepare('SELECT * FROM expenses WHERE property_id = ?').all(req.propertyId);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="homevault-${property.name}-export.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end(String(err)));
  archive.pipe(res);

  const summaryLines = [
    `HomeVault export — ${property.name}`,
    `Generated: ${new Date().toISOString()}`,
    `Address: ${property.address || 'n/a'}`,
    `Type: ${property.type || 'n/a'}`,
    `Purchase date: ${property.purchase_date || 'n/a'}`,
    '',
    '== Documents ==',
    ...documents.map((d) => `- [${d.category}] ${d.title} (${d.document_date || 'n/a'}, expires ${d.expiry_date || 'n/a'}) -> documents/${d.id}-${d.file_name}`),
    '',
    '== Reminders ==',
    ...reminders.map((r) => `- ${r.title} due ${r.due_date} (${r.category}, ${r.recurrence})`),
    '',
    '== Tasks ==',
    ...tasks.map((t) => `- ${t.title} on ${t.event_date}`),
    '',
    '== Expenses ==',
    ...expenses.map((e) => `- ${e.expense_date} ${e.category} ${e.amount} ${e.currency}${e.is_home_office ? ' (home office)' : ''}`),
  ];
  archive.append(summaryLines.join('\n'), { name: 'summary.txt' });

  for (const d of documents) {
    archive.file(d.file_path, { name: `documents/${d.id}-${d.file_name}` });
  }

  archive.finalize();
});
