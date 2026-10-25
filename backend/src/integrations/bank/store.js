import crypto from 'node:crypto';
import { db } from '../../db/index.js';
import { httpError } from '../../utils/http.js';

// The bank inbox: transactions from an imported statement (or a connected bank) wait here until a person
// accepts them into Expenses or ignores them. Re-importing an overlapping statement adds nothing twice,
// and rules can pre-categorize or skip things like groceries that do not belong in a home's books.

export const CATEGORIES = ['maintenance', 'insurance', 'tax', 'utility', 'improvement', 'other'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// Stable identity for each transaction. When the bank gives an id (OFX FITID, SimpleFIN id) that is the
// identity. Otherwise it is date + amount + description, plus "which one of the identical ones this is":
// two coffees for $4.50 on the same day are two transactions, but re-importing the file gives the same two keys.
export function withKeys(transactions, source) {
  const seen = new Map();
  return transactions.map((t) => {
    if (t.external_id) return { ...t, key: sha(`${source}|${t.account ?? ''}|id:${t.external_id}`) };
    const base = `${source}|${t.account ?? ''}|${t.posted_date}|${t.amount.toFixed(2)}|${t.currency ?? ''}|${normalize(t.description)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...t, key: sha(`${base}|#${n}`) };
  });
}

// ---- suggestions -----------------------------------------------------------------------------

// A starting guess only: nothing is ever accepted on the strength of it. First match wins.
const KEYWORDS = [
  ['utility', /hydro|enbridge|energir|gaz m[ée]tro|\bbell\b|vid[ée]otron|telus|rogers|internet|electric(ity)?\b|[ée]lectricit[ée]|\bwater\b|\beau\b|heating oil|mazout|propane/i],
  ['insurance', /insurance|assurance|intact|belair|la capitale|co-?operators|desjardins assurances/i],
  ['tax', /\btax(es)?\b|\btaxes\b|imp[ôo]t|municipal|ville de|city of|revenu qu[ée]bec|\bcra\b|school tax|taxe scolaire/i],
  ['improvement', /renovation|r[ée]novation|contractor|entrepreneur|construction|flooring|plancher|windows?\b|fen[êe]tres?|\bdeck\b|patio|kitchen|cuisine/i],
  ['maintenance', /home depot|\brona\b|r[ée]no-?d[ée]p[ôo]t|canadian tire|lowe'?s|plumb|plomb|hvac|furnace|fournaise|landscap|paysag|snow|d[ée]neig|pest|extermin|locksmith|serrurier|cleaning|m[ée]nage|handyman/i],
];
export function suggestCategory(description) {
  for (const [category, pattern] of KEYWORDS) if (pattern.test(description)) return category;
  return null;
}

export function listRules(propertyId) {
  return db.prepare('SELECT id, pattern, action, category, is_home_office, created_at FROM bank_rules WHERE property_id = ? ORDER BY LENGTH(pattern) DESC, id').all(propertyId);
}

// The most specific (longest) rule whose text appears in the description.
function matchRule(rules, description) {
  const d = description.toLowerCase();
  return rules.find((r) => d.includes(r.pattern.toLowerCase())) ?? null;
}

export function createRule(propertyId, userId, body) {
  const pattern = String(body.pattern ?? '').trim();
  if (pattern.length < 2 || pattern.length > 80) throw httpError(400, 'The text to look for must be between 2 and 80 characters.', 'bad_pattern');
  const action = body.action === 'ignore' ? 'ignore' : 'categorize';
  if (action === 'categorize' && !CATEGORIES.includes(body.category)) throw httpError(400, `category must be one of: ${CATEGORIES.join(', ')}`, 'bad_category');
  if (db.prepare('SELECT COUNT(*) AS c FROM bank_rules WHERE property_id = ?').get(propertyId).c >= 200) throw httpError(409, 'This property already has 200 rules.', 'too_many_rules');
  const existing = db.prepare('SELECT id FROM bank_rules WHERE property_id = ? AND lower(pattern) = lower(?)').get(propertyId, pattern);
  const category = action === 'ignore' ? null : body.category;
  const homeOffice = body.is_home_office ? 1 : 0;
  let id;
  if (existing) {
    db.prepare('UPDATE bank_rules SET action = ?, category = ?, is_home_office = ? WHERE id = ?').run(action, category, homeOffice, existing.id);
    id = existing.id;
  } else {
    id = Number(db.prepare('INSERT INTO bank_rules (property_id, pattern, action, category, is_home_office, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(propertyId, pattern, action, category, homeOffice, userId).lastInsertRowid);
  }
  // Optionally apply to what is already waiting.
  let applied = 0;
  if (body.apply_existing) {
    const rule = db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(id);
    const waiting = db.prepare("SELECT id, description FROM bank_transactions WHERE property_id = ? AND status = 'new'").all(propertyId);
    for (const row of waiting) {
      if (!row.description.toLowerCase().includes(rule.pattern.toLowerCase())) continue;
      if (rule.action === 'ignore') db.prepare("UPDATE bank_transactions SET status = 'ignored', decided_at = datetime('now'), decided_by = ? WHERE id = ?").run(userId, row.id);
      else db.prepare('UPDATE bank_transactions SET suggested_category = ?, suggested_home_office = ? WHERE id = ?').run(rule.category, rule.is_home_office, row.id);
      applied += 1;
    }
  }
  return { id, applied };
}

// ---- importing ----------------------------------------------------------------------------------

// Adds the transactions that are not already known. Returns counts; never throws on duplicates.
export function importTransactions({ propertyId, userId, source, integrationId = null, transactions, batch, defaultCurrency = 'CAD' }) {
  const keyed = withKeys(transactions, source);
  const rules = listRules(propertyId);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO bank_transactions
       (property_id, integration_id, source, account, dedupe_key, posted_date, amount, currency, description, suggested_category, suggested_home_office, status, batch, decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0;
  let ignoredByRule = 0;
  db.transaction(() => {
    for (const t of keyed) {
      const rule = matchRule(rules, t.description);
      const skip = rule?.action === 'ignore';
      const category = skip ? null : rule?.category ?? suggestCategory(t.description);
      const info = insert.run(
        propertyId, integrationId, source, t.account ?? null, t.key, t.posted_date, t.amount, (t.currency || defaultCurrency).toUpperCase(),
        t.description.slice(0, 500), category, rule?.is_home_office ? 1 : 0, skip ? 'ignored' : 'new', batch,
        skip ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, skip ? userId : null
      );
      if (info.changes) {
        added += 1;
        if (skip) ignoredByRule += 1;
      }
    }
  })();
  return { added, duplicates: keyed.length - added, ignored_by_rule: ignoredByRule };
}

// Which of these would be new? (For the preview shown before anything is saved.)
export function countKnown(propertyId, source, transactions) {
  const keys = withKeys(transactions, source).map((t) => t.key);
  const known = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = db.prepare(`SELECT dedupe_key FROM bank_transactions WHERE property_id = ? AND dedupe_key IN (${chunk.map(() => '?').join(',')})`).all(propertyId, ...chunk);
    for (const r of rows) known.add(r.dedupe_key);
  }
  return withKeys(transactions, source).map((t) => known.has(t.key));
}

// ---- deciding -------------------------------------------------------------------------------------

const idList = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
    throw httpError(400, 'ids must be a list of 1 to 500 transaction ids.', 'bad_ids');
  }
  return [...new Set(ids)];
};

// items: [{ id, category, is_home_office?, description? }] -> creates the expenses, all or none.
export function acceptTransactions(propertyId, userId, items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) throw httpError(400, 'Choose 1 to 500 transactions.', 'bad_ids');
  const find = db.prepare("SELECT * FROM bank_transactions WHERE id = ? AND property_id = ? AND status = 'new'");
  const insertExpense = db.prepare(
    'INSERT INTO expenses (property_id, category, is_home_office, amount, currency, expense_date, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const mark = db.prepare("UPDATE bank_transactions SET status = 'imported', expense_id = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?");
  const seen = new Set();
  return db.transaction(() => {
    const expenseIds = [];
    for (const item of items) {
      if (!Number.isInteger(item?.id) || seen.has(item.id)) throw httpError(400, 'Each transaction can be chosen once.', 'bad_ids');
      seen.add(item.id);
      const row = find.get(item.id, propertyId);
      if (!row) throw httpError(404, 'One of the transactions is no longer waiting. Reload the list.', 'not_waiting');
      if (!CATEGORIES.includes(item.category)) throw httpError(400, `Pick a category for every transaction (${CATEGORIES.join(', ')}).`, 'bad_category');
      const description = String(item.description ?? row.description).replace(/\s+/g, ' ').trim().slice(0, 500) || row.description;
      // Money out (negative) is an expense; money in (a refund) becomes a negative expense so totals stay right.
      const amount = Math.round(-row.amount * 100) / 100;
      const info = insertExpense.run(propertyId, item.category, item.is_home_office ? 1 : 0, amount, row.currency, row.posted_date, description, userId);
      mark.run(Number(info.lastInsertRowid), userId, row.id);
      expenseIds.push(Number(info.lastInsertRowid));
    }
    return expenseIds;
  })();
}

export function ignoreTransactions(propertyId, userId, ids) {
  const list = idList(ids);
  const update = db.prepare("UPDATE bank_transactions SET status = 'ignored', decided_at = datetime('now'), decided_by = ? WHERE id = ? AND property_id = ? AND status = 'new'");
  return db.transaction(() => list.reduce((n, id) => n + update.run(userId, id, propertyId).changes, 0))();
}

// Back to the inbox: ignored ones, and accepted ones whose expense has since been deleted.
export function restoreTransactions(propertyId, ids) {
  const list = idList(ids);
  const update = db.prepare(
    "UPDATE bank_transactions SET status = 'new', decided_at = NULL, decided_by = NULL WHERE id = ? AND property_id = ? AND (status = 'ignored' OR (status = 'imported' AND expense_id IS NULL))"
  );
  return db.transaction(() => list.reduce((n, id) => n + update.run(id, propertyId).changes, 0))();
}

export function undoBatch(propertyId, batch) {
  return db.prepare("DELETE FROM bank_transactions WHERE property_id = ? AND batch = ? AND status = 'new'").run(propertyId, batch).changes;
}

export function listTransactions(propertyId, { status = 'new', q = '', limit = 200, offset = 0 } = {}) {
  const where = ['property_id = ?', 'status = ?'];
  const params = [propertyId, status];
  if (q) {
    where.push("description LIKE ? ESCAPE '\\'");
    params.push(`%${String(q).replace(/[\\%_]/g, '\\$&')}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM bank_transactions WHERE ${where.join(' AND ')}`).get(...params).c;
  const items = db
    .prepare(
      `SELECT id, source, account, posted_date, amount, currency, description, suggested_category, suggested_home_office, status, expense_id, batch
       FROM bank_transactions WHERE ${where.join(' AND ')} ORDER BY posted_date DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS c FROM bank_transactions WHERE property_id = ? GROUP BY status').all(propertyId).map((r) => [r.status, r.c]));
  return { items, total, counts: { new: counts.new ?? 0, imported: counts.imported ?? 0, ignored: counts.ignored ?? 0 } };
}
