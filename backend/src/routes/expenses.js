import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';

export const expensesRouter = Router();
expensesRouter.use(requireAuth);

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
    params.push(home_office === 'true' || home_office === '1' ? 1 : 0);
  }
  sql += ' ORDER BY expense_date DESC';
  res.json(db.prepare(sql).all(...params));
});

expensesRouter.post('/', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const { category, is_home_office, amount, currency, expense_date, description, receipt_document_id } = req.body;
  if (!category || amount == null || !expense_date) {
    return res.status(400).json({ error: 'category, amount, expense_date required' });
  }
  const info = db
    .prepare(
      `INSERT INTO expenses (property_id, category, is_home_office, amount, currency, expense_date, description, receipt_document_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.propertyId,
      category,
      is_home_office ? 1 : 0,
      amount,
      currency || 'CAD',
      expense_date,
      description || null,
      receipt_document_id || null,
      req.user.id
    );
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(info.lastInsertRowid));
});

function getExpenseOr404(id, res) {
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!e) res.status(404).json({ error: 'Not found' });
  return e;
}

expensesRouter.put('/:id', requireAuth, (req, res) => {
  const e = getExpenseOr404(req.params.id, res);
  if (!e) return;
  req.params.propertyId = e.property_id;
  requirePropertyAccess({ minRole: 'owner' })(req, res, () => {
    const u = { ...e, ...req.body };
    db.prepare(
      `UPDATE expenses SET category=?, is_home_office=?, amount=?, currency=?, expense_date=?, description=?, receipt_document_id=?, updated_at=datetime('now')
       WHERE id = ?`
    ).run(u.category, u.is_home_office ? 1 : 0, u.amount, u.currency, u.expense_date, u.description, u.receipt_document_id, e.id);
    res.json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(e.id));
  });
});

expensesRouter.delete('/:id', requireAuth, (req, res) => {
  const e = getExpenseOr404(req.params.id, res);
  if (!e) return;
  req.params.propertyId = e.property_id;
  requirePropertyAccess({ minRole: 'owner' })(req, res, () => {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
    res.status(204).end();
  });
});

// CSV export for tax season.
expensesRouter.get('/property/:propertyId/export.csv', requirePropertyAccess(), (req, res) => {
  const { year } = req.query;
  let sql = 'SELECT * FROM expenses WHERE property_id = ?';
  const params = [req.propertyId];
  if (year) {
    sql += " AND strftime('%Y', expense_date) = ?";
    params.push(String(year));
  }
  sql += ' ORDER BY expense_date';
  const rows = db.prepare(sql).all(...params);

  const header = ['date', 'category', 'home_office', 'amount', 'currency', 'description'];
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [r.expense_date, r.category, r.is_home_office ? 'yes' : 'no', r.amount, r.currency, r.description].map(csvEscape).join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="expenses-${req.propertyId}-${year || 'all'}.csv"`);
  res.send(lines.join('\n'));
});
