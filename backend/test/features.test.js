import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let db;
let buildCalendar;
let foldLine;
let admin;
let alice; // owner of P
let bob; // viewer on P, owner of Q
let carol; // no access to anything
let P;
let Q;

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

before(async () => {
  t = await startTestServer();
  // Imported only now: these modules open the database, which must already point at the temp dir.
  ({ db } = await import('../src/db/index.js'));
  ({ buildCalendar, foldLine } = await import('../src/routes/feeds.js'));
  admin = await t.setupAdmin();
  alice = await t.createUser(admin.token, 'alice@example.com');
  bob = await t.createUser(admin.token, 'bob@example.com');
  carol = await t.createUser(admin.token, 'carol@example.com');
  P = await t.createProperty(alice.token, 'Maple House');
  Q = await t.createProperty(bob.token, 'Lake Cottage');
  await t.api.post(`/api/properties/${P.id}/share`, { email: bob.email, role: 'viewer' }, { token: alice.token });
});
after(() => t.close());

// ---- ICS --------------------------------------------------------------------

test('foldLine wraps at 75 octets without splitting multi-byte characters', () => {
  const long = `SUMMARY:${'é'.repeat(80)}`;
  const folded = foldLine(long);
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1);
  for (const [i, line] of lines.entries()) {
    const text = i === 0 ? line : line.slice(1);
    assert.ok(Buffer.byteLength(i === 0 ? line : line) <= 75, `line ${i} is ${Buffer.byteLength(line)} octets`);
    assert.ok(!text.includes('\ufffd'), 'no broken characters');
    if (i > 0) assert.equal(line[0], ' ');
  }
  assert.equal(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join(''), long, 'unfolding restores the original');
  assert.equal(foldLine('short'), 'short');
});

test('buildCalendar escapes text, adds recurrence and alarms, and is well-formed', () => {
  const ics = buildCalendar({
    name: 'HomeVault, test; "x"',
    now: new Date('2026-01-02T03:04:05Z'),
    events: [
      { uid: 'reminder-1', date: '2026-03-15', summary: 'Change filter, then; "test"\nline2', rrule: 'FREQ=MONTHLY', alertDays: 7 },
      { uid: 'doc-2', date: '2026-12-31', summary: 'Expires: Policy' },
    ],
  });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics.replace(/\r\n/g, '')), 'CRLF line endings only');
  assert.match(ics, /X-WR-CALNAME:HomeVault\\, test\\; "x"/);
  assert.match(ics, /SUMMARY:Change filter\\, then\\; "test"\\nline2/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260315/);
  assert.match(ics, /DTEND;VALUE=DATE:20260316/);
  assert.match(ics, /DTSTAMP:20260102T030405Z/);
  assert.match(ics, /RRULE:FREQ=MONTHLY/);
  assert.match(ics, /TRIGGER:-P6DT15H/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 1);
  assert.match(buildCalendar({ name: 'x', events: [{ uid: 'a', date: '2026-01-01', summary: 's', alertDays: 0 }] }), /TRIGGER:PT9H/);
});

