import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestServer } from './helpers.js';

let t;
let db;
let admin;
let P;

before(async () => {
  t = await startTestServer();
  ({ db } = await import('../src/db/index.js'));
  admin = await t.setupAdmin();
  P = await t.createProperty(admin.token, 'Robust House');
});
after(() => t.close());

test('malformed JSON and unknown API routes return JSON errors, not HTML', async () => {
  const bad = await t.api.call('POST', '/api/properties', {
    token: admin.token,
    headers: { 'Content-Type': 'application/json' },
    form: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error);

  const missing = await t.api.get('/api/nope', { token: admin.token });
  assert.equal(missing.status, 404);
  assert.ok(missing.body.error);
});

test('responses carry basic security headers and do not advertise express', async () => {
  const res = await t.api.get('/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('unknown or non-numeric ids are 404, not 500', async () => {
  for (const p of ['/api/equipment/9999', '/api/equipment/abc', '/api/documents/9999', '/api/documents/abc']) {
    const res = await t.api.get(p, { token: admin.token });
    assert.equal(res.status, 404, p);
  }
});

test('maintenance log keeps a cost of 0 and validates required fields', async () => {
  const eq = await t.api.post('/api/equipment', { property_id: P.id, name: 'Boiler' }, { token: admin.token });
  const free = await t.api.post(
    `/api/equipment/${eq.body.id}/maintenance`,
    { log_date: '2026-10-01', description: 'Warranty service', cost: 0 },
    { token: admin.token }
  );
  assert.equal(free.status, 201);
  assert.equal(free.body.cost, 0);

  const bad = await t.api.post(`/api/equipment/${eq.body.id}/maintenance`, { description: 'no date' }, { token: admin.token });
  assert.equal(bad.status, 400);
});

test('document search treats % and _ literally', async () => {
  const insert = db.prepare(
    `INSERT INTO documents (property_id, title, category, file_path, file_name, created_by) VALUES (?, ?, 'other', 'f', 'f', 1)`
  );
  insert.run(P.id, '100% cotton warranty');
  insert.run(P.id, 'Roof invoice');
  const res = await t.api.get(`/api/documents/property/${P.id}?q=%25`, { token: admin.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((d) => d.title), ['100% cotton warranty']);
});

test('expense creation validates the amount', async () => {
  const bad = await t.api.post('/api/expenses', { property_id: P.id, category: 'tax', amount: 'abc', expense_date: '2026-01-01' }, { token: admin.token });
  assert.equal(bad.status, 400);
  const ok = await t.api.post('/api/expenses', { property_id: P.id, category: 'tax', amount: 0, expense_date: '2026-01-01' }, { token: admin.token });
  assert.equal(ok.status, 201);
});

test('export bundle: unicode/quoted property names yield a valid header; missing files do not break the zip', async () => {
  const fancy = await t.createProperty(admin.token, 'Résidence "Les Pins"\r\nX-Evil: 1');
  const up = await t.api.call('POST', '/api/documents', {
    token: admin.token,
    form: t.uploadForm({ property_id: String(fancy.id), title: 'Gone soon' }, 'gone.txt', 'bye'),
  });
  assert.equal(up.status, 201);
  const kept = await t.api.call('POST', '/api/documents', {
    token: admin.token,
    form: t.uploadForm({ property_id: String(fancy.id), title: 'Kept' }, 'kept.txt', 'still here'),
  });
  // Simulate a file lost from the volume.
  fs.unlinkSync(db.prepare('SELECT file_path FROM documents WHERE id = ?').get(up.body.id).file_path);

  const res = await t.api.call('GET', `/api/export/property/${fancy.id}/bundle.zip`, { token: admin.token, raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /^attachment;/);
  assert.match(disposition, /filename\*=UTF-8''homevault-R%C3%A9sidence/);
  assert.ok(disposition.includes('%0D%0A'), 'CR/LF from the name must be percent-encoded, never emitted raw');
  assert.ok(!/[\r\n]/.test(disposition), 'header injection via property name');

  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.ok(buf.includes('summary.txt'));
  assert.ok(buf.includes(`documents/${kept.body.id}-kept.txt`));
  assert.ok(!buf.includes(`documents/${up.body.id}-gone.txt`));
});

test('export bundle for an unknown property is a 404 for admins', async () => {
  const res = await t.api.get('/api/export/property/99999/bundle.zip', { token: admin.token });
  assert.equal(res.status, 404);
});

test('expense CSV export works with ?token=, is guarded against spreadsheet formulas and keeps negative amounts', async () => {
  await t.api.post(
    '/api/expenses',
    { property_id: P.id, category: 'maintenance', amount: -25, expense_date: '2026-03-01', description: '=HYPERLINK("http://evil.example","x")' },
    { token: admin.token }
  );
  await t.api.post(
    '/api/expenses',
    { property_id: P.id, category: 'tax', amount: 12.5, expense_date: '2026-04-01', description: 'Café "bio"' },
    { token: admin.token }
  );

  const anon = await t.api.call('GET', `/api/expenses/property/${P.id}/export.csv?year=2026`, { raw: true });
  assert.equal(anon.status, 401);

  const res = await t.api.call('GET', `/api/expenses/property/${P.id}/export.csv?year=2026&token=${admin.token}`, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /expenses-\d+-2026\.csv/);
  // fetch's text() strips a leading BOM, so inspect the raw bytes.
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM so Excel detects UTF-8');
  const text = bytes.toString('utf8');
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil.example"",""x"")"`), text);
  assert.ok(text.includes('"-25"'), 'a refund amount must not be altered');
  assert.ok(text.includes('"Café ""bio"""'));
});

test('reminders: email notifications default to on, custom recurrence needs an interval, fields can be cleared', async () => {
  const created = await t.api.post('/api/reminders', { property_id: P.id, title: 'Clean gutters', due_date: '2026-11-01' }, { token: admin.token });
  assert.equal(created.status, 201);
  assert.equal(created.body.notify_email, 1, 'the UI never sends notify_email, so omitting it must mean "on"');
  assert.equal(created.body.lead_time_days, 7);
  assert.equal(created.body.category, 'maintenance');

  const muted = await t.api.post('/api/reminders', { property_id: P.id, title: 'Muted', due_date: '2026-11-01', notify_email: false }, { token: admin.token });
  assert.equal(muted.body.notify_email, 0);

  const noInterval = await t.api.post(
    '/api/reminders',
    { property_id: P.id, title: 'Custom', due_date: '2026-11-01', recurrence: 'custom' },
    { token: admin.token }
  );
  assert.equal(noInterval.status, 400);
  const badDate = await t.api.post('/api/reminders', { property_id: P.id, title: 'x', due_date: '2026-02-31' }, { token: admin.token });
  assert.equal(badDate.status, 400);

  const withNotes = await t.api.put(`/api/reminders/${created.body.id}`, { notes: 'use the ladder' }, { token: admin.token });
  assert.equal(withNotes.body.notes, 'use the ladder');
  const cleared = await t.api.put(`/api/reminders/${created.body.id}`, { notes: '' }, { token: admin.token });
  assert.equal(cleared.body.notes, null);
  assert.equal(cleared.body.title, 'Clean gutters', 'omitted fields are left alone');

  const done = await t.api.post(`/api/reminders/${created.body.id}/complete`, {}, { token: admin.token });
  assert.ok(done.body.completed_at);
  const reopened = await t.api.post(`/api/reminders/${created.body.id}/reopen`, {}, { token: admin.token });
  assert.equal(reopened.body.completed_at, null);
});

test('documents: editing can clear optional fields and link equipment from the same property only', async () => {
  const up = await t.api.call('POST', '/api/documents', {
    token: admin.token,
    form: t.uploadForm({ property_id: String(P.id), title: 'Manual', expiry_date: '2030-01-01', tags: 'a,b' }, 'manual.txt'),
  });
  assert.equal(up.status, 201);
  const eq = await t.api.post('/api/equipment', { property_id: P.id, name: 'Oven' }, { token: admin.token });
  const other = await t.createProperty(admin.token, 'Elsewhere');
  const foreign = await t.api.post('/api/equipment', { property_id: other.id, name: 'Foreign oven' }, { token: admin.token });

  const linked = await t.api.put(`/api/documents/${up.body.id}`, { equipment_id: eq.body.id, expiry_date: '' }, { token: admin.token });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.equipment_id, eq.body.id);
  assert.equal(linked.body.equipment_name, 'Oven');
  assert.equal(linked.body.expiry_date, null);
  assert.equal(linked.body.tags, 'a,b');

  const bad = await t.api.put(`/api/documents/${up.body.id}`, { equipment_id: foreign.body.id }, { token: admin.token });
  assert.equal(bad.status, 400);
  const badCategory = await t.api.put(`/api/documents/${up.body.id}`, { category: 'nonsense' }, { token: admin.token });
  assert.equal(badCategory.status, 400);
});
