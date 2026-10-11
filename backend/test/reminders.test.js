import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let db;
let runReminderCheck;
let admin;
let alice;
let bob;
let P;

const TODAY = '2026-10-11';

before(async () => {
  t = await startTestServer();
  ({ db } = await import('../src/db/index.js'));
  ({ runReminderCheck } = await import('../src/utils/reminderEngine.js'));
  admin = await t.setupAdmin();
  alice = await t.createUser(admin.token, 'alice@example.com');
  bob = await t.createUser(admin.token, 'bob@example.com');
  P = await t.createProperty(alice.token, 'Maple St');
  await t.api.post(`/api/properties/${P.id}/share`, { email: bob.email, role: 'viewer' }, { token: alice.token });
});
after(() => t.close());

beforeEach(() => {
  db.exec('DELETE FROM reminders; DELETE FROM documents; DELETE FROM equipment;');
});

function recorder({ failFor = [], skipped = false } = {}) {
  const sent = [];
  const send = async (mail) => {
    if (failFor.includes(mail.to)) throw new Error('smtp down for ' + mail.to);
    if (skipped) return { skipped: true };
    sent.push(mail);
    return { accepted: [mail.to] };
  };
  return { sent, send };
}

function addReminder(over = {}) {
  const row = {
    title: 'Change furnace filter',
    due_date: '2026-10-14',
    lead_time_days: 7,
    notify_email: 1,
    recurrence: 'none',
    ...over,
  };
  const info = db
    .prepare(
      `INSERT INTO reminders (property_id, title, due_date, lead_time_days, notify_email, recurrence, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(P.id, row.title, row.due_date, row.lead_time_days, row.notify_email, row.recurrence, alice.user.id);
  return info.lastInsertRowid;
}

test('a reminder inside its lead window is emailed once per member, not again on the next run', async () => {
  addReminder();
  const r1 = recorder();
  await runReminderCheck({ send: r1.send, today: TODAY });
  assert.deepEqual(r1.sent.map((m) => m.to).sort(), ['alice@example.com', 'bob@example.com']);
  assert.ok(r1.sent.every((m) => m.text.includes('Change furnace filter')));
  assert.ok(r1.sent.every((m) => m.subject.includes('Maple St')));

  const r2 = recorder();
  await runReminderCheck({ send: r2.send, today: '2026-10-12' });
  await runReminderCheck({ send: r2.send, today: '2026-10-14' });
  assert.equal(r2.sent.length, 0, 'same due date must not be re-sent every day');
});

test('outside the lead window, or with email notifications off, nothing is sent', async () => {
  addReminder({ title: 'Far away', due_date: '2026-12-25' });
  addReminder({ title: 'Muted', due_date: '2026-10-12', notify_email: 0 });
  addReminder({ title: 'Done', due_date: '2026-10-12' });
  db.prepare("UPDATE reminders SET completed_at = datetime('now') WHERE title = 'Done'").run();
  const r = recorder();
  await runReminderCheck({ send: r.send, today: TODAY });
  assert.equal(r.sent.length, 0);
});

test('overdue reminders are emailed once', async () => {
  addReminder({ title: 'Pay property tax', due_date: '2026-10-01' });
  const r = recorder();
  await runReminderCheck({ send: r.send, today: TODAY });
  assert.equal(r.sent.length, 2);
  await runReminderCheck({ send: r.send, today: '2026-10-12' });
  assert.equal(r.sent.length, 2);
});

test('rolling a recurring reminder forward to a new due date makes it eligible again', async () => {
  const id = addReminder({ recurrence: 'monthly', due_date: '2026-10-14' });
  const r = recorder();
  await runReminderCheck({ send: r.send, today: TODAY });
  assert.equal(r.sent.length, 2);

  // "Complete" rolls the due date a month ahead; a month later it is due again.
  db.prepare("UPDATE reminders SET due_date = '2026-11-14' WHERE id = ?").run(id);
  await runReminderCheck({ send: r.send, today: '2026-11-10' });
  assert.equal(r.sent.length, 4);
});

test('when SMTP is not configured nothing is marked as notified', async () => {
  addReminder();
  const off = recorder({ skipped: true });
  const res = await runReminderCheck({ send: off.send, today: TODAY });
  assert.equal(res.emailsSent, 0);

  // SMTP gets configured later: the pending reminder must still go out.
  const on = recorder();
  await runReminderCheck({ send: on.send, today: TODAY });
  assert.equal(on.sent.length, 2);
});

test('one failing recipient does not stop the others, and the reminder is still marked as sent', async () => {
  addReminder();
  const partial = recorder({ failFor: ['bob@example.com'] });
  await runReminderCheck({ send: partial.send, today: TODAY });
  assert.deepEqual(partial.sent.map((m) => m.to), ['alice@example.com']);

  const again = recorder();
  await runReminderCheck({ send: again.send, today: TODAY });
  assert.equal(again.sent.length, 0);
});

test('if every send fails the reminder is retried on the next run', async () => {
  addReminder();
  const down = recorder({ failFor: ['alice@example.com', 'bob@example.com'] });
  await runReminderCheck({ send: down.send, today: TODAY });
  assert.equal(down.sent.length, 0);

  const up = recorder();
  await runReminderCheck({ send: up.send, today: '2026-10-12' });
  assert.equal(up.sent.length, 2);
});

test('expiring documents and equipment warranties are included once, in a single email per member', async () => {
  const uid = alice.user.id;
  db.prepare(
    `INSERT INTO documents (property_id, title, category, file_path, file_name, expiry_date, created_by)
     VALUES (?, 'Home insurance', 'insurance', 'x', 'x.pdf', '2026-10-25', ?)`
  ).run(P.id, uid);
  db.prepare(
    `INSERT INTO equipment (property_id, name, warranty_expiry, created_by) VALUES (?, 'Dishwasher', '2026-10-20', ?)`
  ).run(P.id, uid);
  // Expired years ago: must not trigger a surprise historic notice.
  db.prepare(
    `INSERT INTO documents (property_id, title, category, file_path, file_name, expiry_date, created_by)
     VALUES (?, 'Ancient lease', 'contract', 'y', 'y.pdf', '2019-01-01', ?)`
  ).run(P.id, uid);
  addReminder();

  const r = recorder();
  await runReminderCheck({ send: r.send, today: TODAY });
  assert.equal(r.sent.length, 2, 'one digest per member, not one email per item');
  const text = r.sent[0].text;
  for (const needle of ['Change furnace filter', 'Home insurance', 'Dishwasher']) {
    assert.ok(text.includes(needle), `digest should mention ${needle}`);
  }
  assert.ok(!text.includes('Ancient lease'));

  await runReminderCheck({ send: r.send, today: '2026-10-13' });
  assert.equal(r.sent.length, 2);
});

test('digests use the recipient\'s locale', async () => {
  db.prepare("UPDATE users SET locale = 'fr' WHERE email = 'bob@example.com'").run();
  addReminder();
  const r = recorder();
  await runReminderCheck({ send: r.send, today: TODAY });
  const forBob = r.sent.find((m) => m.to === 'bob@example.com');
  const forAlice = r.sent.find((m) => m.to === 'alice@example.com');
  assert.match(forBob.subject, /rappel|échéance|HomeVault/i);
  assert.notEqual(forBob.subject, forAlice.subject);
  db.prepare("UPDATE users SET locale = 'en' WHERE email = 'bob@example.com'").run();
});

test('completing a recurring reminder via the API skips missed periods', async () => {
  const id = addReminder({ recurrence: 'monthly', due_date: '2020-01-10' });
  const res = await t.api.post(`/api/reminders/${id}/complete`, {}, { token: alice.token });
  assert.equal(res.status, 200);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(res.body.due_date > today, `expected ${res.body.due_date} to be after ${today}`);
  assert.equal(res.body.due_date.slice(8), '10', 'keeps the original day of month');
  assert.equal(res.body.completed_at, null);
});
