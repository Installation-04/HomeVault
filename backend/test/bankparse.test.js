import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDateOrder, detectDelimiter, parseAmount, parseDate, parseStatement, readCsv, LIMITS } from '../src/integrations/bank/parse.js';

const brief = (r) => r.transactions.map((t) => `${t.posted_date} ${t.amount.toFixed(2)} ${t.currency ?? '-'} ${t.description}`);

test('amounts: separators, signs, brackets, suffixes, symbols', () => {
  const table = {
    '1,234.56': 1234.56, '1 234,56': 1234.56, '1.234,56': 1234.56, '1,234,567.89': 1234567.89, '12,50': 12.5, '1,234': 1234, '1234': 1234, '0.5': 0.5,
    '-12.34': -12.34, '+12.34': 12.34, '(12.34)': -12.34, '12.34-': -12.34, '-$12.34': -12.34, '$12.34': 12.34, '€ 12,34': 12.34, 'CAD 5.00': 5, '5.00 USD': 5,
    '12.34 DR': -12.34, '12.34DR': -12.34, '12.34 CR': 12.34, "1'234.50": 1234.5, '1 234,56': 1234.56, '−7.25': -7.25,
  };
  for (const [input, expected] of Object.entries(table)) assert.equal(parseAmount(input), expected, `"${input}"`);
  for (const bad of ['', '   ', 'abc', '--5', '1.2.3x', null, undefined, '12/10', '#N/A']) assert.equal(parseAmount(bad), null, `"${bad}"`);
});

test('dates: ISO, compact, US/EU by order, month names in English and French, two-digit years, impossible days', () => {
  assert.equal(parseDate('2026-10-25'), '2026-10-25');
  assert.equal(parseDate('2026/10/25'), '2026-10-25');
  assert.equal(parseDate('20261025'), '2026-10-25');
  assert.equal(parseDate('20261025T101500'), '2026-10-25');
  assert.equal(parseDate('2026-10-25 14:30:00'), '2026-10-25');
  assert.equal(parseDate('10/25/2026', 'mdy'), '2026-10-25');
  assert.equal(parseDate('25/10/2026', 'dmy'), '2026-10-25');
  assert.equal(parseDate('25.10.2026', 'dmy'), '2026-10-25');
  assert.equal(parseDate('10/25/26', 'mdy'), '2026-10-25');
  assert.equal(parseDate('01/02/2026', 'mdy'), '2026-01-02');
  assert.equal(parseDate('01/02/2026', 'dmy'), '2026-02-01');
  assert.equal(parseDate('Oct 25, 2026'), '2026-10-25');
  assert.equal(parseDate('25 Oct 2026'), '2026-10-25');
  assert.equal(parseDate('25-oct-26'), '2026-10-25');
  assert.equal(parseDate('2026 Oct 25'), '2026-10-25');
  assert.equal(parseDate('25 octobre 2026'), '2026-10-25');
  assert.equal(parseDate('3 févr. 2026'), '2026-02-03');
  assert.equal(parseDate('12 août 2026'), '2026-08-12');
  for (const bad of ['', 'not a date', '2026-02-31', '31/04/2026', '13/13/2026', '2026-13-01', '12/2026', null]) assert.equal(parseDate(bad, 'dmy'), null, `"${bad}"`);
});

test('date order is read from the data, and only guessed (and reported) when the data cannot tell', () => {
  assert.deepEqual(detectDateOrder(['25/10/2026', '01/11/2026']), { order: 'dmy', assumed: false });
  assert.deepEqual(detectDateOrder(['10/25/2026', '11/01/2026']), { order: 'mdy', assumed: false });
  assert.deepEqual(detectDateOrder(['2026-10-25', '2026-11-01']), { order: 'ymd', assumed: false });
  assert.deepEqual(detectDateOrder(['01/02/2026', '03/04/2026'], 'dmy'), { order: 'dmy', assumed: true });
  assert.deepEqual(detectDateOrder(['01/02/2026'], 'mdy'), { order: 'mdy', assumed: true });
});

