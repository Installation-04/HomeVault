import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startTestServer } from './helpers.js';

// A stand-in calendar server: the test decides what it answers.
let calendarServer;
let calendarHits = 0;
let calendar = { status: 200, type: 'text/calendar', body: '' };
const SECRET_PATH = '/private/abcd1234secrettoken/basic.ics';

let t;
let admin;
let viewer;
let stranger;
let property;
let db;
let service;
let safe;
let ics;

const pad = (n) => String(n).padStart(2, '0');
const dayOffset = (n) => {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};
const iso = (compact) => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
const vcal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'X-WR-CALNAME:Family', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (uid, summary, lines = []) => ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`, ...lines, 'END:VEVENT'];

before(async () => {
  calendarServer = http.createServer((req, res) => {
    calendarHits += 1;
    if (req.url.startsWith('/redirect-private')) {
      res.writeHead(302, { Location: 'http://127.0.0.2:1/secret' });
      return res.end();
    }
    if (req.url.startsWith('/loop')) {
      res.writeHead(302, { Location: '/loop' });
      return res.end();
    }
    if (req.url.startsWith('/big')) {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      return res.end('x'.repeat(3 * 1024 * 1024));
    }
    if (req.url.startsWith('/silent')) return; // never answers
    res.writeHead(calendar.status, { 'Content-Type': calendar.type });
    res.end(calendar.body);
  });
  calendarServer.listen(0, '127.0.0.1');
  await once(calendarServer, 'listening');

  // The test calendar lives on loopback, which the default policy forbids: tests that need to reach it opt in.
  t = await startTestServer({ INTEGRATIONS_ALLOW_PRIVATE_HOSTS: 'true' });
  ({ db } = await import('../src/db/index.js'));
  service = await import('../src/integrations/service.js');
  safe = await import('../src/integrations/safeFetch.js');
  ics = await import('../src/integrations/ics.js');

  admin = await t.setupAdmin();
  viewer = await t.createUser(admin.token, 'viewer@example.com');
  stranger = await t.createUser(admin.token, 'stranger@example.com');
  property = await t.createProperty(admin.token, 'Maple House');
  await t.api.post(`/api/properties/${property.id}/share`, { email: 'viewer@example.com', role: 'viewer' }, { token: admin.token });
});
after(async () => {
  calendarServer.close();
  await t.close();
});

const url = (p = SECRET_PATH) => `http://127.0.0.1:${calendarServer.address().port}${p}`;
const policy = (value) => {
  process.env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS = value;
};
const create = (body = {}, token = admin.token) =>
  t.api.post('/api/integrations', { property_id: property.id, type: 'calendar_ics', name: 'Family', url: url(), timezone: 'America/Toronto', ...body }, { token });
const clean = () => {
  db.prepare('DELETE FROM integrations').run();
  calendar = { status: 200, type: 'text/calendar', body: vcal(vevent('a@x', 'Plumber visit', [`DTSTART;VALUE=DATE:${dayOffset(3)}`])) };
};

// ---------------------------------------------------------------- which addresses may be fetched

