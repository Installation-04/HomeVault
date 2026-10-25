import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let viewer;
let stranger;
let property;
let other;
let db;

before(async () => {
  t = await startTestServer();
  ({ db } = await import('../src/db/index.js'));
  admin = await t.setupAdmin();
  viewer = await t.createUser(admin.token, 'viewer@example.com');
  stranger = await t.createUser(admin.token, 'stranger@example.com');
  property = await t.createProperty(admin.token, 'Maple House');
  other = await t.createProperty(admin.token, 'Cottage');
  await t.api.post(`/api/properties/${property.id}/share`, { email: 'viewer@example.com', role: 'viewer' }, { token: admin.token });
});
after(async () => {
  await t.close();
});

const CSV1 = [
  'Date,Description,Amount',
  '2026-10-01,HYDRO-QUEBEC,-182.40',
  '2026-10-02,GROCERY STORE,-54.10',
  '2026-10-03,Intact Insurance refund,40.00',
  '2026-10-04,HOME DEPOT #1234,-87.65',
  '2026-10-04,COFFEE SHOP,-4.50',
  '2026-10-04,COFFEE SHOP,-4.50',
].join('\n');

const upload = (path, text, fields = {}, { token = admin.token, name = 'statement.csv' } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  return t.api.call('POST', path, { token, form });
};
const importFile = (text, fields, opts) => upload(`/api/bank/property/${property.id}/import`, text, fields, opts);
const preview = (text, fields, opts) => upload(`/api/bank/property/${property.id}/preview`, text, fields, opts);
const inbox = (status = 'new', extra = '', pid = property.id) => t.api.get(`/api/bank/property/${pid}/transactions?status=${status}${extra}`, { token: admin.token });
const clean = () => {
  db.prepare('DELETE FROM bank_transactions').run();
  db.prepare('DELETE FROM bank_rules').run();
  db.prepare('DELETE FROM expenses').run();
  db.prepare('DELETE FROM audit_log').run();
};

test('only owners can touch any of it', async () => {
  clean();
  const base = `/api/bank/property/${property.id}`;
  assert.equal((await t.api.get(`${base}/transactions`)).status, 401);
  for (const token of [viewer.token, stranger.token]) {
    assert.equal((await t.api.get(`${base}/transactions`, { token })).status, 403);
    assert.equal((await t.api.get(`${base}/rules`, { token })).status, 403);
    assert.equal((await preview(CSV1, {}, { token })).status, 403);
    assert.equal((await importFile(CSV1, {}, { token })).status, 403);
    assert.equal((await t.api.post(`${base}/accept`, { items: [] }, { token })).status, 403);
    assert.equal((await t.api.post(`${base}/ignore`, { ids: [1] }, { token })).status, 403);
    assert.equal((await t.api.post(`${base}/rules`, { pattern: 'x', category: 'other' }, { token })).status, 403);
  }
  assert.equal((await t.api.get(`${base}/transactions`, { token: admin.token })).status, 200);
});

test('preview shows what a file would do and saves nothing', async () => {
  clean();
  const res = await preview(CSV1);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.format, 'csv');
  assert.equal(res.body.count, 6);
  assert.equal(res.body.new_count, 6);
  assert.equal(res.body.duplicate_count, 0);
  assert.equal(res.body.money_out, 333.15);
  assert.equal(res.body.money_in, 40);
  assert.equal(res.body.date_from, '2026-10-01');
  assert.equal(res.body.date_to, '2026-10-04');
  assert.equal(res.body.sample.length, 6);
  assert.deepEqual(res.body.detected.mapping.amount, [2]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bank_transactions').get().c, 0);

  await importFile(CSV1);
  const again = await preview(CSV1);
  assert.equal(again.body.duplicate_count, 6, 'the preview knows what is already in the inbox');
  assert.equal(again.body.new_count, 0);
});