test('CSV reading: quotes, escaped quotes, newlines inside quotes, CRLF, BOM, blank lines, delimiters', () => {
  const text = '﻿Date,Description,Amount\r\n2026-10-01,"Smith, J ""Handyman""",-50.00\r\n\r\n2026-10-02,"Two\nlines",-1.00\r\n';
  assert.deepEqual(readCsv(text), [['Date', 'Description', 'Amount'], ['2026-10-01', 'Smith, J "Handyman"', '-50.00'], ['2026-10-02', 'Two\nlines', '-1.00']]);
  assert.equal(detectDelimiter('a;b;c\n1;2;3\n4;5;6'), ';');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a,b,c\n"1,5";2;3\n4,5,6'), ',');
  assert.equal(detectDelimiter('Date|Desc|Amt\n1|2|3'), '|');
});

test('CSV: a simple English file', () => {
  const r = parseStatement('Date,Description,Amount\n2026-10-01,HYDRO QUEBEC,-182.40\n2026-10-03,Insurance refund,40.00\n', { currency: 'CAD' });
  assert.equal(r.format, 'csv');
  assert.deepEqual(brief(r), ['2026-10-01 -182.40 CAD HYDRO QUEBEC', '2026-10-03 40.00 CAD Insurance refund']);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.detected.header, true);
});

test('CSV: RBC-style (two description columns, CAD$/USD$ amount columns, US dates, extra columns)', () => {
  const text = [
    'Account Type,Account Number,Transaction Date,Cheque Number,Description 1,Description 2,CAD$,USD$',
    'Chequing,12345,10/25/2026,,HYDRO-QUEBEC,Pre-authorized,-182.40,',
    'Chequing,12345,10/26/2026,,AMAZON.COM,US purchase,,-23.10',
    'Chequing,12345,10/27/2026,,Payroll,Deposit,2500.00,',
  ].join('\n');
  const r = parseStatement(text, {});
  assert.deepEqual(brief(r), ['2026-10-25 -182.40 CAD HYDRO-QUEBEC · Pre-authorized', '2026-10-26 -23.10 USD AMAZON.COM · US purchase', '2026-10-27 2500.00 CAD Payroll · Deposit']);
  assert.equal(r.transactions[0].account, '12345');
});

test('CSV: French bank (semicolons, decimal commas, spaces in thousands, DD/MM dates, debit/credit columns)', () => {
  const text = ['Date;Description;Retrait;Dépôt;Solde', '25/10/2026;"HYDRO-QUÉBEC";182,40;;4 817,60', '26/10/2026;Paie;;2 500,00;7 317,60', '27/10/2026;Épicerie;1 234,56;;6 083,04'].join('\r\n');
  const r = parseStatement(text, { currency: 'CAD' });
  assert.deepEqual(brief(r), ['2026-10-25 -182.40 CAD HYDRO-QUÉBEC', '2026-10-26 2500.00 CAD Paie', '2026-10-27 -1234.56 CAD Épicerie']);
  assert.equal(r.detected.dateFormat, 'dmy');
  assert.equal(r.detected.dateAssumed, false);
});

test('CSV: no header row (TD-style: date, description, debit, credit, balance)', () => {
  const text = ['10/25/2026,HYDRO QUEBEC,182.40,,5000.00', '10/26/2026,GROCERY,54.10,,4945.90', '10/27/2026,PAYROLL,,2500.00,7445.90'].join('\n');
  const r = parseStatement(text, {});
  assert.deepEqual(brief(r), ['2026-10-25 -182.40 - HYDRO QUEBEC', '2026-10-26 -54.10 - GROCERY', '2026-10-27 2500.00 - PAYROLL']);
  assert.equal(r.detected.header, false);

  // The same layout when the sample has no credits at all must not mistake the balance for the credit column.
  const noCredits = parseStatement(['10/25/2026,HYDRO,182.40,,5000.00', '10/26/2026,GROCERY,54.10,,4945.90'].join('\n'), {});
  assert.deepEqual(noCredits.transactions.map((t) => t.amount), [-182.4, -54.1]);

  // amount + running balance: both columns filled on every row
  const withBalance = parseStatement(['10/25/2026,HYDRO,-182.40,4817.60', '10/26/2026,PAY,2500.00,7317.60'].join('\n'), {});
  assert.deepEqual(withBalance.transactions.map((t) => t.amount), [-182.4, 2500]);
});

