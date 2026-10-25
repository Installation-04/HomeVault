import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { db } from '../db/index.js';
import { requireAuth, requirePropertyAccess } from '../middleware/auth.js';
import { withResourceAccess } from '../middleware/resource.js';
import { audit } from '../utils/audit.js';
import { httpError, wrap } from '../utils/http.js';
import { LIMITS, parseStatement } from '../integrations/bank/parse.js';
import { acceptTransactions, countKnown, createRule, ignoreTransactions, importTransactions, listRules, listTransactions, restoreTransactions, undoBatch } from '../integrations/bank/store.js';

// Bank statements and the review inbox. Owners only: the raw descriptions of every purchase are more
// sensitive than the expense totals everyone with access can already see.
export const bankRouter = Router();
bankRouter.use(requireAuth);

// Statements are small and parsed in memory, never written to disk.
const statementUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.maxBytes, files: 1, fields: 12, fieldSize: 16 * 1024 } });

const isSmallInt = (n) => Number.isInteger(n) && n >= 0 && n < 200;

// The options a person can change after seeing what was detected.
function readOptions(req) {
  const b = req.body ?? {};
  const options = { localeHint: req.user.locale === 'fr' ? 'fr' : 'en' };
  if (b.format && !['auto', 'csv', 'ofx', 'qif'].includes(b.format)) throw httpError(400, 'format must be auto, csv, ofx or qif', 'bad_option');
  options.format = b.format || 'auto';
  if (b.date_format && !['auto', 'ymd', 'mdy', 'dmy'].includes(b.date_format)) throw httpError(400, 'date_format must be auto, ymd, mdy or dmy', 'bad_option');
  options.dateFormat = b.date_format || 'auto';
  options.invert = b.invert === '1' || b.invert === 'true' || b.invert === true;
  if (b.currency) {
    if (!/^[A-Za-z]{3}$/.test(b.currency)) throw httpError(400, 'currency must be a 3-letter code', 'bad_option');
    options.currency = b.currency.toUpperCase();
  }
  if (b.mapping) {
    let m;
    try {
      m = typeof b.mapping === 'string' ? JSON.parse(b.mapping) : b.mapping;
    } catch {
      throw httpError(400, 'mapping is not valid JSON', 'bad_option');
    }
    const one = (v) => v === null || v === undefined || v === '' ? null : Number(v);
    const many = (v) => (Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v]).map(Number);
    const mapping = { date: one(m.date), description: many(m.description), amount: many(m.amount), debit: one(m.debit), credit: one(m.credit), currency: one(m.currency), id: one(m.id), account: one(m.account) };
    const all = [mapping.date, mapping.debit, mapping.credit, mapping.currency, mapping.id, mapping.account, ...mapping.description, ...mapping.amount].filter((v) => v !== null);
    if (!all.every(isSmallInt)) throw httpError(400, 'mapping must contain column numbers', 'bad_option');
    options.mapping = mapping;
  }
  return options;
}

function defaultCurrency(propertyId) {
  const row = db.prepare('SELECT currency FROM expenses WHERE property_id = ? GROUP BY currency ORDER BY COUNT(*) DESC LIMIT 1').get(propertyId);
  return row?.currency || 'CAD';
}

function parseUpload(req) {
  if (!req.file) throw httpError(400, 'Choose a statement file first.', 'no_file');
  const options = readOptions(req);
  options.currency = options.currency ?? defaultCurrency(req.propertyId);
  return { result: parseStatement(req.file.buffer, options), options };
}

bankRouter.get('/property/:propertyId/transactions', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const status = ['new', 'imported', 'ignored'].includes(req.query.status) ? req.query.status : 'new';
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 500);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  res.json(listTransactions(req.propertyId, { status, q: String(req.query.q ?? '').slice(0, 100), limit, offset }));
});

// What would importing this file do? Nothing is saved.
bankRouter.post(
  '/property/:propertyId/preview',
  requirePropertyAccess({ minRole: 'owner' }),
  statementUpload.single('file'),
  wrap(async (req, res) => {
    let parsed;
    try {
      parsed = parseUpload(req);
    } catch (err) {
      // Columns that could not be identified are not an error to show, but a question to ask.
      if (err.detected && ['no_date_column', 'no_amount_column'].includes(err.code)) {
        return res.json({ needs_mapping: true, format: 'csv', message: err.message, code: err.code, detected: err.detected, count: 0, new_count: 0, duplicate_count: 0, sample: [], warnings: [] });
      }
      throw err;
    }
    const { result, options } = parsed;
    const known = countKnown(req.propertyId, 'file', result.transactions);
    const tx = result.transactions;
    const dates = tx.map((t) => t.posted_date).sort();
    res.json({
      format: result.format,
      count: tx.length,
      new_count: known.filter((k) => !k).length,
      duplicate_count: known.filter(Boolean).length,
      money_out: Math.round(tx.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0) * 100) / 100,
      money_in: Math.round(tx.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      date_from: dates[0],
      date_to: dates[dates.length - 1],
      currency: options.currency,
      sample: tx.slice(0, 15).map((t, i) => ({ posted_date: t.posted_date, amount: t.amount, currency: t.currency || options.currency, description: t.description, duplicate: known[i] })),
      warnings: result.warnings,
      detected: result.detected,
    });
  })
);

bankRouter.post(
  '/property/:propertyId/import',
  requirePropertyAccess({ minRole: 'owner' }),
  statementUpload.single('file'),
  wrap(async (req, res) => {
    const { result, options } = parseUpload(req);
    const batch = crypto.randomBytes(8).toString('hex');
    const counts = importTransactions({ propertyId: req.propertyId, userId: req.user.id, source: 'file', transactions: result.transactions, batch, defaultCurrency: options.currency });
    audit(req, 'bank_imported', { target: String(req.propertyId), detail: { source: 'file', format: result.format, ...counts } });
    res.status(201).json({ batch, ...counts, warnings: result.warnings });
  })
);

bankRouter.delete('/property/:propertyId/batch/:batch', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  if (!/^[0-9a-f]{16}$/.test(req.params.batch)) return res.status(400).json({ error: 'Invalid import' });
  res.json({ removed: undoBatch(req.propertyId, req.params.batch) });
});

bankRouter.post('/property/:propertyId/accept', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const expenseIds = acceptTransactions(req.propertyId, req.user.id, req.body?.items);
  audit(req, 'bank_accepted', { target: String(req.propertyId), detail: { count: expenseIds.length } });
  res.status(201).json({ created: expenseIds.length, expense_ids: expenseIds });
});

bankRouter.post('/property/:propertyId/ignore', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  res.json({ ignored: ignoreTransactions(req.propertyId, req.user.id, req.body?.ids) });
});

bankRouter.post('/property/:propertyId/restore', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  res.json({ restored: restoreTransactions(req.propertyId, req.body?.ids) });
});

bankRouter.get('/property/:propertyId/rules', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  res.json(listRules(req.propertyId));
});

bankRouter.post('/property/:propertyId/rules', requirePropertyAccess({ minRole: 'owner' }), (req, res) => {
  const out = createRule(req.propertyId, req.user.id, req.body ?? {});
  audit(req, 'bank_rule_added', { target: String(out.id) });
  res.status(201).json(out);
});

bankRouter.delete('/rules/:id', withResourceAccess('bank_rules', 'owner'), (req, res) => {
  db.prepare('DELETE FROM bank_rules WHERE id = ?').run(req.resource.id);
  audit(req, 'bank_rule_removed', { target: String(req.resource.id) });
  res.status(204).end();
});
