// Reads bank statement files (CSV, OFX/QFX, QIF) into one shape:
//   { posted_date: 'YYYY-MM-DD', amount: number (negative = money out), currency, description, external_id, account }
// Bank exports differ wildly (column names in two languages, "1 234,56", "(12.34)", DD/MM vs MM/DD,
// credit-card files where purchases are positive), so the CSV reader detects what it can, reports what
// it assumed, and lets the caller override the choices. Nothing here touches the database.

export const LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 20000 };

const isoDate = (y, m, d) => {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const MONTHS = {
  jan: 1, janv: 1, janvier: 1, january: 1, feb: 2, fev: 2, fevr: 2, fevrier: 2, february: 2, mar: 3, mars: 3, march: 3, apr: 4, avr: 4, avril: 4, april: 4,
  may: 5, mai: 5, jun: 6, juin: 6, june: 6, jul: 7, juil: 7, juillet: 7, july: 7, aug: 8, aout: 8, august: 8, sep: 9, sept: 9, september: 9, septembre: 9,
  oct: 10, octobre: 10, october: 10, nov: 11, novembre: 11, november: 11, dec: 12, decembre: 12, december: 12,
};

const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const year4 = (y) => (y < 100 ? 2000 + y : y);

// ---------- amounts -------------------------------------------------------------------------------

// "1,234.56" "1 234,56" "(12.34)" "12.34-" "-$12.34" "CAD 5.00" "12.34 DR" -> number, or null when it isn't one.
export function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(/[  \s]/g, '').trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  const suffix = /(CR|DR)$/i.exec(s);
  if (suffix) {
    if (suffix[1].toUpperCase() === 'DR') negative = true;
    s = s.slice(0, -2);
  }
  s = s.replace(/^[A-Za-z]{3}(?=[-+\d.,$€£])/, '').replace(/[$€£]|[A-Za-z]{3}$/g, '');
  if (/-$/.test(s)) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (/^[-−–]/.test(s)) {
    negative = !negative;
    s = s.slice(1);
  }
  s = s.replace(/^\+/, '');
  if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return null;
  s = s.replace(/'/g, '');

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimal = null;
  if (lastDot >= 0 && lastComma >= 0) decimal = lastDot > lastComma ? '.' : ',';
  else if (lastComma >= 0) decimal = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? ',' : null; // "1,234" is a thousand, "12,50" is a decimal
  else if (lastDot >= 0) decimal = (s.match(/\./g) || []).length === 1 ? '.' : null;
  const digits = decimal ? s.replace(decimal === '.' ? /,/g : /\./g, '').replace(decimal, '.') : s.replace(/[.,]/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return Math.round((negative ? -n : n) * 100) / 100;
}

// ---------- dates ---------------------------------------------------------------------------------

const parts = (s) => String(s ?? '').trim().replace(/T.*$/, '').split(/[\s/.\-,']+/).filter(Boolean);

// order: 'ymd' | 'mdy' | 'dmy'. Month names and ISO shapes are unambiguous and handled whatever the order.
export function parseDate(raw, order = 'mdy') {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})(?:\d{6})?(?!\d)/.exec(s); // 20261025, 20261025T101500, 20261025101500
  if (compact) return isoDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  const p = parts(s);
  if (p.length < 3) return null;
  const named = p.findIndex((x) => MONTHS[strip(x).toLowerCase()] !== undefined);
  if (named >= 0) {
    // "25 Oct 2026", "Oct 25, 2026", "2026 Oct 25", "25-oct-26": the month is spelled out, so only day and year can be told apart.
    const month = MONTHS[strip(p[named]).toLowerCase()];
    const [a, b] = p.filter((_, i) => i !== named).map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    return a > 31 ? isoDate(a, month, b) : isoDate(year4(b), month, a);
  }
  const n = p.slice(0, 3).map(Number);
  if (n.some((x) => !Number.isInteger(x))) return null;
  if (p[0].length === 4 || order === 'ymd') return isoDate(n[0], n[1], n[2]);
  return order === 'dmy' ? isoDate(year4(n[2]), n[1], n[0]) : isoDate(year4(n[2]), n[0], n[1]);
}

// Looks at every numeric-with-slashes date in a column to decide DD/MM vs MM/DD. `assumed` is true when
// the file gives no clue (every date is ambiguous) and `hint` decided.
export function detectDateOrder(values, hint = 'mdy') {
  let first = 0;
  let second = 0;
  let ymd = 0;
  let total = 0;
  for (const v of values) {
    const p = parts(v);
    if (p.length < 3 || p.some((x) => !/^\d+$/.test(x))) continue;
    total += 1;
    if (p[0].length === 4) ymd += 1;
    else {
      if (Number(p[0]) > 12) first += 1;
      if (Number(p[1]) > 12) second += 1;
    }
  }
  if (total && ymd === total) return { order: 'ymd', assumed: false };
  if (first && !second) return { order: 'dmy', assumed: false };
  if (second && !first) return { order: 'mdy', assumed: false };
  return { order: hint, assumed: total > 0 && !first && !second };
}

// ---------- CSV -------------------------------------------------------------------------------------

export function detectDelimiter(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 25).map((l) => l.replace(/"[^"]*"/g, ''));
  let best = { delimiter: ',', score: -1, width: 0 };
  for (const delimiter of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(delimiter).length - 1);
    const common = [...new Set(counts)].map((c) => ({ c, n: counts.filter((x) => x === c).length })).sort((a, b) => b.n - a.n || b.c - a.c)[0];
    if (!common || common.c === 0) continue;
    if (common.n > best.score || (common.n === best.score && common.c > best.width)) best = { delimiter, score: common.n, width: common.c };
  }
  return best.delimiter;
}

// RFC 4180: quoted fields, "" escapes, newlines inside quotes. Returns rows of strings; blank rows dropped.
export function readCsv(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > LIMITS.maxRows + 50) break;
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (h) => strip(h).toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim();

const HEADERS = {
  date: ['transaction date', 'posted date', 'date posted', 'posting date', 'post date', 'trans date', 'booking date', 'date de transaction', 'date d operation', 'date de l operation', 'date de comptabilisation', 'date'],
  description: ['description', 'description 1', 'description 2', 'transaction description', 'details', 'payee', 'merchant', 'name', 'narrative', 'libelle', 'libelle de l operation', 'particulars', 'memo', 'notes'],
  amount: ['amount', 'montant', 'amt', 'transaction amount', 'amount cad', 'montant cad', 'value'],
  debit: ['debit', 'debits', 'withdrawal', 'withdrawals', 'retrait', 'retraits', 'debit amount', 'money out', 'paid out', 'charges', 'montant debit', 'sortie'],
  credit: ['credit', 'credits', 'deposit', 'deposits', 'depot', 'depots', 'credit amount', 'money in', 'paid in', 'montant credit', 'entree'],
  currency: ['currency', 'devise', 'ccy'],
  id: ['transaction id', 'fitid', 'unique id', 'reference number', 'numero de reference', 'numero de transaction', 'reference', 'ref', 'id'],
  account: ['account number', 'account name', 'numero de compte', 'account', 'compte'],
};

// Finds which columns mean what. Returns { header: bool, mapping: { date, description: [..], amount: [..], debit, credit, currency, id, account }, currencyByColumn }.
export function detectColumns(rows) {
  const looksLikeHeader = (row) => row.filter((c) => Object.values(HEADERS).some((list) => list.includes(norm(c)))).length >= 2;
  const header = rows.length > 0 && looksLikeHeader(rows[0]);
  const names = header ? rows[0].map(norm) : [];
  const mapping = { date: null, description: [], amount: [], debit: null, credit: null, currency: null, id: null, account: null };
  const currencyByColumn = {};

  if (header) {
    const firstMatch = (field) => {
      for (const candidate of HEADERS[field]) {
        const i = names.indexOf(candidate);
        if (i >= 0) return i;
      }
      return null;
    };
    mapping.date = firstMatch('date');
    mapping.debit = firstMatch('debit');
    mapping.credit = firstMatch('credit');
    mapping.currency = firstMatch('currency');
    mapping.id = firstMatch('id');
    mapping.account = firstMatch('account');
    names.forEach((n, i) => {
      if (HEADERS.amount.includes(n)) mapping.amount.push(i);
      // RBC-style "CAD$" / "USD$" columns: one per currency, one filled per row.
      else if (/^[a-z]{3}\$$/.test(n)) {
        mapping.amount.push(i);
        currencyByColumn[i] = n.slice(0, 3).toUpperCase();
      }
    });
    const desc = names.map((n, i) => (HEADERS.description.includes(n) ? i : -1)).filter((i) => i >= 0);
    // A bare "transaction" column is usually a type ("DEBIT", "OTHER"), so it is only a last resort.
    mapping.description = desc.length ? desc.slice(0, 3) : names.map((n, i) => (n === 'transaction' ? i : -1)).filter((i) => i >= 0);
    // Banks that give "Debit" and "Credit" columns do not also give an "Amount".
    if (mapping.amount.length && mapping.debit !== null && mapping.credit !== null) mapping.amount = [];
  } else {
    // No header (e.g. TD): guess date, description, then amount or debit/credit from what the data looks like.
    const sample = rows.slice(0, 30);
    const width = Math.max(...sample.map((r) => r.length));
    const idx = Array.from({ length: width }, (_, i) => i);
    const filled = (i) => sample.map((r) => r[i] ?? '').filter((x) => x.trim());
    const dateCol = idx.find((i) => filled(i).length && filled(i).every((v) => parseDate(v, 'mdy') || parseDate(v, 'dmy')));
    const textCol = idx.find((i) => i !== dateCol && filled(i).length && filled(i).some((v) => parseAmount(v) === null));
    mapping.date = dateCol ?? null;
    if (textCol !== undefined) mapping.description = [textCol];
    // Number columns after the description. A column with nothing in the sample (no credits yet) still counts:
    // the usual layout is date, description, debit, credit, balance.
    const numeric = idx.filter((i) => i > (textCol ?? dateCol ?? -1) && filled(i).every((v) => parseAmount(v) !== null));
    if (numeric.length === 1) mapping.amount = [numeric[0]];
    else if (numeric.length >= 2) {
      const both = sample.filter((r) => String(r[numeric[0]] ?? '').trim() && String(r[numeric[1]] ?? '').trim()).length;
      if (both > sample.length / 2) mapping.amount = [numeric[0]]; // amount + running balance
      else {
        mapping.debit = numeric[0];
        mapping.credit = numeric[1];
      }
    }
  }
  return { header, mapping, currencyByColumn, columns: header ? rows[0].map((c, i) => ({ index: i, header: c.trim() })) : null };
}

// ---------- parsing a whole file ------------------------------------------------------------------

function fromCsv(text, options) {
  const warnings = [];
  const rows = readCsv(text);
  if (rows.length === 0) throw badFile('The file is empty.');
  const detected = detectColumns(rows);
  const mapping = { ...detected.mapping, ...(options.mapping || {}) };
  const data = detected.header ? rows.slice(1) : rows;
  // When the columns cannot be told apart, hand back what was found plus the first rows, so the person can choose.
  const needsMapping = (message, code) =>
    Object.assign(badFile(message, code), {
      detected: { header: detected.header, columns: detected.columns, mapping, width: Math.max(...rows.slice(0, 50).map((r) => r.length)), sample_rows: rows.slice(0, 5).map((r) => r.map((c) => c.slice(0, 40))) },
    });
  if (mapping.date === null || mapping.date === undefined) throw needsMapping('Could not find a date column. Choose it from the list.', 'no_date_column');
  const hasAmount = (mapping.amount || []).length > 0 || mapping.debit !== null || mapping.credit !== null;
  if (!hasAmount) throw needsMapping('Could not find an amount column. Choose it (or the debit and credit columns) from the list.', 'no_amount_column');

  const dateValues = data.map((r) => r[mapping.date]).filter(Boolean);
  const order = options.dateFormat && options.dateFormat !== 'auto' ? { order: options.dateFormat, assumed: false } : detectDateOrder(dateValues, options.localeHint === 'fr' ? 'dmy' : 'mdy');
  if (order.assumed) warnings.push({ code: 'date_order_assumed', order: order.order });

  const transactions = [];
  const skipped = [];
  data.forEach((r, i) => {
    if (transactions.length >= LIMITS.maxRows) return;
    const line = i + 1 + (detected.header ? 1 : 0);
    const date = parseDate(r[mapping.date], order.order);
    let amount = null;
    let currency = null;
    for (const col of mapping.amount || []) {
      const v = parseAmount(r[col]);
      if (v !== null) {
        amount = v;
        currency = detected.currencyByColumn[col] ?? null;
        break;
      }
    }
    if (amount === null && (mapping.debit !== null || mapping.credit !== null)) {
      const debit = mapping.debit !== null ? parseAmount(r[mapping.debit]) : null;
      const credit = mapping.credit !== null ? parseAmount(r[mapping.credit]) : null;
      if (debit !== null && debit !== 0) amount = -Math.abs(debit);
      else if (credit !== null && credit !== 0) amount = Math.abs(credit);
      else if (debit === 0 || credit === 0) amount = 0;
    }
    if (!date || amount === null) {
      if (r.some((c) => c.trim())) skipped.push({ line, reason: !date ? 'date' : 'amount' });
      return;
    }
    if (options.invert) amount = -amount;
    const description = [...new Set((mapping.description || []).map((c) => String(r[c] ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' · ');
    const rowCurrency = mapping.currency !== null && mapping.currency !== undefined ? String(r[mapping.currency] ?? '').trim().toUpperCase() : '';
    transactions.push({
      posted_date: date,
      amount,
      currency: /^[A-Z]{3}$/.test(rowCurrency) ? rowCurrency : currency ?? options.currency ?? null,
      description: description || '(no description)',
      external_id: mapping.id !== null && mapping.id !== undefined && String(r[mapping.id] ?? '').trim() ? String(r[mapping.id]).trim() : null,
      account: mapping.account !== null && mapping.account !== undefined && String(r[mapping.account] ?? '').trim() ? String(r[mapping.account]).trim() : null,
    });
  });
  if (skipped.length) warnings.push({ code: 'rows_skipped', count: skipped.length, first: skipped.slice(0, 3) });
  if (transactions.length && transactions.every((t) => t.amount >= 0) && !mapping.credit && !options.invert) warnings.push({ code: 'all_positive' });
  return { format: 'csv', transactions, warnings, detected: { header: detected.header, columns: detected.columns, mapping, width: Math.max(...rows.slice(0, 50).map((r) => r.length)), dateFormat: order.order, dateAssumed: order.assumed } };
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');

function fromOfx(text, options) {
  const tag = (block, name) => {
    const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
    return m ? decode(m[1].trim()) : '';
  };
  const header = text.split(/<STMTTRN>/i)[0];
  const currency = (tag(header, 'CURDEF') || options.currency || '').toUpperCase();
  const account = tag(header, 'ACCTID') || null;
  const transactions = [];
  let skipped = 0;
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const block of blocks) {
    if (transactions.length >= LIMITS.maxRows) break;
    const dt = tag(block, 'DTPOSTED').replace(/\D.*$/, '');
    const date = /^\d{8}/.test(dt) ? isoDate(Number(dt.slice(0, 4)), Number(dt.slice(4, 6)), Number(dt.slice(6, 8))) : null;
    const amount = parseAmount(tag(block, 'TRNAMT'));
    if (!date || amount === null) {
      skipped += 1;
      continue;
    }
    const description = [...new Set([tag(block, 'NAME'), tag(block, 'MEMO')].map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' · ');
    transactions.push({
      posted_date: date,
      amount: options.invert ? -amount : amount,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
      description: description || '(no description)',
      external_id: tag(block, 'FITID') || null,
      account,
    });
  }
  const warnings = skipped ? [{ code: 'rows_skipped', count: skipped, first: [] }] : [];
  return { format: 'ofx', transactions, warnings, detected: { account } };
}

function fromQif(text, options) {
  const records = [];
  let cur = {};
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('!')) continue;
    if (line === '^') {
      if (Object.keys(cur).length) records.push(cur);
      cur = {};
      continue;
    }
    const code = line[0];
    const value = line.slice(1).trim();
    if ('DTUPML'.includes(code) && cur[code] === undefined) cur[code] = value;
  }
  if (Object.keys(cur).length) records.push(cur);

  const dates = records.map((r) => (r.D || '').replace(/'/g, '/').replace(/\s+/g, ''));
  const order = options.dateFormat && options.dateFormat !== 'auto' ? { order: options.dateFormat, assumed: false } : detectDateOrder(dates, options.localeHint === 'fr' ? 'dmy' : 'mdy');
  const warnings = order.assumed ? [{ code: 'date_order_assumed', order: order.order }] : [];
  const transactions = [];
  let skipped = 0;
  for (const r of records) {
    if (transactions.length >= LIMITS.maxRows) break;
    const date = parseDate((r.D || '').replace(/'/g, '/').replace(/\s+/g, ''), order.order);
    const amount = parseAmount(r.T ?? r.U);
    if (!date || amount === null) {
      skipped += 1;
      continue;
    }
    const description = [...new Set([r.P, r.M].map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' · ');
    transactions.push({ posted_date: date, amount: options.invert ? -amount : amount, currency: options.currency ?? null, description: description || '(no description)', external_id: null, account: null });
  }
  if (skipped) warnings.push({ code: 'rows_skipped', count: skipped, first: [] });
  return { format: 'qif', transactions, warnings, detected: { dateFormat: order.order, dateAssumed: order.assumed } };
}

const badFile = (message, code = 'bad_file') => Object.assign(new Error(message), { status: 400, code });

export function detectFormat(text) {
  const head = text.slice(0, 4000);
  if (/<OFX[\s>]|OFXHEADER:/i.test(head) || /<STMTTRN>/i.test(text.slice(0, 200000))) return 'ofx';
  if (/^\s*!Type:/im.test(head)) return 'qif';
  return 'csv';
}

// options: { format: 'auto'|'csv'|'ofx'|'qif', dateFormat: 'auto'|'ymd'|'mdy'|'dmy', mapping, invert, currency, localeHint }
export function parseStatement(input, options = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  if (text.length > LIMITS.maxBytes) throw badFile('That file is too large (limit 5 MB).', 'too_large');
  if (!text.trim()) throw badFile('The file is empty.', 'empty');
  if (text.includes('\u0000')) throw badFile('That looks like a binary file, not a statement. Export as CSV, OFX/QFX or QIF.', 'binary');
  const format = !options.format || options.format === 'auto' ? detectFormat(text) : options.format;
  const result = format === 'ofx' ? fromOfx(text, options) : format === 'qif' ? fromQif(text, options) : fromCsv(text, options);
  if (result.transactions.length === 0) throw badFile('No transactions were found in that file.', 'no_transactions');
  return result;
}
