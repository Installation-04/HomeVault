import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { totpAt } from '../src/utils/totp.js';

let t;
let admin;
let db;

// The server runs in this process, so moving the clock moves it for both sides:
// that lets us test TOTP replay protection and token expiry without sleeping.
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;
const advance = (seconds) => {
  offsetMs += seconds * 1000;
};

before(async () => {
  t = await startTestServer();
  ({ db } = await import('../src/db/index.js'));
  admin = await t.setupAdmin();
});
after(async () => {
  Date.now = realNow;
  await t.close();
});

async function enroll(user) {
  const setup = await t.api.post('/api/auth/2fa/setup', { current_password: user.password }, { token: user.token });
  assert.equal(setup.status, 200);
  const enable = await t.api.post('/api/auth/2fa/enable', { code: totpAt(setup.body.secret) }, { token: user.token });
  assert.equal(enable.status, 200);
  return { secret: setup.body.secret, recoveryCodes: enable.body.recovery_codes };
}

const loginStep1 = (u) => t.api.post('/api/auth/login', { email: u.email, password: u.password });

test('enrolment: needs the password, gives an otpauth URL, activates only with a valid code, issues recovery codes', async () => {
  const u = await t.createUser(admin.token, 'enroll@example.com');
  const other = (await t.api.post('/api/auth/login', { email: u.email, password: u.password })).cookie;

  const noPw = await t.api.post('/api/auth/2fa/setup', { current_password: 'wrong-password-12' }, { token: u.token });
  assert.equal(noPw.status, 400);

  const setup = await t.api.post('/api/auth/2fa/setup', { current_password: u.password }, { token: u.token });
  assert.equal(setup.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.body.otpauth_url, /^otpauth:\/\/totp\/HomeVault:enroll%40example\.com\?secret=/);
  assert.equal((await t.api.get('/api/auth/2fa/status', { token: u.token })).body.enabled, false);

  const bad = await t.api.post('/api/auth/2fa/enable', { code: '000000' }, { token: u.token });
  assert.equal(bad.status, 400);
  assert.equal((await t.api.get('/api/auth/2fa/status', { token: u.token })).body.enabled, false, 'a wrong code must not switch it on');

  const good = await t.api.post('/api/auth/2fa/enable', { code: totpAt(setup.body.secret) }, { token: u.token });
  assert.equal(good.status, 200);
  assert.equal(good.body.recovery_codes.length, 10);
  assert.ok(good.body.recovery_codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)));
  assert.equal(new Set(good.body.recovery_codes).size, 10);

  const status = await t.api.get('/api/auth/2fa/status', { token: u.token });
  assert.deepEqual({ enabled: status.body.enabled, remaining: status.body.recovery_codes_remaining }, { enabled: true, remaining: 10 });
  assert.equal((await t.api.get('/api/auth/me', { token: other })).status, 401, 'other sessions are signed out when 2FA is switched on');
  assert.equal((await t.api.post('/api/auth/2fa/setup', { current_password: u.password }, { token: u.token })).status, 409);
});

test('the secret is encrypted at rest and recovery codes are stored hashed', async () => {
  const u = await t.createUser(admin.token, 'atrest@example.com');
  const { secret, recoveryCodes } = await enroll(u);
  const row = db.prepare('SELECT totp_secret_enc, totp_pending_enc FROM users WHERE id = ?').get(u.user.id);
  assert.match(row.totp_secret_enc, /^v1:/);
  assert.ok(!row.totp_secret_enc.includes(secret));
  assert.equal(row.totp_pending_enc, null);
  const hashes = db.prepare('SELECT code_hash FROM recovery_codes WHERE user_id = ?').all(u.user.id).map((r) => r.code_hash);
  assert.equal(hashes.length, 10);
  for (const code of recoveryCodes) assert.ok(!hashes.includes(code) && !hashes.includes(code.replace('-', '')));
});

test('login with 2FA: password alone gets no session; a valid code does; replaying it does not', async () => {
  const u = await t.createUser(admin.token, 'twostep@example.com');
  const { secret } = await enroll(u);

  advance(31); // move past the step the enrolment code consumed
  const step1 = await loginStep1(u);
  assert.equal(step1.status, 200);
  assert.equal(step1.body.mfa_required, true);
  assert.ok(step1.body.mfa_token);
  assert.equal(step1.cookie, null, 'no session before the second factor');
  assert.equal(step1.body.user, undefined);

  const wrong = await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, code: '123456' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'mfa_invalid');
  assert.equal(wrong.cookie, null);

  const code = totpAt(secret);
  const ok = await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, code });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
  assert.equal(ok.body.user.email, u.email);
  assert.equal((await t.api.get('/api/auth/me', { token: ok.cookie })).status, 200);

  const again = await loginStep1(u);
  const replay = await t.api.post('/api/auth/login/mfa', { mfa_token: again.body.mfa_token, code });
  assert.equal(replay.status, 401, 'a code that was already used must never work twice');

  advance(31);
  const fresh = await t.api.post('/api/auth/login/mfa', { mfa_token: again.body.mfa_token, code: totpAt(secret) });
  assert.equal(fresh.status, 200);
});

test('a code from a few minutes ago is rejected (only a ±30 s window is accepted)', async () => {
  const u = await t.createUser(admin.token, 'stale@example.com');
  const { secret } = await enroll(u);
  const old = totpAt(secret, Date.now() - 5 * 60 * 1000);
  advance(31);
  const step1 = await loginStep1(u);
  assert.equal((await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, code: old })).status, 401);
});

