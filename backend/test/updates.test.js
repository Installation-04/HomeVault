import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { startTestServer } from './helpers.js';
import { totpAt } from '../src/utils/totp.js';

// A stand-in for api.github.com: the test decides what "the newest release" is.
let github;
let githubHits = 0;
let release = {};
let githubStatus = 200;

let t;
let admin;
let member;
let updateDir;
let utils;

const goodRelease = (tag, extra = {}) => ({
  tag_name: tag,
  name: `HomeVault ${tag}`,
  body: 'Fixes and improvements.',
  html_url: `https://github.com/example/homevault/releases/tag/${tag}`,
  published_at: '2026-10-24T12:00:00Z',
  draft: false,
  prerelease: false,
  ...extra,
});

before(async () => {
  github = http.createServer((req, res) => {
    githubHits += 1;
    res.writeHead(githubStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(release));
  });
  github.listen(0, '127.0.0.1');
  await once(github, 'listening');

  t = await startTestServer({
    HOMEVAULT_VERSION: 'v1.0.0',
    UPDATE_REPO: 'example/homevault',
    UPDATE_API_BASE: `http://127.0.0.1:${github.address().port}`,
  });
  utils = await import('../src/utils/updates.js');
  updateDir = utils.updateDir();
  admin = await t.setupAdmin();
  member = await t.createUser(admin.token, 'member@example.com');
});
after(async () => {
  github.close();
  await t.close();
});

const reset = () => {
  utils.resetUpdateCache();
  githubHits = 0;
  githubStatus = 200;
  fs.rmSync(updateDir, { recursive: true, force: true });
  utils.ensureUpdateDir();
};
const heartbeat = () => fs.writeFileSync(path.join(updateDir, 'heartbeat'), '1.0.0');
const summary = (opts) => t.api.get(`/api/admin/update${opts || ''}`, { token: admin.token });
const apply = (body = { current_password: admin.password }) => t.api.post('/api/admin/update/apply', body, { token: admin.token });

test('only administrators can see or start updates', async () => {
  reset();
  assert.equal((await t.api.call('GET', '/api/admin/update')).status, 401);
  assert.equal((await t.api.get('/api/admin/update', { token: member.token })).status, 403);
  assert.equal((await t.api.post('/api/admin/update/apply', { current_password: member.password }, { token: member.token })).status, 403);
  assert.equal((await t.api.call('POST', '/api/admin/update/apply', { json: {} })).status, 401);
});

test('any signed-in person can see which version is running, nobody else can', async () => {
  assert.deepEqual((await t.api.get('/api/about', { token: member.token })).body, { version: '1.0.0' });
  assert.equal((await t.api.call('GET', '/api/about')).status, 401);
  assert.equal((await t.api.call('GET', '/api/health')).body.version, undefined, 'the public health endpoint must not reveal the version');
});

test('a newer release is offered, with its notes and link', async () => {
  reset();
  release = goodRelease('v1.2.0', { body: 'Added things.\n\nFixed things.' });
  const { status, body } = await summary();
  assert.equal(status, 200);
  assert.equal(body.current, '1.0.0');
  assert.equal(body.update_available, true);
  assert.equal(body.latest.version, '1.2.0');
  assert.equal(body.latest.tag, 'v1.2.0');
  assert.match(body.latest.notes, /Fixed things/);
  assert.equal(body.latest.url, 'https://github.com/example/homevault/releases/tag/v1.2.0');
  assert.equal(body.check_error, null);
});

test('the same or an older release is not an update; versions compare numerically, not as text', async () => {
  for (const [tag, available] of [['v1.0.0', false], ['v0.9.9', false], ['v1.0.1', true], ['v1.10.0', true], ['v2.0.0', true]]) {
    reset();
    release = goodRelease(tag);
    assert.equal((await summary()).body.update_available, available, tag);
  }
});

test('releases that are drafts, pre-releases or not versioned are ignored', async () => {
  for (const bad of [goodRelease('v2.0.0', { prerelease: true }), goodRelease('v2.0.0', { draft: true }), goodRelease('nightly'), goodRelease('v2.0'), goodRelease('v2.0.0-rc1'), goodRelease('v2.0.0; rm -rf /')]) {
    reset();
    release = bad;
    const { body } = await summary();
    assert.equal(body.update_available, false, JSON.stringify(bad.tag_name));
    assert.equal(body.latest, null);
    assert.ok(body.check_error);
  }
});

