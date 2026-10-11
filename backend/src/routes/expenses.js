import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { withResourceAccess } from '../middleware/resource.js';
import { isIsoDate, mergeFields, nonEmptyString, parseId } from '../utils/http.js';

export const expensesRouter = Router();
expensesRouter.use(requireAuth);

const FIELDS = ['category', 'is_home_office', 'amount', 'currency', 'expense_date', 'description', 'receipt_document_id'];

function validate(f, propertyId) {
  if (!nonEmptyString(f.category)) return 'category required';
  if (f.amount === null || f.amount === '' || !Number.isFinite(Number(f.amount))) return 'amount must be a number';
  if (!isIsoDate(f.expense_date)) return 'expense_date must be a YYYY-MM-DD date';
  if (f.currency && !/^[A-Za-z]{3}$/.test(f.currency)) return 'currency must be a 3-letter code';
  if (f.receipt_document_id) {
    const ok = db
      .prepare('SELECT 1 FROM documents WHERE id = ? AND property_id = ?')
      .get(parseId(Number(f.receipt_document_id)), propertyId);
    if (!ok) return 'receipt_document_id does not belong to this property';
  }
  return null;
}

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

expensesRouter.get('/property/:propertyId', requirePropertyAccess(), (req, res) => {
  const { year, category, home_office } = req.query;
  let sql = 'SELECT * FROM expenses WHERE property_id = ?';
  const params = [req.propertyId];
  if (year) {
    sql += " AND strftime('%Y', expense_date) = ?";
    params.push(String(year));
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (home_office !== undefined) {
    sql += ' AND is_home_office = ?';
    params.push(truthy(home_office) ? 1 : 0);
  }
  sql += ' ORDER BY expense_date DESC, id DESC';
  res.json(db.prepare(sql).all(...params));
});

// Distinct years that have expenses, newest first (drives the year picker).
expensesRouter.get('/property/:propertyId/years', requirePropertyAccess(), (req, res) => {
  const rows = db
    .prepare("SELECT DISTINCT strftime('%Y', expense_date) AS year FROM expenses WHERE property_id = ? ORDER BY year DESC")
    .all(req.propertyId);
  res.json(rows.map((r) => r.year));
});

expensesRouter.post('/', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const f = mergeFields(req.body ?? {}, {}, FIELDS);
  f.currency = f.currency || 'CAD';
  const problem = validate(f, req.propertyId);
  if (problem) return res.status(400).json({ error: problem });

  const info = db
    .prepare(
      `INSERT INTO expenses (property_id, category, is_home_office, amount, currency, expense_date, description, receipt_document_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.propertyId,
      f.category,
      truthy(f.is_home_office) ? 1 : 0,
      Number(f.amount),
      f.currency.toUpperCase(),
      f.expense_date,
      f.description,
      f.receipt_document_id ? Number(f.receipt_document_id) : null,
      req.user.id
    );
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(info.lastInsertRowid));
});

expensesRouter.put('/:id', withResourceAccess('expenses', 'owner'), (req, res) => {
  const e = req.resource;
  const f = mergeFields(req.body ?? {}, e, FIELDS);
  f.currency = f.currency || 'CAD';
  const problem = validate(f, e.property_id);
  if (problem) return res.status(400).json({ error: problem });

  db.prepare(
    `UPDATE expenses SET category=?, is_home_office=?, amount=?, currency=?, expense_date=?, description=?, receipt_document_id=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(
    f.category,
    truthy(f.is_home_office) ? 1 : 0,
    Number(f.amount),
    f.currency.toUpperCase(),
    f.expense_date,
    f.description,
    f.receipt_document_id ? Number(f.receipt_document_id) : null,
    e.id
  );
  res.json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(e.id));
});

expensesRouter.delete('/:id', withResourceAccess('expenses', 'owner'), (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.resource.id);
  res.status(204).end();
});

// Cells starting with = + - @ are executed as formulas by Excel/Sheets, so a
// description like "=HYPERLINK(...)" entered by one family member would run
// on whoever opens the tax-season export. Prefix them with an apostrophe.
function csvCell(value, { text = false } = {}) {
  let s = String(value ?? '');
  // Only free-text columns are guarded; amounts may legitimately start with "-".
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// CSV export for tax season.
expensesRouter.get('/property/:propertyId/export.csv', requirePropertyAccess(), (req, res) => {
  const { year } = req.query;
  let sql = 'SELECT * FROM expenses WHERE property_id = ?';
  const params = [req.propertyId];
  if (year) {
    sql += " AND strftime('%Y', expense_date) = ?";
    params.push(String(year));
  }
  sql += ' ORDER BY expense_date, id';
  const rows = db.prepare(sql).all(...params);

  const header = ['date', 'category', 'home_office', 'amount', 'currency', 'description'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.expense_date),
        csvCell(r.category, { text: true }),
        csvCell(r.is_home_office ? 'yes' : 'no'),
        csvCell(r.amount),
        csvCell(r.currency),
        csvCell(r.description, { text: true }),
      ].join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`expenses-${req.propertyId}-${/^\d{4}$/.test(String(year)) ? year : 'all'}.csv`);
  // BOM so Excel opens the file as UTF-8 (accents in French descriptions).
  res.send('\uFEFF' + lines.join('\r\n'));
});