test('private, loopback, link-local and reserved addresses are refused; public ones are not', () => {
  for (const bad of ['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'not-an-ip']) {
    assert.equal(safe.isPublicAddress(bad), false, `${bad} must be refused`);
  }
  for (const good of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(safe.isPublicAddress(good), true, `${good} must be allowed`);
  }
});

test('checkUrl: schemes, credentials, odd spellings of loopback, webcal', () => {
  policy('false');
  try {
    for (const bad of ['file:///etc/passwd', 'ftp://example.com/a.ics', 'javascript:alert(1)', 'gopher://x', 'http://user:pw@example.com/a.ics', 'not a url', '']) {
      assert.throws(() => safe.checkUrl(bad), (e) => e.status === 400, bad);
    }
    for (const sneaky of ['http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5:8080/a.ics']) {
      assert.throws(() => safe.checkUrl(sneaky), (e) => e.code === 'private_address', sneaky);
    }
    assert.equal(safe.checkUrl('webcal://calendar.example.com/a.ics').href, 'https://calendar.example.com/a.ics');
    assert.equal(safe.checkUrl('https://calendar.example.com/a.ics?x=1').hostname, 'calendar.example.com');
  } finally {
    policy('true');
  }
});

test('with the default policy a name that resolves to loopback is refused when connecting', async () => {
  policy('false');
  try {
    await assert.rejects(() => safe.safeFetch(`http://localhost:${calendarServer.address().port}/`), (e) => e.code === 'private_address');
    await assert.rejects(() => safe.safeFetch(`http://127.0.0.1:${calendarServer.address().port}/`), (e) => e.code === 'private_address');
  } finally {
    policy('true');
  }
});

test('redirects are re-checked: a hop to a private address is refused, loops and long chains stop', async () => {
  // Policy: only 127.0.0.1 is "public" here, so a redirect to 127.0.0.2 plays the part of an internal host.
  const onlyFirst = (address) => address === '127.0.0.1';
  await assert.rejects(() => safe.safeFetch(url('/redirect-private'), { addressPolicy: onlyFirst }), (e) => e.code === 'private_address');
  await assert.rejects(() => safe.safeFetch(url('/loop'), { maxRedirects: 3 }), (e) => e.code === 'too_many_redirects');
});

test('responses are size- and time-limited', async () => {
  await assert.rejects(() => safe.safeFetch(url('/big'), { maxBytes: 1024 * 1024 }), (e) => e.code === 'too_large');
  const started = Date.now();
  await assert.rejects(() => safe.safeFetch(url('/silent'), { timeoutMs: 300 }), (e) => e.code === 'timeout');
  assert.ok(Date.now() - started < 3000);
  const ok = await safe.safeFetch(url('/anything'));
  assert.equal(ok.status, 200);
});

// ---------------------------------------------------------------- reading calendars

test('parser: recurrence, exceptions, moved instances, all-day spans, time zones', () => {
  const tz = ['BEGIN:VTIMEZONE', 'TZID:America/Toronto', 'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'END:STANDARD', 'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'END:DAYLIGHT', 'END:VTIMEZONE'];
  const text = vcal(
    tz,
    vevent('weekly@x', 'Garbage pickup', ['DTSTART;TZID=America/Toronto:20261026T070000', 'DTEND;TZID=America/Toronto:20261026T073000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6', 'EXDATE;TZID=America/Toronto:20261102T070000']),
    vevent('weekly@x', 'Garbage pickup (moved)', ['RECURRENCE-ID;TZID=America/Toronto:20261109T070000', 'DTSTART;TZID=America/Toronto:20261110T070000', 'DTEND;TZID=America/Toronto:20261110T073000']),
    vevent('trip@x', 'Cottage trip', ['DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261102']),
    vevent('utc@x', 'Call with plumber', ['DTSTART:20261028T150000Z', 'DTEND:20261028T160000Z', 'LOCATION:Phone', 'DESCRIPTION:Bring the quote\\, please']),
    vevent('paris@x', 'Paris, no VTIMEZONE', ['DTSTART;TZID=Europe/Paris:20261029T180000', 'DTEND;TZID=Europe/Paris:20261029T190000']),
    vevent('gone@x', 'Cancelled', ['STATUS:CANCELLED', 'DTSTART;VALUE=DATE:20261029'])
  );
  const { events, name, timezone } = ics.parseCalendar(text, { timezone: 'America/Toronto', from: '2026-10-01', to: '2026-12-31' });
  assert.equal(name, 'Family');
  assert.equal(timezone, 'America/Toronto');
  const flat = events.map((e) => `${e.start_date} ${e.start_time ?? 'all-day'} ${e.title}`);
  assert.deepEqual(flat, [
    '2026-10-26 07:00 Garbage pickup',
    '2026-10-28 11:00 Call with plumber', // 15:00 UTC is 11:00 in Toronto (EDT)
    '2026-10-29 13:00 Paris, no VTIMEZONE', // 18:00 in Paris (CET, UTC+1) is 13:00 in Toronto
    '2026-10-30 all-day Cottage trip',
    '2026-11-10 07:00 Garbage pickup (moved)', // Nov 2 excluded; Nov 9 moved to Nov 10
    '2026-11-16 07:00 Garbage pickup', // still 07:00 after the clocks went back on Nov 1
    '2026-11-23 07:00 Garbage pickup',
    '2026-11-30 07:00 Garbage pickup',
  ]);
  const trip = events.find((e) => e.uid === 'trip@x');
  assert.equal(trip.end_date, '2026-11-01', 'an all-day DTEND is exclusive');
  const call = events.find((e) => e.uid === 'utc@x');
  assert.equal(call.location, 'Phone');
  assert.equal(call.description, 'Bring the quote, please');
});

test('parser: the window limits what is kept, long text is clipped, junk is rejected', () => {
  const text = vcal(
    vevent('old@x', 'Long ago', ['DTSTART;VALUE=DATE:20200101']),
    vevent('soon@x', 'x'.repeat(1000), ['DTSTART;VALUE=DATE:20261101', `DESCRIPTION:${'d'.repeat(5000)}`, 'LOCATION:\u0007bell']),
    vevent('far@x', 'Far future', ['DTSTART;VALUE=DATE:20300101'])
  );
  const { events } = ics.parseCalendar(text, { timezone: 'UTC', from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(events.map((e) => e.uid), ['soon@x']);
  assert.equal(events[0].title.length, ics.LIMITS.maxTitle);
  assert.equal(events[0].description.length, ics.LIMITS.maxDescription);
  assert.equal(events[0].location, 'bell', 'control characters are stripped');

  for (const junk of ['', 'hello', '<html><body>Please log in</body></html>', 'BEGIN:VEVENT\r\nEND:VEVENT']) {
    assert.throws(() => ics.parseCalendar(junk, {}), (e) => e.status === 400 && e.code === 'not_a_calendar');
  }
});

test('parser: a runaway recurrence rule and a huge calendar cannot hang or flood', () => {
  const runaway = vcal(vevent('spin@x', 'Spinning', ['DTSTART:20260101T000000Z', 'RRULE:FREQ=SECONDLY']));
  let started = Date.now();
  const { events } = ics.parseCalendar(runaway, { timezone: 'UTC', from: '2026-01-01', to: '2026-12-31' });
  assert.ok(Date.now() - started < 5000, 'terminates quickly');
  assert.ok(events.length <= ics.LIMITS.maxOccurrencesPerSeries);

  const many = vcal(...Array.from({ length: 6000 }, (_, i) => vevent(`e${i}@x`, `Event ${i}`, [`DTSTART;VALUE=DATE:${dayOffset(1 + (i % 300))}`])));
  started = Date.now();
  const big = ics.parseCalendar(many, { timezone: 'UTC' });
  assert.equal(big.events.length, ics.LIMITS.maxEvents, 'capped');
  assert.ok(Date.now() - started < 10000, `parsed in ${Date.now() - started} ms`);
});

// ---------------------------------------------------------------- the API

test('only owners manage connections; everyone with access can read the events', async () => {
  clean();
  assert.equal((await t.api.get(`/api/integrations/property/${property.id}`)).status, 401);
  assert.equal((await t.api.get(`/api/integrations/property/${property.id}`, { token: viewer.token })).status, 403, 'a viewer cannot even list');
  assert.equal((await t.api.get(`/api/integrations/property/${property.id}`, { token: stranger.token })).status, 403);
  assert.equal((await create({}, viewer.token)).status, 403);
  assert.equal((await create({}, stranger.token)).status, 403);

  const made = await create();
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.status, 'ok');
  assert.equal(made.body.summary.events, 1);
  assert.equal(made.body.source, '127.0.0.1');

  const from = iso(dayOffset(0));
  const to = iso(dayOffset(10));
  const asViewer = await t.api.get(`/api/calendar/property/${property.id}?from=${from}&to=${to}`, { token: viewer.token });
  assert.equal(asViewer.status, 200);
  const ext = asViewer.body.filter((e) => e.type === 'external');
  assert.equal(ext.length, 1);
  assert.equal(ext[0].title, 'Plumber visit');
  assert.equal(ext[0].source, 'Family');
  assert.equal(ext[0].all_day, true);
  assert.equal(ext[0].date, iso(dayOffset(3)));
  assert.equal((await t.api.get(`/api/calendar/property/${property.id}`, { token: stranger.token })).status, 403);
});

test('the secret address is never returned, logged or stored in plain text', async () => {
  clean();
  const made = await create();
  assert.equal(made.status, 201);
  const listed = await t.api.get(`/api/integrations/property/${property.id}`, { token: admin.token });
  for (const body of [made.body, listed.body]) {
    const text = JSON.stringify(body);
    assert.ok(!text.includes('abcd1234secrettoken'), 'the API must not echo the address');
    assert.ok(!text.includes('config'), 'no config field');
  }
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(made.body.id);
  assert.ok(!row.config_enc.includes('abcd1234secrettoken') && !row.config_enc.includes('127.0.0.1'), 'stored encrypted');
  assert.ok(row.config_enc.startsWith('v1:'));
  const logged = db.prepare("SELECT detail FROM audit_log WHERE action = 'integration_created' ORDER BY id DESC LIMIT 1").get();
  assert.ok(!logged.detail.includes('abcd1234secrettoken'), 'the audit log holds no secret');
});

test('a wrong address is reported and nothing is saved', async () => {
  clean();
  calendar = { status: 200, type: 'text/html', body: '<html><body>Please sign in</body></html>' };
  let res = await create();
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'not_a_calendar');

  calendar = { status: 404, type: 'text/plain', body: 'nope' };
  res = await create();
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'not_found');

  calendar = { status: 403, type: 'text/plain', body: 'no' };
  assert.equal((await create()).body.code, 'forbidden');

  assert.equal((await create({ url: 'file:///etc/passwd' })).status, 400);
  assert.equal((await create({ url: 'http://user:pw@127.0.0.1/a.ics' })).status, 400);
  assert.equal((await create({ timezone: 'Mars/Olympus' })).body.code, 'bad_timezone');
  assert.equal((await create({ type: 'nope' })).status, 400);
  assert.equal((await create({ interval_minutes: 1 })).body.code, 'bad_interval');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM integrations').get().c, 0, 'nothing saved');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM external_events').get().c, 0);
});