test('calendar links: create, list (without the secret), fetch as .ics, revoke', async () => {
  await t.api.post('/api/reminders', { property_id: P.id, title: 'Change furnace filter', due_date: day(5), recurrence: 'custom', recurrence_interval_days: 90, lead_time_days: 3 }, { token: alice.token });
  await t.api.post('/api/tasks', { property_id: P.id, title: 'Call plumber', event_date: day(2) }, { token: alice.token });
  await t.api.post('/api/equipment', { property_id: P.id, name: 'Dishwasher', warranty_expiry: day(40) }, { token: alice.token });
  db.prepare("INSERT INTO documents (property_id, title, category, file_path, file_name, expiry_date, created_by) VALUES (?, 'Home insurance', 'insurance', 'x', 'x', ?, ?)").run(P.id, day(20), alice.user.id);
  const done = await t.api.post('/api/reminders', { property_id: P.id, title: 'Already done', due_date: day(3) }, { token: alice.token });
  await t.api.post(`/api/reminders/${done.body.id}/complete`, {}, { token: alice.token });

  const created = await t.api.post('/api/calendar/feeds', { label: 'My phone', property_id: P.id }, { token: alice.token });
  assert.equal(created.status, 201);
  assert.match(created.body.path, /^\/api\/calendar-feed\/hvcal_[A-Za-z0-9_-]{40,}\.ics$/);

  const list = await t.api.get('/api/calendar/feeds', { token: alice.token });
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].property_name, 'Maple House');
  assert.ok(!JSON.stringify(list.body).includes('hvcal_'), 'the secret is shown exactly once');
  const stored = db.prepare('SELECT token_hash FROM calendar_feeds').get().token_hash;
  assert.ok(!created.body.path.includes(stored) && stored.length === 64, 'only a hash is stored');

  // No cookie needed: this is what Apple/Google Calendar will do.
  const feed = await t.api.call('GET', created.body.path, { raw: true });
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /^text\/calendar/);
  assert.equal(feed.headers.get('referrer-policy'), 'no-referrer');
  const ics = await feed.text();
  assert.match(ics, /SUMMARY:Change furnace filter/);
  assert.match(ics, /RRULE:FREQ=DAILY;INTERVAL=90/);
  assert.match(ics, /SUMMARY:Call plumber/);
  assert.match(ics, /SUMMARY:Expires: Home insurance/);
  assert.match(ics, /SUMMARY:Warranty ends: Dishwasher/);
  assert.ok(!ics.includes('Already done'), 'completed items are left out');
  assert.ok(!ics.includes('[Maple House]'), 'a single-property feed has no prefix');
  assert.ok(db.prepare('SELECT last_used_at FROM calendar_feeds').get().last_used_at);

  assert.equal((await t.api.del(`/api/calendar/feeds/${created.body.id}`, { token: bob.token })).status, 404, "can't revoke someone else's");
  assert.equal((await t.api.del(`/api/calendar/feeds/${created.body.id}`, { token: alice.token })).status, 204);
  assert.equal((await t.api.call('GET', created.body.path, { raw: true })).status, 404, 'a revoked link stops working immediately');
});

test('feeds only expose what the owner can see, and respect access changes', async () => {
  await t.api.post('/api/reminders', { property_id: Q.id, title: 'Bob private dock repair', due_date: day(4) }, { token: bob.token });
  await t.api.post('/api/reminders', { property_id: P.id, title: 'Shared roof check', due_date: day(6) }, { token: alice.token });

  const bobAll = await t.api.post('/api/calendar/feeds', { label: 'Everything' }, { token: bob.token });
  const ics = await (await t.api.call('GET', bobAll.body.path, { raw: true })).text();
  assert.match(ics, /\[Lake Cottage\] Bob private dock repair/);
  assert.match(ics, /\[Maple House\] Shared roof check/);

  const carolFeed = await t.api.post('/api/calendar/feeds', { label: 'Nothing' }, { token: carol.token });
  const carolIcs = await (await t.api.call('GET', carolFeed.body.path, { raw: true })).text();
  assert.ok(!carolIcs.includes('Bob private') && !carolIcs.includes('Shared roof'));
  assert.equal((await t.api.post('/api/calendar/feeds', { label: 'Sneaky', property_id: P.id }, { token: carol.token })).status, 403);

  await t.api.del(`/api/properties/${P.id}/members/${bob.user.id}`, { token: alice.token });
  const after = await (await t.api.call('GET', bobAll.body.path, { raw: true })).text();
  assert.ok(!after.includes('Shared roof check'), 'losing access removes events from existing links');
  assert.match(after, /Bob private dock repair/);

  db.prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?").run(bob.user.id);
  assert.equal((await t.api.call('GET', bobAll.body.path, { raw: true })).status, 404, 'a disabled account\'s links stop working');
  db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(bob.user.id);
  await t.api.post(`/api/properties/${P.id}/share`, { email: bob.email, role: 'viewer' }, { token: alice.token });
});