test('importing fills the inbox with suggestions; nothing reaches Expenses', async () => {
  clean();
  const res = await importFile(CSV1);
  assert.equal(res.status, 201);
  assert.equal(res.body.added, 6);
  assert.equal(res.body.duplicates, 0);
  assert.match(res.body.batch, /^[0-9a-f]{16}$/);

  const list = await inbox();
  assert.equal(list.body.total, 6);
  assert.deepEqual(list.body.counts, { new: 6, imported: 0, ignored: 0 });
  const byDesc = Object.fromEntries(list.body.items.map((i) => [i.description, i]));
  assert.equal(byDesc['HYDRO-QUEBEC'].suggested_category, 'utility');
  assert.equal(byDesc['Intact Insurance refund'].suggested_category, 'insurance');
  assert.equal(byDesc['HOME DEPOT #1234'].suggested_category, 'maintenance');
  assert.equal(byDesc['GROCERY STORE'].suggested_category, null, 'no guess for what is not a home expense');
  assert.equal(byDesc['HYDRO-QUEBEC'].currency, 'CAD');
  assert.equal((await t.api.get(`/api/expenses/property/${property.id}`, { token: admin.token })).body.length, 0);
  assert.equal(list.body.items[0].posted_date >= list.body.items[5].posted_date, true, 'newest first');
});

test('duplicates: re-imports and overlapping statements add nothing twice, identical twins both count', async () => {
  clean();
  await importFile(CSV1);
  const same = await importFile(CSV1);
  assert.deepEqual([same.body.added, same.body.duplicates], [0, 6]);
  assert.equal((await inbox()).body.total, 6);

  // the two identical coffees are two transactions, and stay two
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM bank_transactions WHERE description = 'COFFEE SHOP'").get().c, 2);

  // next month's file overlaps by a few days and repeats the day's two coffees plus a third
  const overlap = ['Date,Description,Amount', '2026-10-04,COFFEE SHOP,-4.50', '2026-10-04,COFFEE SHOP,-4.50', '2026-10-04,COFFEE SHOP,-4.50', '2026-10-05,NEW THING,-9.99'].join('\n');
  const second = await importFile(overlap);
  assert.deepEqual([second.body.added, second.body.duplicates], [2, 2], 'the third coffee and the new day are new');

  // a bank-supplied id is the identity: the same FITID is a duplicate even if the wording changed
  const ofx = (name) => `OFXHEADER:100\n<OFX><CURDEF>CAD<ACCTID>77<STMTTRN><DTPOSTED>20261010<TRNAMT>-20.00<FITID>abc1<NAME>${name}</STMTTRN></OFX>`;
  assert.equal((await importFile(ofx('SHOP LTD'), {}, { name: 'a.ofx' })).body.added, 1);
  assert.equal((await importFile(ofx('SHOP LIMITED 0042'), {}, { name: 'b.ofx' })).body.added, 0);
});

test('the same transaction in another property is separate', async () => {
  clean();
  await importFile(CSV1);
  const res = await upload(`/api/bank/property/${other.id}/import`, CSV1);
  assert.equal(res.body.added, 6);
  assert.equal((await inbox('new', '', other.id)).body.total, 6);
});

