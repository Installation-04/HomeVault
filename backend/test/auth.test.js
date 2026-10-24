import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startTestServer } from './helpers.js';

let t;
let admin;
let db;

before(async () => {
  t = await startTestServer();
  ({ db } = await import('../src/db/index.js'));
});
after(() => t.close());

const setCookieLine = (res) => (res.headers.getSetCookie?.() ?? []).find((l) => /hv_session=/.test(l)) ?? '';

test('before setup: status says setup is needed, everything else is locked', async () => {
  const status = await t.api.get('/api/auth/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { needs_setup: true, setup_token_required: false });
  for (const p of ['/api/properties', '/api/dashboard', '/api/auth/me', '/api/search?q=abc']) {
    const res = await t.api.get(p);
    assert.equal(res.status, 401, p);
    assert.equal(res.body.code, 'unauthenticated');
  }
});

test('setup validates input, creates the admin and signs them in with a hardened cookie', async () => {
  const weak = await t.api.post('/api/auth/setup', { email: 'admin@example.com', password: 'short', name: 'Admin' });
  assert.equal(weak.status, 400);
  const common = await t.api.post('/api/auth/setup', { email: 'admin@example.com', password: 'password123', name: 'Admin' });
  assert.equal(common.status, 400);
  const badEmail = await t.api.post('/api/auth/setup', { email: 'nope', password: 'correct-horse-battery', name: 'Admin' });
  assert.equal(badEmail.status, 400);

  admin = await t.setupAdmin();
  assert.ok(admin.token, 'a session cookie was issued');
  const res = await t.api.post('/api/auth/login', { email: admin.email, password: admin.password });
  const line = setCookieLine(res);
  assert.match(line, /HttpOnly/i);
  assert.match(line, /SameSite=Strict/i);
  assert.match(line, /Path=\//);
  assert.ok(!('token' in res.body), 'the session token must never be in the JSON body');
  assert.ok(!/hash|totp_secret|"scrypt|\$2[aby]\$/i.test(JSON.stringify(res.body)), 'no hashes or secrets in the login response');

  const again = await t.api.post('/api/auth/setup', { email: 'x@example.com', password: 'long-enough-pw-1', name: 'X' });
  assert.equal(again.status, 403);
  assert.deepEqual((await t.api.get('/api/auth/status')).body, { needs_setup: false, setup_token_required: false });
});

test('the password is stored as a scrypt hash, not plaintext or bcrypt', () => {
  const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('admin@example.com');
  assert.match(row.password_hash, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!row.password_hash.includes('correct-horse'));
});

test('login: wrong password and unknown email look identical; email is case-insensitive', async () => {
  const wrong = await t.api.post('/api/auth/login', { email: admin.email, password: 'definitely-wrong-pw' });
  const unknown = await t.api.post('/api/auth/login', { email: 'ghost@example.com', password: 'definitely-wrong-pw' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.body.code, 'invalid_credentials');
  assert.equal(wrong.cookie, null);

  const ok = await t.api.post('/api/auth/login', { email: admin.email.toUpperCase(), password: admin.password });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
  assert.equal((await t.api.post('/api/auth/login', { email: admin.email })).status, 400);
});

test('/me works with the cookie, and a forged or garbage cookie does not', async () => {
  const me = await t.api.get('/api/auth/me', { token: admin.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, admin.email);
  assert.ok(!('password_hash' in me.body));
  assert.equal((await t.api.get('/api/auth/me', { token: 'garbage' })).status, 401);
  assert.equal((await t.api.get('/api/auth/me', { token: 'x'.repeat(500) })).status, 401);
});

test('credentials in the URL or an Authorization header are never accepted', async () => {
  assert.equal((await t.api.get(`/api/properties?token=${admin.token}`)).status, 401);
  assert.equal((await t.api.get('/api/properties', { headers: { Authorization: `Bearer ${admin.token}` } })).status, 401);
});

test('logout revokes the session server-side; it is idempotent without a session', async () => {
  const login = await t.api.post('/api/auth/login', { email: admin.email, password: admin.password });
  assert.equal((await t.api.get('/api/properties', { token: login.cookie })).status, 200);
  const out = await t.api.post('/api/auth/logout', {}, { token: login.cookie });
  assert.equal(out.status, 204);
  assert.equal((await t.api.get('/api/properties', { token: login.cookie })).status, 401, 'the old cookie value must be dead');
  assert.equal((await t.api.post('/api/auth/logout', {})).status, 204);
});

test('sessions: list with current flag, revoke one, revoke all others', async () => {
  // A throwaway account, so revoking its sessions can't disturb the shared admin session.
  const u = await t.createUser(admin.token, 'sessions@example.com');
  const a = u.token;
  const b = (await t.api.post('/api/auth/login', { email: u.email, password: u.password })).cookie;
  const c = (await t.api.post('/api/auth/login', { email: u.email, password: u.password })).cookie;

  const list = await t.api.get('/api/auth/sessions', { token: a });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 3);
  assert.equal(list.body.filter((s) => s.current).length, 1);
  assert.ok(list.body.every((s) => !('token_hash' in s)));

  const other = list.body.find((s) => !s.current);
  assert.equal((await t.api.del(`/api/auth/sessions/${other.id}`, { token: a })).status, 204);
  assert.equal((await t.api.del(`/api/auth/sessions/${other.id}`, { token: a })).status, 404);

  const revoked = await t.api.del('/api/auth/sessions', { token: a });
  assert.equal(revoked.status, 200);
  assert.equal((await t.api.get('/api/auth/me', { token: a })).status, 200, 'own session survives');
  assert.equal((await t.api.get('/api/auth/me', { token: b })).status, 401);
  assert.equal((await t.api.get('/api/auth/me', { token: c })).status, 401);
});

test('a session cannot be revoked by a different user', async () => {
  const member = await t.createUser(admin.token, 'other@example.com');
  const mine = (await t.api.get('/api/auth/sessions', { token: admin.token })).body[0];
  assert.equal((await t.api.del(`/api/auth/sessions/${mine.id}`, { token: member.token })).status, 404);
  assert.equal((await t.api.get('/api/auth/me', { token: admin.token })).status, 200);
});

test('expired and idle sessions stop working', async () => {
  const s = (await t.api.post('/api/auth/login', { email: admin.email, password: admin.password })).cookie;
  assert.equal((await t.api.get('/api/auth/me', { token: s })).status, 200);
  db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute') WHERE id = (SELECT MAX(id) FROM sessions)").run();
  assert.equal((await t.api.get('/api/auth/me', { token: s })).status, 401);

  const idle = (await t.api.post('/api/auth/login', { email: admin.email, password: admin.password })).cookie;
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now', '-30 days') WHERE id = (SELECT MAX(id) FROM sessions)").run();
  assert.equal((await t.api.get('/api/auth/me', { token: idle })).status, 401);
});

test('change password: wrong current is a 400 (not a 401), policy applies, other sessions are signed out', async () => {
  const u = await t.createUser(admin.token, 'pwchanger@example.com', 'original-password-1');
  const second = (await t.api.post('/api/auth/login', { email: u.email, password: u.password })).cookie;

  const wrong = await t.api.post('/api/auth/password', { current_password: 'not-my-password', new_password: 'brand-new-password-9' }, { token: u.token });
  assert.equal(wrong.status, 400, 'a 401 would make the SPA treat it as an expired session');
  assert.equal(wrong.body.code, 'bad_current_password');

  for (const bad of ['short', 'password1234', 'pwchanger-123456']) {
    const res = await t.api.post('/api/auth/password', { current_password: u.password, new_password: bad }, { token: u.token });
    assert.equal(res.status, 400, bad);
  }
  assert.equal((await t.api.post('/api/auth/password', { current_password: u.password, new_password: u.password }, { token: u.token })).status, 400);

  const ok = await t.api.post('/api/auth/password', { current_password: u.password, new_password: 'brand-new-password-9' }, { token: u.token });
  assert.equal(ok.status, 204);
  assert.equal((await t.api.get('/api/auth/me', { token: u.token })).status, 200, 'the session that changed it stays signed in');
  assert.equal((await t.api.get('/api/auth/me', { token: second })).status, 401, 'other sessions are revoked');
  assert.equal((await t.api.post('/api/auth/login', { email: u.email, password: u.password })).status, 401);
  assert.equal((await t.api.post('/api/auth/login', { email: u.email, password: 'brand-new-password-9' })).status, 200);
});

test('legacy bcrypt accounts can still sign in and are upgraded to scrypt', async () => {
  db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)').run('legacy@example.com', bcrypt.hashSync('legacy-password-77', 4), 'Legacy');
  const before = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('legacy@example.com').password_hash;
  assert.match(before, /^\$2/);

  assert.equal((await t.api.post('/api/auth/login', { email: 'legacy@example.com', password: 'wrong-password-77' })).status, 401);
  const ok = await t.api.post('/api/auth/login', { email: 'legacy@example.com', password: 'legacy-password-77' });
  assert.equal(ok.status, 200);
  const after = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('legacy@example.com').password_hash;
  assert.match(after, /^scrypt\$/);
  assert.equal((await t.api.post('/api/auth/login', { email: 'legacy@example.com', password: 'legacy-password-77' })).status, 200);
});

test('repeated failures lock an account for a while (per-account throttle), correct password included', async () => {
  const email = 'target@example.com';
  await t.createUser(admin.token, email, 'the-real-password-1');
  let last;
  for (let i = 0; i < 10; i++) last = await t.api.post('/api/auth/login', { email, password: `guess-number-${i}-xx` });
  assert.equal(last.status, 401);
  const blocked = await t.api.post('/api/auth/login', { email, password: 'the-real-password-1' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Another account is unaffected, and so is an address that doesn't exist (same behavior, no enumeration).
  assert.equal((await t.api.post('/api/auth/login', { email: admin.email, password: admin.password })).status, 200);
  for (let i = 0; i < 10; i++) await t.api.post('/api/auth/login', { email: 'nobody-here@example.com', password: `guess-number-${i}-xx` });
  assert.equal((await t.api.post('/api/auth/login', { email: 'nobody-here@example.com', password: 'whatever-it-is-1' })).status, 429);
});

test('CSRF: cross-site state-changing requests are refused; same-origin and non-browser ones work', async () => {
  const host = new URL(t.base).host;
  const forged = await t.api.post('/api/properties', { name: 'Evil' }, { token: admin.token, headers: { Origin: 'https://evil.example' } });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, 'csrf');
  const nullOrigin = await t.api.post('/api/properties', { name: 'Evil' }, { token: admin.token, headers: { Origin: 'null' } });
  assert.equal(nullOrigin.status, 403);
  const crossSite = await t.api.post('/api/properties', { name: 'Evil' }, { token: admin.token, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const sameSiteSibling = await t.api.post('/api/properties', { name: 'Evil' }, { token: admin.token, headers: { 'Sec-Fetch-Site': 'same-site' } });
  assert.equal(sameSiteSibling.status, 403, 'a sibling subdomain is "same-site" but must still be refused');

  const sameOrigin = await t.api.post('/api/properties', { name: 'Fine' }, { token: admin.token, headers: { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(sameOrigin.status, 201);
  const noHeaders = await t.api.post('/api/properties', { name: 'Fine 2' }, { token: admin.token });
  assert.equal(noHeaders.status, 201);
  assert.equal((await t.api.get('/api/properties', { token: admin.token, headers: { Origin: 'https://evil.example' } })).status, 200, 'safe methods are not blocked');
  assert.equal(
    (await t.api.post('/api/auth/login', { email: admin.email, password: admin.password }, { headers: { Origin: 'https://evil.example' } })).status,
    403,
    'login CSRF is blocked too'
  );
});

test('API responses are never cacheable and the server does not advertise itself', async () => {
  const res = await t.api.get('/api/auth/me', { token: admin.token });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
});

// ---- admin user management --------------------------------------------------

test('admin-created accounts must change their temporary password before doing anything else', async () => {
  const create = await t.api.post('/api/auth/users', { email: 'newbie@example.com', password: 'temporary-pass-1', name: 'Newbie' }, { token: admin.token });
  assert.equal(create.status, 201);
  assert.equal(create.body.must_change_password, true);
  const login = await t.api.post('/api/auth/login', { email: 'newbie@example.com', password: 'temporary-pass-1' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.must_change_password, true);

  const blocked = await t.api.get('/api/properties', { token: login.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'password_change_required');
  assert.equal((await t.api.get('/api/auth/me', { token: login.cookie })).status, 200, '/me stays available so the UI can show the prompt');

  const changed = await t.api.post('/api/auth/password', { current_password: 'temporary-pass-1', new_password: 'my-own-password-42' }, { token: login.cookie });
  assert.equal(changed.status, 204);
  assert.equal((await t.api.get('/api/properties', { token: login.cookie })).status, 200);
});

test('only admins can manage users', async () => {
  const member = await t.createUser(admin.token, 'member@example.com');
  assert.equal((await t.api.get('/api/auth/users', { token: member.token })).status, 403);
  assert.equal((await t.api.post('/api/auth/users', { email: 'x@example.com', password: 'long-enough-pw-1', name: 'S' }, { token: member.token })).status, 403);
  assert.equal((await t.api.patch(`/api/auth/users/${admin.user.id}`, { name: 'Hijacked' }, { token: member.token })).status, 403);

  const list = await t.api.get('/api/auth/users', { token: admin.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((u) => u.email === 'member@example.com'));
  assert.ok(list.body.every((u) => !('password_hash' in u) && !('totp_secret_enc' in u)));
  assert.equal((await t.api.post('/api/auth/users', { email: 'MEMBER@example.com', password: 'long-enough-pw-1', name: 'Dup' }, { token: admin.token })).status, 409);
  assert.equal((await t.api.post('/api/auth/users', { email: 'weak@example.com', password: 'short', name: 'W' }, { token: admin.token })).status, 400);
});

test('disabling an account signs it out at once and blocks sign-in; enabling restores it', async () => {
  const u = await t.createUser(admin.token, 'toggle@example.com');
  const off = await t.api.patch(`/api/auth/users/${u.user.id}`, { disabled: true }, { token: admin.token });
  assert.equal(off.status, 200);
  assert.equal(off.body.disabled, true);
  assert.equal((await t.api.get('/api/auth/me', { token: u.token })).status, 401);
  assert.equal((await t.api.post('/api/auth/login', { email: u.email, password: u.password })).status, 401);
  const on = await t.api.patch(`/api/auth/users/${u.user.id}`, { disabled: false }, { token: admin.token });
  assert.equal(on.body.disabled, false);
  assert.equal((await t.api.post('/api/auth/login', { email: u.email, password: u.password })).status, 200);
});

test('the household can never be left without an admin, and you cannot remove yourself', async () => {
  const patch = (id, json, token = admin.token) => t.api.patch(`/api/auth/users/${id}`, json, { token });
  assert.equal((await patch(admin.user.id, { is_admin: false })).status, 400);
  assert.equal((await patch(admin.user.id, { disabled: true })).status, 400);
  assert.equal((await t.api.del(`/api/auth/users/${admin.user.id}`, { token: admin.token })).status, 400);

  const second = await t.createUser(admin.token, 'admin2@example.com', 'sturdy-fence-lamp-42', 'Second Admin', { is_admin: true });
  assert.equal((await patch(admin.user.id, { is_admin: false }, second.token)).status, 200, 'with another admin present it is allowed');
  assert.equal((await patch(second.user.id, { name: 'Renamed' }, admin.token)).status, 403, 'the demoted admin loses admin rights at once');
  // restore for later tests
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.user.id);
});

test('admin password reset: temp password shown once, forces a change, signs the person out', async () => {
  const u = await t.createUser(admin.token, 'forgot@example.com', 'unrelated-secret-77');
  const reset = await t.api.post(`/api/auth/users/${u.user.id}/reset-password`, {}, { token: admin.token });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.temp_password.length >= 12);
  assert.equal((await t.api.get('/api/auth/me', { token: u.token })).status, 401);
  assert.equal((await t.api.post('/api/auth/login', { email: u.email, password: u.password })).status, 401);
  const login = await t.api.post('/api/auth/login', { email: u.email, password: reset.body.temp_password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.must_change_password, true);
  assert.equal((await t.api.post(`/api/auth/users/${admin.user.id}/reset-password`, {}, { token: admin.token })).status, 400, 'not for yourself');
});

test('accounts with history cannot be deleted (disable instead); empty ones can', async () => {
  const worker = await t.createUser(admin.token, 'worker@example.com');
  await t.createProperty(worker.token, 'Worker House');
  const refused = await t.api.del(`/api/auth/users/${worker.user.id}`, { token: admin.token });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'has_history');

  const empty = await t.createUser(admin.token, 'empty@example.com');
  assert.equal((await t.api.del(`/api/auth/users/${empty.user.id}`, { token: admin.token })).status, 204);
  assert.equal((await t.api.post('/api/auth/login', { email: empty.email, password: empty.password })).status, 401);
});

test('profile: name/locale update and validation', async () => {
  const u = await t.createUser(admin.token, 'profile@example.com');
  const ok = await t.api.patch('/api/auth/me', { name: '  Renamed  ', locale: 'fr' }, { token: u.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'Renamed');
  assert.equal(ok.body.locale, 'fr');
  assert.equal((await t.api.patch('/api/auth/me', { locale: 'xx' }, { token: u.token })).status, 400);
  assert.equal((await t.api.patch('/api/auth/me', { name: '   ' }, { token: u.token })).status, 400);
});