test('a link that does not point at github.com is dropped; very long notes are cut', async () => {
  reset();
  release = goodRelease('v1.1.0', { html_url: 'https://evil.example/phish', body: 'x'.repeat(20000), name: 'n'.repeat(500) });
  const { body } = await summary();
  assert.equal(body.latest.url, null);
  assert.equal(body.latest.notes.length, 5000);
  assert.equal(body.latest.name.length, 120);
});

test('answers are cached, a forced refresh is rate limited, and a failing GitHub keeps the last good answer', async () => {
  reset();
  release = goodRelease('v1.1.0');
  await summary();
  await summary();
  assert.equal(githubHits, 1, 'the second call must come from the cache');
  await summary('?refresh=1');
  assert.equal(githubHits, 1, 'a refresh right after a check is not repeated');

  // Pretend the last check was a while ago, then make GitHub fail.
  utils.resetUpdateCache();
  await summary();
  githubStatus = 500;
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    const { body } = await summary('?refresh=1');
    assert.equal(githubHits, 3, 'a refresh after the minimum wait asks GitHub again');
    assert.equal(body.latest.version, '1.1.0', 'the known update must stay visible');
    assert.match(body.check_error, /HTTP 500/);
  } finally {
    Date.now = realNow;
  }
});

test('no release yet and an unreachable GitHub are reported, not raised', async () => {
  reset();
  githubStatus = 404;
  let { body } = await summary();
  assert.equal(body.update_available, false);
  assert.match(body.check_error, /No release/);

  reset();
  const closed = http.createServer().listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = closed.address().port;
  closed.close();
  const saved = process.env.UPDATE_API_BASE;
  process.env.UPDATE_API_BASE = `http://127.0.0.1:${port}`;
  try {
    ({ body } = await summary());
    assert.equal(body.update_available, false);
    assert.match(body.check_error, /Could not reach GitHub/);
  } finally {
    process.env.UPDATE_API_BASE = saved;
  }
});

test('applying needs the password, a running updater and a newer release', async () => {
  reset();
  release = goodRelease('v1.1.0');

  assert.equal((await apply({})).status, 400, 'no password');
  assert.equal((await apply({ current_password: 'wrong-password-123' })).status, 400, 'wrong password');

  let res = await apply();
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'updater_unavailable');
  assert.equal(fs.existsSync(path.join(updateDir, 'request.json')), false);

  heartbeat();
  release = goodRelease('v1.0.0');
  utils.resetUpdateCache();
  res = await apply();
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'up_to_date');
});

test('a confirmed update writes a small request, is audited, and cannot be started twice', async () => {
  reset();
  release = goodRelease('v1.1.0');
  heartbeat();
  const res = await apply();
  assert.equal(res.status, 202);
  assert.deepEqual([res.body.from, res.body.to], ['1.0.0', '1.1.0']);

  const request = JSON.parse(fs.readFileSync(path.join(updateDir, 'request.json'), 'utf8'));
  assert.equal(request.target, 'v1.1.0');
  assert.equal(request.id, res.body.id);
  assert.equal(request.requested_by, admin.email);
  assert.deepEqual(Object.keys(request).sort(), ['id', 'requested_at', 'requested_by', 'target'], 'nothing else goes into the request');
  const raw = fs.readFileSync(path.join(updateDir, 'request.json'), 'utf8');
  assert.ok(!raw.includes(admin.password), 'the password must never be written to disk');

  const events = (await t.api.get('/api/admin/audit?action=update_requested', { token: admin.token })).body.events;
  assert.equal(events.length >= 1, true);
  assert.match(events[0].detail, /"to":"1\.1\.0"/);
  assert.ok(!JSON.stringify(events).includes(admin.password));

  const again = await apply();
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'update_in_progress');
  assert.equal((await summary()).body.in_progress, true);
});

test('a request nobody picked up for a long while no longer blocks a new one', async () => {
  reset();
  release = goodRelease('v1.1.0');
  heartbeat();
  fs.writeFileSync(path.join(updateDir, 'request.json'), JSON.stringify({ id: 'old', requested_at: new Date(Date.now() - 3600_000).toISOString(), target: 'v1.1.0' }));
  assert.equal((await apply()).status, 202);
});

test('the updater counts as running only while its heartbeat is fresh', async () => {
  reset();
  assert.equal((await summary()).body.updater.available, false);
  heartbeat();
  assert.deepEqual((await summary()).body.updater, { available: true, version: '1.0.0' });
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(path.join(updateDir, 'heartbeat'), old, old);
  assert.equal((await summary()).body.updater.available, false);
});