test('accepting creates expenses (money out positive, a refund negative) and marks the rows', async () => {
  clean();
  await importFile(CSV1, { currency: 'CAD' });
  const rows = (await inbox()).body.items;
  const hydro = rows.find((r) => r.description === 'HYDRO-QUEBEC');
  const refund = rows.find((r) => r.description === 'Intact Insurance refund');

  const res = await t.api.post(`/api/bank/property/${property.id}/accept`, { items: [{ id: hydro.id, category: 'utility', is_home_office: true, description: 'Electricity October' }, { id: refund.id, category: 'insurance' }] }, { token: admin.token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.created, 2);

  const expenses = (await t.api.get(`/api/expenses/property/${property.id}`, { token: admin.token })).body;
  const e1 = expenses.find((e) => e.description === 'Electricity October');
  assert.deepEqual({ amount: e1.amount, category: e1.category, date: e1.expense_date, currency: e1.currency, home: e1.is_home_office }, { amount: 182.4, category: 'utility', date: '2026-10-01', currency: 'CAD', home: 1 });
  const e2 = expenses.find((e) => e.description === 'Intact Insurance refund');
  assert.equal(e2.amount, -40, 'money in is a negative expense so the totals stay right');

  assert.deepEqual((await inbox()).body.counts, { new: 4, imported: 2, ignored: 0 });
  const done = await inbox('imported');
  assert.equal(done.body.items.find((r) => r.id === hydro.id).expense_id, e1.id);

  // already decided
  const again = await t.api.post(`/api/bank/property/${property.id}/accept`, { items: [{ id: hydro.id, category: 'utility' }] }, { token: admin.token });
  assert.equal(again.status, 404);
  assert.equal(again.body.code, 'not_waiting');
});

test('accepting is all or nothing, and validated', async () => {
  clean();
  await importFile(CSV1);
  const [a, b] = (await inbox()).body.items;
  const post = (items) => t.api.post(`/api/bank/property/${property.id}/accept`, { items }, { token: admin.token });
  assert.equal((await post([{ id: a.id, category: 'utility' }, { id: b.id, category: 'nonsense' }])).status, 400);
  assert.equal((await post([{ id: a.id, category: 'utility' }, { id: a.id, category: 'utility' }])).status, 400, 'the same one twice');
  assert.equal((await post([{ id: a.id, category: 'utility' }, { id: 999999, category: 'utility' }])).status, 404);
  assert.equal((await post([])).status, 400);
  assert.equal((await post('x')).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM expenses').get().c, 0, 'a failed batch leaves no expense behind');
  assert.equal((await inbox()).body.counts.new, 6);

  // a transaction of another property cannot be accepted through this one
  const foreign = await upload(`/api/bank/property/${other.id}/import`, 'Date,Description,Amount\n2026-10-09,ELSEWHERE,-1.00');
  assert.equal(foreign.body.added, 1);
  const foreignId = (await inbox('new', '', other.id)).body.items[0].id;
  assert.equal((await post([{ id: foreignId, category: 'other' }])).status, 404);
});

test('ignore and restore, including an accepted transaction whose expense was deleted', async () => {
  clean();
  await importFile(CSV1);
  const rows = (await inbox()).body.items;
  const base = `/api/bank/property/${property.id}`;
  const grocery = rows.find((r) => r.description === 'GROCERY STORE');
  assert.equal((await t.api.post(`${base}/ignore`, { ids: [grocery.id] }, { token: admin.token })).body.ignored, 1);
  assert.deepEqual((await inbox()).body.counts, { new: 5, imported: 0, ignored: 1 });
  assert.equal((await inbox('ignored')).body.items[0].description, 'GROCERY STORE');
  assert.equal((await t.api.post(`${base}/ignore`, { ids: [grocery.id] }, { token: admin.token })).body.ignored, 0, 'already ignored');
  assert.equal((await t.api.post(`${base}/restore`, { ids: [grocery.id] }, { token: admin.token })).body.restored, 1);
  assert.equal((await inbox()).body.counts.new, 6);

  const hydro = rows.find((r) => r.description === 'HYDRO-QUEBEC');
  const accepted = await t.api.post(`${base}/accept`, { items: [{ id: hydro.id, category: 'utility' }] }, { token: admin.token });
  assert.equal((await t.api.post(`${base}/restore`, { ids: [hydro.id] }, { token: admin.token })).body.restored, 0, 'its expense still exists');
  await t.api.del(`/api/expenses/${accepted.body.expense_ids[0]}`, { token: admin.token });
  assert.equal((await t.api.post(`${base}/restore`, { ids: [hydro.id] }, { token: admin.token })).body.restored, 1, 'the expense is gone, so it can be decided again');

  assert.equal((await t.api.post(`${base}/ignore`, { ids: [] }, { token: admin.token })).status, 400);
  assert.equal((await t.api.post(`${base}/ignore`, { ids: ['1; DROP TABLE x'] }, { token: admin.token })).status, 400);
});

test('rules: suggest, skip, longest match wins, apply to what is waiting, delete', async () => {
  clean();
  await importFile(CSV1);
  const base = `/api/bank/property/${property.id}`;
  const post = (body, token = admin.token) => t.api.post(`${base}/rules`, body, { token });

  assert.equal((await post({ pattern: 'x', category: 'other' })).status, 400, 'too short');
  assert.equal((await post({ pattern: 'coffee', category: 'nope' })).status, 400);
  assert.equal((await post({ pattern: 'coffee' })).status, 400, 'a category is needed unless it ignores');

  const skip = await post({ pattern: 'Grocery', action: 'ignore', apply_existing: true });
  assert.equal(skip.status, 201);
  assert.equal(skip.body.applied, 1);
  assert.equal((await inbox('ignored')).body.items[0].description, 'GROCERY STORE');

  await post({ pattern: 'depot', category: 'improvement', apply_existing: true });
  await post({ pattern: 'home depot #1234', category: 'maintenance', apply_existing: true });
  const home = (await inbox()).body.items.find((r) => r.description === 'HOME DEPOT #1234');
  assert.equal(home.suggested_category, 'maintenance', 'the longest matching rule wins');

  // update instead of duplicating
  await post({ pattern: 'DEPOT', category: 'tax' });
  assert.equal((await t.api.get(`${base}/rules`, { token: admin.token })).body.filter((r) => r.pattern.toLowerCase() === 'depot').length, 1);

  // future imports follow the rules
  const next = await importFile('Date,Description,Amount\n2026-11-01,grocery store #2,-20.00\n2026-11-02,Depot something,-5.00');
  assert.equal(next.body.ignored_by_rule, 1);
  const added = (await inbox('new')).body.items.find((r) => r.description === 'Depot something');
  assert.equal(added.suggested_category, 'tax');
  assert.equal((await inbox('ignored')).body.total, 2);

  const rules = (await t.api.get(`${base}/rules`, { token: admin.token })).body;
  assert.equal((await t.api.del(`/api/bank/rules/${rules[0].id}`, { token: viewer.token })).status, 403);
  assert.equal((await t.api.del(`/api/bank/rules/${rules[0].id}`, { token: admin.token })).status, 204);
  assert.equal((await t.api.get(`${base}/rules`, { token: admin.token })).body.length, rules.length - 1);
});

test('searching, paging, and undoing an import', async () => {
  clean();
  const first = await importFile(CSV1);
  const second = await importFile('Date,Description,Amount\n2026-11-01,Later thing,-1.00\n2026-11-02,Another one,-2.00');
  assert.equal((await inbox('new', '&q=coffee')).body.total, 2);
  assert.equal((await inbox('new', '&q=100%25')).body.total, 0, 'wildcards are literal');
  const page1 = await inbox('new', '&limit=3&offset=0');
  const page2 = await inbox('new', '&limit=3&offset=3');
  assert.equal(page1.body.items.length, 3);
  assert.equal(page1.body.total, 8);
  assert.equal(new Set([...page1.body.items, ...page2.body.items].map((r) => r.id)).size, 6, 'pages do not overlap');

  const hydro = (await inbox()).body.items.find((r) => r.description === 'HYDRO-QUEBEC');
  await t.api.post(`/api/bank/property/${property.id}/accept`, { items: [{ id: hydro.id, category: 'utility' }] }, { token: admin.token });
  const undone = await t.api.del(`/api/bank/property/${property.id}/batch/${first.body.batch}`, { token: admin.token });
  assert.equal(undone.body.removed, 5, 'what is still waiting is removed; the accepted one is kept');
  assert.equal((await inbox()).body.total, 2);
  assert.equal((await t.api.del(`/api/bank/property/${property.id}/batch/nope`, { token: admin.token })).status, 400);
  assert.ok(second.body.batch);
});

test('options: date order, inverted signs, explicit columns, currency', async () => {
  clean();
  const text = 'When,What,How much\n01/02/2026,Thing,9.99\n';
  assert.equal((await importFile(text)).status, 400, 'unknown columns are explained');
  const ask = await preview(text);
  assert.equal(ask.status, 200, 'the preview asks the question instead of failing');
  assert.equal(ask.body.needs_mapping, true);
  assert.equal(ask.body.code, 'no_date_column');
  assert.deepEqual(ask.body.detected.sample_rows[1], ['01/02/2026', 'Thing', '9.99']);
  const mapped = await importFile(text, { mapping: { date: 0, description: [1], amount: [2] }, date_format: 'dmy', invert: '1', currency: 'usd' });
  assert.equal(mapped.status, 201, JSON.stringify(mapped.body));
  const row = (await inbox()).body.items[0];
  assert.deepEqual({ date: row.posted_date, amount: row.amount, currency: row.currency }, { date: '2026-02-01', amount: -9.99, currency: 'USD' });
  assert.equal((await importFile(text, { mapping: '{not json' })).status, 400);
  assert.equal((await importFile(text, { mapping: { date: 'x' } })).status, 400);
  assert.equal((await importFile(text, { currency: 'dollars' })).status, 400);
  assert.equal((await importFile(text, { format: 'pdf' })).status, 400);
  assert.equal((await importFile(text, { date_format: 'yyyy' })).status, 400);
});

test('bad uploads are refused with a reason', async () => {
  clean();
  const noFile = await t.api.call('POST', `/api/bank/property/${property.id}/import`, { token: admin.token, form: new FormData() });
  assert.equal(noFile.status, 400);
  assert.equal(noFile.body.code, 'no_file');
  assert.equal((await importFile('')).body.code, 'empty');
  assert.equal((await importFile('PK\u0003\u0004\u0000\u0000zip')).body.code, 'binary');
  assert.equal((await importFile('Date,Description,Amount\n')).body.code, 'no_transactions');
  const big = await importFile('x'.repeat(6 * 1024 * 1024));
  assert.equal(big.status, 413);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bank_transactions').get().c, 0);
});

test('the audit log records imports, accepts and rules without any transaction details', async () => {
  clean();
  await importFile(CSV1);
  const row = (await inbox()).body.items[0];
  await t.api.post(`/api/bank/property/${property.id}/accept`, { items: [{ id: row.id, category: 'other', description: 'SECRET-LOOKING DESCRIPTION' }] }, { token: admin.token });
  const rule = await t.api.post(`/api/bank/property/${property.id}/rules`, { pattern: 'PRIVATE PAYEE', category: 'other' }, { token: admin.token });
  await t.api.del(`/api/bank/rules/${rule.body.id}`, { token: admin.token });
  const rows = db.prepare("SELECT action, target, detail FROM audit_log WHERE action LIKE 'bank_%' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => r.action), ['bank_imported', 'bank_accepted', 'bank_rule_added', 'bank_rule_removed']);
  const all = JSON.stringify(rows);
  for (const secret of ['SECRET-LOOKING', 'PRIVATE PAYEE', 'HYDRO', 'GROCERY', '182.4']) assert.ok(!all.includes(secret), `${secret} must not be in the audit log`);
});

test('deleting a property removes its bank data', async () => {
  clean();
  const doomed = await t.createProperty(admin.token, 'Doomed');
  await upload(`/api/bank/property/${doomed.id}/import`, CSV1);
  await t.api.post(`/api/bank/property/${doomed.id}/rules`, { pattern: 'abc', category: 'other' }, { token: admin.token });
  assert.equal((await t.api.del(`/api/properties/${doomed.id}`, { token: admin.token })).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bank_transactions WHERE property_id = ?').get(doomed.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bank_rules WHERE property_id = ?').get(doomed.id).c, 0);
});