test('CSV: tangerine-style headers, memo joined, bare "Transaction" type column ignored', () => {
  const text = ['Transaction date,Transaction,Name,Memo,Amount', '10/25/2026,OTHER,Hydro-Quebec,Pre-authorized debit,-182.40'].join('\n');
  const r = parseStatement(text, {});
  assert.equal(r.transactions[0].description, 'Hydro-Quebec · Pre-authorized debit');
});

test('CSV: credit-card files where purchases are positive; the all-positive warning and the invert option', () => {
  const text = 'Date,Description,Amount\n2026-10-01,HOME DEPOT,54.20\n2026-10-02,RONA,12.00\n';
  const asIs = parseStatement(text, {});
  assert.ok(asIs.warnings.some((w) => w.code === 'all_positive'));
  const flipped = parseStatement(text, { invert: true });
  assert.deepEqual(flipped.transactions.map((t) => t.amount), [-54.2, -12]);
  assert.ok(!flipped.warnings.some((w) => w.code === 'all_positive'));
});

test('CSV: ambiguous dates are reported, and an explicit order wins', () => {
  const text = 'Date,Description,Amount\n01/02/2026,A,-1.00\n03/04/2026,B,-2.00\n';
  const guessed = parseStatement(text, { localeHint: 'fr' });
  assert.deepEqual(guessed.transactions.map((t) => t.posted_date), ['2026-02-01', '2026-04-03']);
  assert.deepEqual(guessed.warnings.find((w) => w.code === 'date_order_assumed'), { code: 'date_order_assumed', order: 'dmy' });
  const forced = parseStatement(text, { dateFormat: 'mdy' });
  assert.deepEqual(forced.transactions.map((t) => t.posted_date), ['2026-01-02', '2026-03-04']);
  assert.ok(!forced.warnings.some((w) => w.code === 'date_order_assumed'));
});

test('CSV: bad rows are skipped and counted, an explicit column mapping overrides detection', () => {
  const text = 'Date,Description,Amount\n2026-10-01,Fine,-1.00\nnot a date,Broken,-2.00\n2026-10-03,No amount,\n,,\n2026-10-04,Fine too,-4.00\n';
  const r = parseStatement(text, {});
  assert.equal(r.transactions.length, 2);
  assert.deepEqual(r.warnings.find((w) => w.code === 'rows_skipped').count, 2);

  const odd = 'When,What,How much\n2026-10-01,Thing,-9.99\n';
  assert.throws(() => parseStatement(odd, {}), (e) => e.code === 'no_date_column' && e.status === 400);
  // ...and the error carries what a person needs to choose the columns themselves
  try {
    parseStatement(odd, {});
  } catch (e) {
    assert.deepEqual(e.detected.sample_rows[0], ['When', 'What', 'How much']);
    assert.equal(e.detected.width, 3);
    assert.equal(e.detected.header, false);
  }
  const mapped = parseStatement(odd, { mapping: { date: 0, description: [1], amount: [2] } });
  assert.deepEqual(brief(mapped), ['2026-10-01 -9.99 - Thing']);
});

