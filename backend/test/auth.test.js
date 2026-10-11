import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let db;

before(async () => {
  t = await startTestServer();
  ({ db } = await import('../src/db/index.js'));
  admin = await t.setupAdmin();
});
after(() => t.close());

test('unauthenticated requests are rejected', async () => {
  for (const p of ['/api/properties', '/api/dashboard', '/api/auth/me']) {
    const res = await t.api.get(p);
    assert.equal(res.status, 401, p);
  }
});

test('setup is only allowed once', async () => {
  const res = await t.api.post('/api/auth/setup', { email: 'x@example.com', password: 'long-enough-pw', name: 'X' });
  assert.equal(res.status, 403);
});

test('login: wrong password -> 401 with an error message, right password -> token', async () => {
  const bad = await t.api.post('/api/auth/login', { email: admin.email, password: 'nope-nope-nope' });
  assert.equal(bad.status, 401);
  assert.ok(bad.body.error);

  const ok = await t.api.post('/api/auth/login', { email: admin.email.toUpperCase(), password: admin.password });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
});

test('passwords shorter than 8 characters are rejected', async () => {
  const res = await t.api.post(
    '/api/auth/users',
    { email: 'short@example.com', password: 'short', name: 'Short' },
    { token: admin.token }
  );
  assert.equal(res.status, 400);
});

test('only admins can create users and list users', async () => {
  const member = await t.createUser(admin.token, 'member@example.com');
  const create = await t.api.post(
    '/api/auth/users',
    { email: 'sneaky@example.com', password: 'long-enough-pw', name: 'S' },
    { token: member.token }
  );
  assert.equal(create.status, 403);

  assert.equal((await t.api.get('/api/auth/users', { token: member.token })).status, 403);
  const list = await t.api.get('/api/auth/users', { token: admin.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((u) => u.email === 'member@example.com'));
  assert.ok(list.body.every((u) => !('password_hash' in u)));
});

test('duplicate email -> 409', async () => {
  const res = await t.api.post(
    '/api/auth/users',
    { email: 'MEMBER@example.com', password: 'long-enough-pw', name: 'Dup' },
    { token: admin.token }
  );
  assert.equal(res.status, 409);
});

test('change password: wrong current is rejected (without a 401), new one works', async () => {
  const u = await t.createUser(admin.token, 'pw@example.com', 'original-password');

  const wrong = await t.api.post(
    '/api/auth/password',
    { current_password: 'not-my-password', new_password: 'brand-new-password' },
    { token: u.token }
  );
  assert.equal(wrong.status, 400, 'a 401 would make the SPA treat it as an expired session');

  const weak = await t.api.post(
    '/api/auth/password',
    { current_password: 'original-password', new_password: 'short' },
    { token: u.token }
  );
  assert.equal(weak.status, 400);

  const ok = await t.api.post(
    '/api/auth/password',
    { current_password: 'original-password', new_password: 'brand-new-password' },
    { token: u.token }
  );
  assert.equal(ok.status, 204);

  const oldLogin = await t.api.post('/api/auth/login', { email: u.email, password: 'original-password' });
  assert.equal(oldLogin.status, 401);
  const newLogin = await t.api.post('/api/auth/login', { email: u.email, password: 'brand-new-password' });
  assert.equal(newLogin.status, 200);
});

test('a deleted user\'s token stops working immediately', async () => {
  const u = await t.createUser(admin.token, 'gone@example.com');
  assert.equal((await t.api.get('/api/auth/me', { token: u.token })).status, 200);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.user.id);
  assert.equal((await t.api.get('/api/auth/me', { token: u.token })).status, 401);
});

test('demoting an admin takes effect without waiting for the JWT to expire', async () => {
  const u = await t.createUser(admin.token, 'demoted@example.com');
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.user.id);
  // Token was minted while non-admin; it must reflect the DB row, not the claim.
  assert.equal((await t.api.get('/api/auth/users', { token: u.token })).status, 200);
  db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(u.user.id);
  assert.equal((await t.api.get('/api/auth/users', { token: u.token })).status, 403);
});

test('?token= is accepted only on file download routes, not on JSON routes', async () => {
  const viaQuery = await t.api.get(`/api/properties?token=${admin.token}`);
  assert.equal(viaQuery.status, 401);
  const viaHeader = await t.api.get('/api/properties', { token: admin.token });
  assert.equal(viaHeader.status, 200);
});