test('feed URL guessing is rejected without leaking anything', async () => {
  for (const bad of ['hvcal_' + 'a'.repeat(43) + '.ics', 'nope.ics', 'hvcal_short.ics', '..%2F..%2Fetc%2Fpasswd', 'hvcal_' + 'a'.repeat(43)]) {
    const res = await t.api.call('GET', `/api/calendar-feed/${bad}`, { raw: true });
    assert.equal(res.status, 404, bad);
  }
});

test('at most 10 links per person, labels required', async () => {
  const u = await t.createUser(admin.token, 'linky@example.com');
  assert.equal((await t.api.post('/api/calendar/feeds', { label: '   ' }, { token: u.token })).status, 400);
  for (let i = 0; i < 10; i++) assert.equal((await t.api.post('/api/calendar/feeds', { label: `Link ${i}` }, { token: u.token })).status, 201);
  assert.equal((await t.api.post('/api/calendar/feeds', { label: 'One too many' }, { token: u.token })).status, 409);
});

// ---- search -----------------------------------------------------------------

test('search finds records across properties, is access-scoped and wildcard-safe', async () => {
  await t.api.post('/api/equipment', { property_id: P.id, name: 'Water heater', brand: 'Rheem', model_number: 'XE40M06', serial_number: 'SN-ALPHA-991', location: 'Basement' }, { token: alice.token });
  await t.api.post('/api/equipment', { property_id: Q.id, name: 'Dock lights', notes: 'secret-lake-note' }, { token: bob.token });
  db.prepare("INSERT INTO documents (property_id, title, category, file_path, file_name, created_by) VALUES (?, '100% cotton insurance rider', 'insurance', 'x', 'rider.pdf', ?)").run(P.id, alice.user.id);

  const bySerial = await t.api.get('/api/search?q=alpha-991', { token: alice.token });
  assert.equal(bySerial.status, 200);
  assert.deepEqual(bySerial.body.equipment.map((e) => [e.name, e.property_name]), [['Water heater', 'Maple House']]);

  const percent = await t.api.get('/api/search?q=%25', { token: alice.token });
  assert.equal(percent.body.documents.length, 0, '% is literal, not a wildcard (and too short to search)');
  const cotton = await t.api.get(`/api/search?q=${encodeURIComponent('100%')}`, { token: alice.token });
  assert.deepEqual(cotton.body.documents.map((d) => d.title), ['100% cotton insurance rider']);

  const aliceSeesBob = await t.api.get('/api/search?q=secret-lake', { token: alice.token });
  assert.equal(aliceSeesBob.body.equipment.length, 0, "never someone else's property");
  const bobSees = await t.api.get('/api/search?q=secret-lake', { token: bob.token });
  assert.equal(bobSees.body.equipment.length, 1);
  const adminSees = await t.api.get('/api/search?q=secret-lake', { token: admin.token });
  assert.equal(adminSees.body.equipment.length, 1, 'admins can find everything');
  const carolSees = await t.api.get('/api/search?q=maple', { token: carol.token });
  assert.deepEqual(Object.values(carolSees.body).filter(Array.isArray).flat(), []);

  assert.deepEqual((await t.api.get('/api/search?q=a', { token: alice.token })).body.documents, [], 'one letter is not a search');
  assert.equal((await t.api.get('/api/search?q=x', {})).status, 401);
  const injection = await t.api.get(`/api/search?q=${encodeURIComponent("'; DROP TABLE documents; --")}`, { token: alice.token });
  assert.equal(injection.status, 200);
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM documents').get().c >= 1);
});

// ---- inventory & equipment-linked reminders ---------------------------------