test('by default the server refuses to be pointed at its own network', async () => {
  clean();
  policy('false');
  try {
    const res = await create();
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'private_address');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM integrations').get().c, 0);
  } finally {
    policy('true');
  }
});

test('sync replaces the events, a failure is recorded without leaking the address, a fix recovers', async () => {
  clean();
  const made = await create();
  const id = made.body.id;
  const countEvents = () => db.prepare('SELECT COUNT(*) AS c FROM external_events WHERE integration_id = ?').get(id).c;
  assert.equal(countEvents(), 1);

  // The source changes: one event removed, two added.
  calendar.body = vcal(vevent('b@x', 'Gutters', [`DTSTART;VALUE=DATE:${dayOffset(5)}`]), vevent('c@x', 'Furnace service', [`DTSTART:${dayOffset(6)}T140000Z`, `DTEND:${dayOffset(6)}T150000Z`]));
  db.prepare("UPDATE integrations SET last_attempt_at = datetime('now', '-1 hour') WHERE id = ?").run(id);
  const synced = await t.api.post(`/api/integrations/${id}/sync`, {}, { token: admin.token });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.summary.events, 2);
  assert.deepEqual(db.prepare('SELECT title FROM external_events WHERE integration_id = ? ORDER BY title').all(id).map((r) => r.title), ['Furnace service', 'Gutters']);

  // Syncing again straight away is refused.
  assert.equal((await t.api.post(`/api/integrations/${id}/sync`, {}, { token: admin.token })).status, 429);
  assert.equal((await t.api.post(`/api/integrations/${id}/sync`, {}, { token: viewer.token })).status, 403);

  // The source goes down: the old events stay, the failure shows, retries back off.
  calendar = { status: 500, type: 'text/plain', body: 'oops' };
  db.prepare("UPDATE integrations SET last_attempt_at = datetime('now', '-1 hour') WHERE id = ?").run(id);
  const failed = await t.api.post(`/api/integrations/${id}/sync`, {}, { token: admin.token });
  assert.equal(failed.status, 400);
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id);
  assert.equal(row.status, 'error');
  assert.equal(row.failures, 1);
  assert.ok(row.last_error && !row.last_error.includes('abcd1234secrettoken') && !row.last_error.includes('127.0.0.1'));
  assert.equal(countEvents(), 2, 'events are kept while the source is unreachable');
  const minutesAhead = Math.round(db.prepare("SELECT (julianday(next_sync_at) - julianday('now')) * 1440 AS m FROM integrations WHERE id = ?").get(id).m);
  assert.ok(minutesAhead >= 100, `backed off to ~${minutesAhead} min`);

  calendar = { status: 200, type: 'text/calendar', body: vcal(vevent('d@x', 'Back again', [`DTSTART;VALUE=DATE:${dayOffset(2)}`])) };
  db.prepare("UPDATE integrations SET last_attempt_at = datetime('now', '-1 hour') WHERE id = ?").run(id);
  const ok = await t.api.post(`/api/integrations/${id}/sync`, {}, { token: admin.token });
  assert.equal(ok.status, 200);
  const healed = db.prepare('SELECT status, failures, last_error FROM integrations WHERE id = ?').get(id);
  assert.deepEqual({ ...healed }, { status: 'ok', failures: 0, last_error: null });
});