test('the mfa token is signed, short-lived and single-purpose', async () => {
  const u = await t.createUser(admin.token, 'token@example.com');
  const { secret } = await enroll(u);
  advance(31);
  const step1 = await loginStep1(u);

  const [body, sig] = step1.body.mfa_token.split('.');
  const tamperedBody = Buffer.from(JSON.stringify({ uid: admin.user.id, purpose: 'mfa', exp: 9999999999 })).toString('base64url');
  for (const forged of [`${tamperedBody}.${sig}`, `${body}.AAAA`, 'garbage', '', `${body}.${sig}.extra`]) {
    const res = await t.api.post('/api/auth/login/mfa', { mfa_token: forged, code: totpAt(secret) });
    assert.equal(res.status, 401, forged.slice(0, 20));
    assert.equal(res.body.code, 'mfa_expired');
  }

  advance(6 * 60);
  const expired = await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, code: totpAt(secret) });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, 'mfa_expired');
});

test('recovery codes work once each and report how many are left', async () => {
  const u = await t.createUser(admin.token, 'recover@example.com');
  const { recoveryCodes } = await enroll(u);
  const step1 = await loginStep1(u);
  const first = await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, recovery_code: recoveryCodes[0].toUpperCase() });
  assert.equal(first.status, 200, 'case and dash are forgiven');
  assert.equal(first.body.recovery_codes_remaining, 9);

  const step1b = await loginStep1(u);
  const reuse = await t.api.post('/api/auth/login/mfa', { mfa_token: step1b.body.mfa_token, recovery_code: recoveryCodes[0] });
  assert.equal(reuse.status, 401);
  const second = await t.api.post('/api/auth/login/mfa', { mfa_token: step1b.body.mfa_token, recovery_code: recoveryCodes[1].replace('-', '') });
  assert.equal(second.status, 200);
  assert.equal(second.body.recovery_codes_remaining, 8);
});

test('guessing second-factor codes is throttled', async () => {
  const u = await t.createUser(admin.token, 'brute@example.com');
  await enroll(u);
  advance(31);
  const step1 = await loginStep1(u);
  let last;
  for (let i = 0; i < 6; i++) last = await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, code: String(100000 + i) });
  assert.equal(last.status, 401);
  const blocked = await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, code: '999999' });
  assert.equal(blocked.status, 429);
});

test('disabling needs the password and a valid code; afterwards login is password-only again', async () => {
  const u = await t.createUser(admin.token, 'disable@example.com');
  const { secret } = await enroll(u);
  advance(31);

  assert.equal((await t.api.post('/api/auth/2fa/disable', { current_password: 'nope-nope-nope-1', code: totpAt(secret) }, { token: u.token })).status, 400);
  assert.equal((await t.api.post('/api/auth/2fa/disable', { current_password: u.password, code: '000000' }, { token: u.token })).status, 400);
  assert.equal((await t.api.get('/api/auth/2fa/status', { token: u.token })).body.enabled, true);

  const off = await t.api.post('/api/auth/2fa/disable', { current_password: u.password, code: totpAt(secret) }, { token: u.token });
  assert.equal(off.status, 204);
  assert.equal((await t.api.get('/api/auth/2fa/status', { token: u.token })).body.enabled, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ?').get(u.user.id).c, 0);
  const login = await loginStep1(u);
  assert.ok(login.cookie, 'plain password login again');
  assert.equal(login.body.mfa_required, undefined);
});

test('regenerating recovery codes invalidates the old set', async () => {
  const u = await t.createUser(admin.token, 'regen@example.com');
  const { secret, recoveryCodes } = await enroll(u);
  advance(31);
  const res = await t.api.post('/api/auth/2fa/recovery-codes', { current_password: u.password, code: totpAt(secret) }, { token: u.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.recovery_codes.length, 10);
  const step1 = await loginStep1(u);
  assert.equal((await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, recovery_code: recoveryCodes[0] })).status, 401);
  assert.equal((await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, recovery_code: res.body.recovery_codes[0] })).status, 200);
});

test('an admin can reset a locked-out person\'s 2FA, which also signs them out', async () => {
  const u = await t.createUser(admin.token, 'lost-phone@example.com');
  const { recoveryCodes } = await enroll(u);
  const step1 = await loginStep1(u);
  const session = (await t.api.post('/api/auth/login/mfa', { mfa_token: step1.body.mfa_token, recovery_code: recoveryCodes[0] })).cookie;
  assert.equal((await t.api.get('/api/auth/me', { token: session })).status, 200);

  assert.equal((await t.api.post(`/api/auth/users/${u.user.id}/reset-2fa`, {}, { token: session })).status, 403, 'not for non-admins');
  assert.equal((await t.api.post(`/api/auth/users/${u.user.id}/reset-2fa`, {}, { token: admin.token })).status, 204);
  assert.equal((await t.api.get('/api/auth/me', { token: session })).status, 401);
  const login = await loginStep1(u);
  assert.ok(login.cookie);
  assert.equal(login.body.mfa_required, undefined);
});

test('2FA settings require a signed-in session', async () => {
  for (const [method, path] of [['GET', '/api/auth/2fa/status'], ['POST', '/api/auth/2fa/setup'], ['POST', '/api/auth/2fa/enable'], ['POST', '/api/auth/2fa/disable']]) {
    assert.equal((await t.api.call(method, path, method === 'GET' ? {} : { json: {} })).status, 401, path);
  }
});
