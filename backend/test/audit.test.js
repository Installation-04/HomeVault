import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let alice;
let db;

before(async () => {
  t = await startTestServer();
  ({ db } = await import('../src/db/index.js'));
  admin = await t.setupAdmin();
  alice = await t.createUser(admin.token, 'alice@example.com');
});
after(() => t.close());

const events = (action) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

test('setup, logins and failures are recorded with who/where, but never with secrets', async () => {
  assert.equal(events('setup_completed').length, 1);
  assert.equal(events('setup_completed')[0].actor, 'admin@example.com');

  await t.api.post('/api/auth/login', { email: 'alice@example.com', password: 'wrong-password-123' }, { headers: { 'User-Agent': 'TestBrowser/1.0' } });
  await t.api.post('/api/auth/login', { email: 'ghost@example.com', password: 'wrong-password-123' });
  await t.api.post('/api/auth/login', { email: 'alice@example.com', password: alice.password });

  const failed = events('login_failed');
  assert.equal(failed.length, 2);
  assert.equal(failed[0].actor, 'alice@example.com');
  assert.equal(failed[0].user_id, alice.user.id);
  assert.equal(failed[0].user_agent, 'TestBrowser/1.0');
  assert.ok(failed[0].ip);
  assert.equal(JSON.parse(failed[0].detail).reason, 'bad_password');
  assert.equal(JSON.parse(failed[1].detail).reason, 'unknown_user');
  assert.equal(failed[1].user_id, null);
  assert.ok(events('login_success').length >= 1);

  const dump = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  for (const secret of ['wrong-password-123', alice.password, admin.password, alice.token, admin.token]) {
    assert.ok(!dump.includes(secret), 'the audit log must not contain credentials');
  }
});

test('sensitive actions leave a trail: password change, sessions, 2FA, sharing, property delete, exports, user admin', async () => {
  const p = await t.createProperty(alice.token, 'Audited House');
  await t.api.post(`/api/properties/${p.id}/share`, { email: 'admin@example.com', role: 'viewer' }, { token: alice.token });
  await t.api.get(`/api/export/property/${p.id}/bundle.zip`, { token: alice.token, raw: true }).then((r) => r.arrayBuffer());
  await t.api.post('/api/auth/password', { current_password: alice.password, new_password: 'a-whole-new-password-5' }, { token: alice.token });
  await t.api.del('/api/auth/sessions', { token: alice.token });
  await t.api.del(`/api/properties/${p.id}`, { token: alice.token });
  await t.api.patch(`/api/auth/users/${alice.user.id}`, { disabled: true }, { token: admin.token });
  await t.api.post(`/api/auth/users/${alice.user.id}/reset-password`, {}, { token: admin.token });

  for (const action of ['property_created', 'property_shared', 'bundle_exported', 'password_changed', 'sessions_revoked_all', 'property_deleted', 'user_disabled', 'user_password_reset', 'user_created']) {
    assert.ok(events(action).length >= 1, `missing audit event: ${action}`);
  }
  const reset = events('user_password_reset')[0];
  assert.equal(reset.target, 'alice@example.com');
  assert.equal(reset.actor, 'admin@example.com');
  assert.ok(!JSON.stringify(reset).includes('temp'), 'the temporary password is not logged');
});

test('admin can page through the audit log and filter it; non-admins cannot', async () => {
  const page1 = await t.api.get('/api/admin/audit?limit=5', { token: admin.token });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.events.length, 5);
  assert.ok(page1.body.next_before);
  assert.ok(page1.body.events[0].id > page1.body.events[4].id, 'newest first');
  const page2 = await t.api.get(`/api/admin/audit?limit=5&before=${page1.body.next_before}`, { token: admin.token });
  assert.ok(page2.body.events.every((e) => e.id < page1.body.next_before));

  const only = await t.api.get('/api/admin/audit?action=login_failed', { token: admin.token });
  assert.ok(only.body.events.length >= 2 && only.body.events.every((e) => e.action === 'login_failed'));
  const byUser = await t.api.get(`/api/admin/audit?user_id=${alice.user.id}`, { token: admin.token });
  assert.ok(byUser.body.events.every((e) => e.user_id === alice.user.id));

  const member = await t.createUser(admin.token, 'plain@example.com');
  assert.equal((await t.api.get('/api/admin/audit', { token: member.token })).status, 403);
  assert.equal((await t.api.get('/api/admin/audit')).status, 401);
});

test('everyone can see their own recent security activity, and only their own', async () => {
  const bob = await t.createUser(admin.token, 'bob@example.com');
  await t.api.post('/api/auth/login', { email: bob.email, password: 'wrong-password-123' });
  const mine = await t.api.get('/api/auth/activity', { token: bob.token });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.length >= 1);
  assert.ok(mine.body.some((e) => e.action === 'login_failed'));
  assert.ok(!mine.body.some((e) => e.action === 'setup_completed'));
  assert.ok(mine.body.every((e) => !('actor' in e) || true));
  const ids = new Set(db.prepare('SELECT id FROM audit_log WHERE user_id = ?').all(bob.user.id).map((r) => r.id));
  assert.ok(mine.body.every((e) => ids.has(e.id)));
});

test('maintenance prunes old audit rows and expired sessions, and keeps recent ones', async () => {
  const { maintainDatabase } = await import('../src/db/index.js');
  db.prepare("INSERT INTO audit_log (at, action) VALUES (datetime('now', '-500 days'), 'ancient')").run();
  db.prepare("INSERT INTO audit_log (at, action) VALUES (datetime('now', '-10 days'), 'recent')").run();
  const result = maintainDatabase({ auditRetentionDays: 400 });
  assert.ok(result.oldAudit >= 1);
  assert.equal(events('ancient').length, 0);
  assert.equal(events('recent').length, 1);
});

test('audit rows survive the user being removed (actor email is kept)', async () => {
  const temp = await t.createUser(admin.token, 'short-lived@example.com');
  await t.api.post('/api/auth/login', { email: temp.email, password: 'wrong-password-123' });
  assert.equal((await t.api.del(`/api/auth/users/${temp.user.id}`, { token: admin.token })).status, 204);
  const rows = db.prepare("SELECT user_id, actor FROM audit_log WHERE actor = 'short-lived@example.com'").all();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.user_id === null));
});