test('the scheduler syncs what is due, skips paused ones, backs off failures, and can be switched off', async () => {
  clean();
  const a = (await create({ name: 'A' })).body.id;
  const b = (await create({ name: 'B' })).body.id;
  calendarHits = 0;
  assert.deepEqual(await service.runDueIntegrations(), { ran: 0, failed: 0 }, 'nothing is due yet');
  assert.equal(calendarHits, 0);

  db.prepare("UPDATE integrations SET next_sync_at = datetime('now', '-1 minute')").run();
  const paused = await t.api.patch(`/api/integrations/${b}`, { paused: true }, { token: admin.token });
  assert.equal(paused.body.paused, true);
  assert.deepEqual(await service.runDueIntegrations(), { ran: 1, failed: 0 });
  assert.equal(calendarHits, 1, 'the paused connection is left alone');

  const resumed = await t.api.patch(`/api/integrations/${b}`, { paused: false }, { token: admin.token });
  assert.equal(resumed.body.paused, false);
  calendar = { status: 500, type: 'text/plain', body: '' };
  db.prepare("UPDATE integrations SET next_sync_at = datetime('now', '-1 minute') WHERE id = ?").run(a);
  const result = await service.runDueIntegrations();
  assert.equal(result.failed, 2, 'A is due and B was due on resume');

  process.env.INTEGRATIONS_ENABLED = 'false';
  try {
    db.prepare("UPDATE integrations SET next_sync_at = datetime('now', '-1 minute')").run();
    assert.deepEqual(await service.runDueIntegrations(), { ran: 0, failed: 0 });
    calendar = { status: 200, type: 'text/calendar', body: vcal() };
    const blocked = await create();
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'integrations_disabled');
  } finally {
    delete process.env.INTEGRATIONS_ENABLED;
  }
});

