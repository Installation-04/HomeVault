import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer({ TRUST_PROXY: '1' });
  await t.setupAdmin('admin@example.com', 'correct-horse-battery');
});
after(() => t.close());

const login = (headers = {}) =>
  t.api.call('POST', '/api/auth/login', { json: { email: 'admin@example.com', password: 'correct-horse-battery' }, headers });
// A login response also carries a line that *clears* the other cookie variant; pick the real one.
const cookieLine = (res) => (res.headers.getSetCookie() ?? []).find((l) => /hv_session=[^;]/.test(l)) ?? '';

test('over plain http the cookie is not Secure (so LAN installs still work)', async () => {
  const line = cookieLine(await login());
  assert.match(line, /^hv_session=/);
  assert.ok(!/;\s*Secure/i.test(line));
  assert.match(line, /HttpOnly/);
});

test('behind a TLS-terminating proxy (X-Forwarded-Proto: https) the cookie becomes Secure and __Host- prefixed', async () => {
  const res = await login({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' });
  const line = cookieLine(res);
  assert.match(line, /^__Host-hv_session=/);
  assert.match(line, /;\s*Secure/i);
  assert.match(line, /Path=\//);
  assert.ok(!/Domain=/i.test(line), '__Host- cookies must not set a Domain');
  // The browser would send it back under the prefixed name; the server must accept that.
  assert.equal(res.cookie !== null, true);
  const me = await t.api.call('GET', '/api/auth/me', { headers: { Cookie: `__Host-hv_session=${res.cookie}` }, raw: true });
  assert.equal(me.status, 200);
});

test('COOKIE_SECURE=always forces Secure even without a proxy header; =never overrides it', async () => {
  process.env.COOKIE_SECURE = 'always';
  assert.match(cookieLine(await login()), /^__Host-hv_session=.*Secure/i);
  process.env.COOKIE_SECURE = 'never';
  assert.ok(!/Secure/i.test(cookieLine(await login({ 'X-Forwarded-Proto': 'https' }))));
  delete process.env.COOKIE_SECURE;
});

test('the client address comes from X-Forwarded-For when a proxy is trusted (it is what the audit log records)', async () => {
  await t.api.call('POST', '/api/auth/login', { json: { email: 'admin@example.com', password: 'wrong-password-12' }, headers: { 'X-Forwarded-For': '198.51.100.23' } });
  const { db } = await import('../src/db/index.js');
  const row = db.prepare("SELECT ip FROM audit_log WHERE action = 'login_failed' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.ip, '198.51.100.23');
});

test('logging out clears both cookie variants', async () => {
  const res = await t.api.call('POST', '/api/auth/logout', { json: {}, headers: { 'X-Forwarded-Proto': 'https' } });
  const lines = res.headers.getSetCookie().join('\n');
  assert.match(lines, /hv_session=;/);
  assert.match(lines, /__Host-hv_session=;/);
});