test('equipment prices are validated, stored per currency and exported to CSV safely', async () => {
  const bad = await t.api.post('/api/equipment', { property_id: P.id, name: 'Bad', purchase_price: -5 }, { token: alice.token });
  assert.equal(bad.status, 400);
  assert.equal((await t.api.post('/api/equipment', { property_id: P.id, name: 'Bad', purchase_price: 'lots' }, { token: alice.token })).status, 400);
  assert.equal((await t.api.post('/api/equipment', { property_id: P.id, name: 'Bad', purchase_currency: 'DOLLARS' }, { token: alice.token })).status, 400);
  assert.equal((await t.api.post('/api/equipment', { property_id: P.id, name: 'Bad', category: 'spaceship' }, { token: alice.token })).status, 400);

  const tv = await t.api.post('/api/equipment', { property_id: P.id, name: '=cmd|"/c calc"!A1', brand: 'Sony', purchase_price: 1299.99, purchase_currency: 'usd', serial_number: 'S/N 1,2"3', purchase_date: '2025-11-28' }, { token: alice.token });
  assert.equal(tv.status, 201);
  assert.equal(tv.body.purchase_price, 1299.99);
  assert.equal(tv.body.purchase_currency, 'USD');
  const free = await t.api.post('/api/equipment', { property_id: P.id, name: 'Gift lamp', purchase_price: 0 }, { token: alice.token });
  assert.equal(free.body.purchase_price, 0, 'a price of zero is kept, not turned into "unknown"');

  const upd = await t.api.put(`/api/equipment/${tv.body.id}`, { purchase_price: '' }, { token: alice.token });
  assert.equal(upd.body.purchase_price, null, 'clearing the price works');
  await t.api.put(`/api/equipment/${tv.body.id}`, { purchase_price: 1299.99 }, { token: alice.token });

  assert.equal((await t.api.get(`/api/equipment/property/${P.id}/export.csv`, { token: carol.token })).status, 403);
  assert.equal((await t.api.get(`/api/equipment/property/${P.id}/export.csv`)).status, 401);
  const res = await t.api.call('GET', `/api/equipment/property/${P.id}/export.csv`, { token: alice.token, raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /inventory-\d+\.csv/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = bytes.toString('utf8');
  assert.match(csv, /^\uFEFFname,category,brand,model_number,serial_number,location,purchase_date,purchase_price,currency,warranty_expiry,notes\r\n/);
  assert.ok(csv.includes(`"'=cmd|""/c calc""!A1"`), 'formula injection is neutralised');
  assert.ok(csv.includes('"1299.99","USD"'));
  assert.ok(csv.includes('"S/N 1,2""3"'), 'commas and quotes are escaped');
  assert.ok(csv.includes('"Gift lamp","other","","","","","","0","CAD"'));
});

test('reminders can be tied to a piece of equipment (same property only) and show up on its page', async () => {
  const furnace = await t.api.post('/api/equipment', { property_id: P.id, name: 'Furnace', category: 'hvac' }, { token: alice.token });
  const foreign = await t.api.post('/api/equipment', { property_id: Q.id, name: 'Dock motor' }, { token: bob.token });

  const ok = await t.api.post('/api/reminders', { property_id: P.id, title: 'Replace furnace filter', due_date: day(30), recurrence: 'custom', recurrence_interval_days: 90, equipment_id: furnace.body.id }, { token: alice.token });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.equipment_id, furnace.body.id);
  const cross = await t.api.post('/api/reminders', { property_id: P.id, title: 'Nope', due_date: day(30), equipment_id: foreign.body.id }, { token: alice.token });
  assert.equal(cross.status, 400);

  const list = await t.api.get(`/api/reminders/property/${P.id}`, { token: alice.token });
  assert.equal(list.body.find((r) => r.id === ok.body.id).equipment_name, 'Furnace');

  const detail = await t.api.get(`/api/equipment/${furnace.body.id}`, { token: alice.token });
  assert.deepEqual(detail.body.reminders.map((r) => r.title), ['Replace furnace filter']);

  const unlink = await t.api.put(`/api/reminders/${ok.body.id}`, { equipment_id: '' }, { token: alice.token });
  assert.equal(unlink.body.equipment_id, null);
  await t.api.put(`/api/reminders/${ok.body.id}`, { equipment_id: furnace.body.id }, { token: alice.token });
  assert.equal((await t.api.del(`/api/equipment/${furnace.body.id}`, { token: alice.token })).status, 204);
  const afterDelete = await t.api.get(`/api/reminders/property/${P.id}`, { token: alice.token });
  const survivor = afterDelete.body.find((r) => r.id === ok.body.id);
  assert.ok(survivor, 'deleting the equipment keeps the reminder');
  assert.equal(survivor.equipment_id, null);
});