test('with two-factor authentication on, applying also needs a valid code', async () => {
  reset();
  release = goodRelease('v1.1.0');
  heartbeat();
  const secured = await t.createUser(admin.token, 'second-admin@example.com', 'sturdy-fence-lamp-42', 'Second Admin', { is_admin: true });
  const setup = await t.api.post('/api/auth/2fa/setup', { current_password: secured.password }, { token: secured.token });
  const enable = await t.api.post('/api/auth/2fa/enable', { code: totpAt(setup.body.secret) }, { token: secured.token });
  assert.equal(enable.status, 200);
  const session = (await t.api.post('/api/auth/login/mfa', {
    mfa_token: (await t.api.post('/api/auth/login', { email: secured.email, password: secured.password })).body.mfa_token,
    recovery_code: enable.body.recovery_codes[0],
  })).cookie;

  const noCode = await t.api.post('/api/admin/update/apply', { current_password: secured.password }, { token: session });
  assert.equal(noCode.status, 400);
  assert.equal(noCode.body.code, 'mfa_invalid');
  assert.equal(fs.existsSync(path.join(updateDir, 'request.json')), false);

  const ok = await t.api.post('/api/admin/update/apply', { current_password: secured.password, recovery_code: enable.body.recovery_codes[1] }, { token: session });
  assert.equal(ok.status, 202);
});

test('progress written by the updater is shown; broken or hostile status files are ignored', async () => {
  reset();
  const statusFile = path.join(updateDir, 'status.json');
  fs.writeFileSync(
    statusFile,
    JSON.stringify({ state: 'updating', request_id: 'abc', from: '1.0.0', to: '1.1.0', step: 'Pulling the new image', started_at: new Date().toISOString(), log: ['one', 'two'] })
  );
  let { body } = await summary();
  assert.equal(body.status.state, 'updating');
  assert.equal(body.status.step, 'Pulling the new image');
  assert.deepEqual(body.status.log, ['one', 'two']);
  assert.equal(body.in_progress, true);

  for (const junk of ['not json', JSON.stringify({ state: 'exploding' }), JSON.stringify([1, 2]), 'x'.repeat(200_000)]) {
    fs.writeFileSync(statusFile, junk);
    assert.equal((await summary()).body.status, null);
  }

  fs.writeFileSync(statusFile, JSON.stringify({ state: 'failed', message: 'm'.repeat(5000), log: Array.from({ length: 500 }, (_, i) => `line ${i}`), step: 's' }));
  ({ body } = await summary());
  assert.equal(body.status.message.length, 500);
  assert.equal(body.status.log.length, 40);
  assert.equal(body.in_progress, false);
});

test('a finished update is written to the audit log once', async () => {
  reset();
  fs.writeFileSync(path.join(updateDir, 'status.json'), JSON.stringify({ state: 'success', request_id: 'req-done-1', from: '1.0.0', to: '1.1.0', finished_at: new Date().toISOString() }));
  await summary();
  await summary();
  utils.resetUpdateCache(); // forgets the in-memory guard: the database must still prevent a duplicate
  await summary();
  const events = (await t.api.get('/api/admin/audit?action=update_finished', { token: admin.token })).body.events.filter((e) => e.target === 'req-done-1');
  assert.equal(events.length, 1);
  assert.match(events[0].detail, /"state":"success"/);
});

test('UPDATE_CHECK=false switches the feature off without any network traffic', async () => {
  reset();
  process.env.UPDATE_CHECK = 'false';
  try {
    const { body } = await summary();
    assert.equal(body.enabled, false);
    assert.equal(body.update_available, false);
    assert.equal(githubHits, 0);
    heartbeat();
    assert.equal((await apply()).status, 409);
  } finally {
    delete process.env.UPDATE_CHECK;
  }
});

test('a request whose result is already in no longer counts as in progress', async () => {
  reset();
  release = goodRelease('v1.1.0');
  heartbeat();
  const res = await apply();
  assert.equal(res.status, 202);
  assert.equal((await summary()).body.in_progress, true);
  // The updater reports success but could not delete the request file.
  fs.writeFileSync(path.join(updateDir, 'status.json'), JSON.stringify({ state: 'success', request_id: res.body.id, from: '1.0.0', to: '1.1.0', finished_at: new Date().toISOString() }));
  assert.equal((await summary()).body.in_progress, false);
});
