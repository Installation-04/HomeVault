import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let db;
let admin;
let alice;
let P;

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

before(async () => {
  t = await startTestServer();
  ({ db } = await import('../src/db/index.js'));
  admin = await t.setupAdmin();
  alice = await t.createUser(admin.token, 'alice@example.com');
  P = await t.createProperty(alice.token, 'Dash House');
  const uid = alice.user.id;

  const rem = db.prepare(`INSERT INTO reminders (property_id, title, due_date, created_by) VALUES (?, ?, ?, ?)`);
  rem.run(P.id, 'Overdue thing', day(-3), uid);
  rem.run(P.id, 'Soon thing', day(5), uid);
  rem.run(P.id, 'Far thing', day(90), uid);

  const doc = db.prepare(
    `INSERT INTO documents (property_id, title, category, file_path, file_name, expiry_date, created_by)
     VALUES (?, ?, 'insurance', 'f', 'f', ?, ?)`
  );
  doc.run(P.id, 'Expiring policy', day(10), uid);
  doc.run(P.id, 'Recently expired policy', day(-5), uid);
  doc.run(P.id, 'Long dead policy', day(-400), uid);
  doc.run(P.id, 'Fine policy', day(300), uid);

  const eq = db.prepare(`INSERT INTO equipment (property_id, name, warranty_expiry, created_by) VALUES (?, ?, ?, ?)`);
  eq.run(P.id, 'Washer', day(20), uid);
  eq.run(P.id, 'Dryer', day(500), uid);

  const exp = db.prepare(
    `INSERT INTO expenses (property_id, category, amount, currency, expense_date, created_by) VALUES (?, 'tax', ?, ?, ?, ?)`
  );
  const year = new Date().getFullYear();
  exp.run(P.id, 100, 'CAD', `${year}-01-05`, uid);
  exp.run(P.id, 50.5, 'CAD', `${year}-02-05`, uid);
  exp.run(P.id, 999, 'CAD', `${year - 1}-02-05`, uid);
});
after(() => t.close());

test('dashboard separates overdue from upcoming and surfaces expiring documents and warranties', async () => {
  const res = await t.api.get('/api/dashboard', { token: alice.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  const p = res.body[0];

  assert.deepEqual(p.overdue_reminders.map((r) => r.title), ['Overdue thing']);
  assert.deepEqual(p.upcoming_reminders.map((r) => r.title), ['Soon thing']);
  assert.deepEqual(p.expiring_documents.map((d) => d.title).sort(), ['Expiring policy', 'Recently expired policy']);
  assert.deepEqual(p.expiring_equipment.map((e) => e.name), ['Washer']);
});

test('dashboard counts and year-to-date expenses', async () => {
  const res = await t.api.get('/api/dashboard', { token: alice.token });
  const p = res.body[0];
  assert.equal(p.counts.documents, 4);
  assert.equal(p.counts.equipment, 2);
  assert.equal(p.counts.open_reminders, 3);
  assert.deepEqual(p.expenses_ytd, [{ currency: 'CAD', total: 150.5 }]);
});