test('rename, interval, delete (events go with it), and the audit trail', async () => {
  clean();
  const id = (await create()).body.id;
  const renamed = await t.api.patch(`/api/integrations/${id}`, { name: 'School calendar', interval_minutes: 120 }, { token: admin.token });
  assert.equal(renamed.body.name, 'School calendar');
  assert.equal(renamed.body.interval_minutes, 120);
  assert.equal((await t.api.patch(`/api/integrations/${id}`, { interval_minutes: 5 }, { token: admin.token })).status, 400);
  assert.equal((await t.api.patch(`/api/integrations/${id}`, { name: '   ' }, { token: admin.token })).status, 400);
  assert.equal((await t.api.patch(`/api/integrations/${id}`, { name: 'x' }, { token: viewer.token })).status, 403);

  assert.equal((await t.api.del(`/api/integrations/${id}`, { token: viewer.token })).status, 403);
  assert.equal((await t.api.del(`/api/integrations/${id}`, { token: admin.token })).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM external_events').get().c, 0, 'its events are removed with it');
  assert.equal((await t.api.del(`/api/integrations/${id}`, { token: admin.token })).status, 404);

  const actions = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'integration_%' ORDER BY id").all().map((r) => r.action);
  assert.ok(actions.includes('integration_created') && actions.includes('integration_removed'));
});

test('multi-day events appear on each day, and the calendar range is respected', async () => {
  clean();
  calendar.body = vcal(vevent('trip@x', 'Cottage', [`DTSTART;VALUE=DATE:${dayOffset(10)}`, `DTEND;VALUE=DATE:${dayOffset(13)}`]), vevent('after@x', 'Later', [`DTSTART;VALUE=DATE:${dayOffset(40)}`]));
  await create();
  const ranged = await t.api.get(`/api/calendar/property/${property.id}?from=${iso(dayOffset(11))}&to=${iso(dayOffset(30))}`, { token: admin.token });
  const ext = ranged.body.filter((e) => e.type === 'external');
  assert.deepEqual(ext.map((e) => [e.date, e.continues]), [[iso(dayOffset(11)), true], [iso(dayOffset(12)), true]], 'days 11 and 12 (the event ran 10 to 12)');
  const all = await t.api.get(`/api/calendar/property/${property.id}`, { token: admin.token });
  assert.equal(all.body.filter((e) => e.type === 'external').length, 4);
});

test('deleting a property removes its connections and events', async () => {
  clean();
  const other = await t.createProperty(admin.token, 'Cottage');
  const res = await t.api.post('/api/integrations', { property_id: other.id, type: 'calendar_ics', name: 'Cottage cal', url: url(), timezone: 'UTC' }, { token: admin.token });
  assert.equal(res.status, 201);
  assert.equal((await t.api.del(`/api/properties/${other.id}`, { token: admin.token })).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM integrations WHERE property_id = ?').get(other.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM external_events WHERE property_id = ?').get(other.id).c, 0);
});