test('OFX 1.x (SGML, no closing tags) and OFX 2 (XML), with FITIDs, names, memos and entities', () => {
  const sgml = [
    'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', '', '<OFX>', '<BANKMSGSRSV1><STMTTRNRS><STMTRS>', '<CURDEF>CAD', '<BANKACCTFROM><BANKID>0001<ACCTID>9876543<ACCTTYPE>CHECKING</BANKACCTFROM>',
    '<BANKTRANLIST>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261025120000[-5:EST]<TRNAMT>-182.40<FITID>2026102501<NAME>HYDRO-QUEBEC<MEMO>Pre-auth &amp; bill</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261026<TRNAMT>2500.00<FITID>2026102602<NAME>PAYROLL</STMTTRN>',
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  ].join('\n');
  const r = parseStatement(sgml, {});
  assert.equal(r.format, 'ofx');
  assert.deepEqual(brief(r), ['2026-10-25 -182.40 CAD HYDRO-QUEBEC · Pre-auth & bill', '2026-10-26 2500.00 CAD PAYROLL']);
  assert.deepEqual(r.transactions.map((t) => [t.external_id, t.account]), [['2026102501', '9876543'], ['2026102602', '9876543']]);

  const xml = '<?xml version="1.0"?><OFX><CCSTMTRS><CURDEF>USD</CURDEF><CCACCTFROM><ACCTID>4111</ACCTID></CCACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>20261001</DTPOSTED><TRNAMT>-12.50</TRNAMT><FITID>a1</FITID><NAME>Coffee</NAME></STMTTRN></BANKTRANLIST></CCSTMTRS></OFX>';
  assert.deepEqual(brief(parseStatement(xml, {})), ['2026-10-01 -12.50 USD Coffee']);
  assert.deepEqual(brief(parseStatement(xml, { invert: true })), ['2026-10-01 12.50 USD Coffee']);
});

test('QIF: apostrophe years, both date orders, payee and memo', () => {
  const us = ['!Type:Bank', 'D10/25\'26', 'T-182.40', 'PHydro-Quebec', 'MBill', '^', 'D10/26/2026', 'T2,500.00', 'PPayroll', '^'].join('\n');
  assert.deepEqual(brief(parseStatement(us, { currency: 'CAD' })), ['2026-10-25 -182.40 CAD Hydro-Quebec · Bill', '2026-10-26 2500.00 CAD Payroll']);
  const eu = ['!Type:CCard', 'D25/10/2026', 'T-10.00', 'PShop', '^', 'D01/11/2026', 'T-5.00', 'PCafe', '^'].join('\r\n');
  const r = parseStatement(eu, {});
  assert.equal(r.format, 'qif');
  assert.deepEqual(r.transactions.map((t) => t.posted_date), ['2026-10-25', '2026-11-01']);
});

test('refuses empty, binary, huge or transaction-less files with a clear reason', () => {
  assert.throws(() => parseStatement('', {}), (e) => e.status === 400 && e.code === 'empty');
  assert.throws(() => parseStatement('   \n  ', {}), (e) => e.code === 'empty');
  assert.throws(() => parseStatement('PK\u0003\u0004\u0000\u0000binary', {}), (e) => e.code === 'binary');
  assert.throws(() => parseStatement('x'.repeat(LIMITS.maxBytes + 1), {}), (e) => e.code === 'too_large');
  assert.throws(() => parseStatement('Date,Description,Amount\n', {}), (e) => e.code === 'no_transactions');
  assert.throws(() => parseStatement('<OFX></OFX>', {}), (e) => e.code === 'no_transactions');
  assert.throws(() => parseStatement('just some prose\nwith lines', {}), (e) => e.status === 400);
});

test('a 20,000-row file parses quickly and is capped there', () => {
  const rows = Array.from({ length: 25000 }, (_, i) => `2026-10-${String((i % 28) + 1).padStart(2, '0')},Shop ${i},-${(i % 90) + 1}.25`);
  const started = Date.now();
  const r = parseStatement(`Date,Description,Amount\n${rows.join('\n')}\n`, {});
  assert.equal(r.transactions.length, LIMITS.maxRows);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
