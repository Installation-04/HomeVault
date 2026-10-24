import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';
process.env.APP_SECRET = 'unit-test-secret-unit-test-secret';

const crypto = await import('../src/utils/crypto.js');
const totp = await import('../src/utils/totp.js');
const { FailureThrottle } = await import('../src/utils/throttle.js');
const { passwordProblem } = await import('../src/utils/passwordPolicy.js');

// ---- passwords ---------------------------------------------------------------

test('scrypt hashes verify, are salted, and carry their parameters', async () => {
  const a = await crypto.hashPassword('correct horse battery staple');
  const b = await crypto.hashPassword('correct horse battery staple');
  assert.notEqual(a, b, 'salted');
  assert.match(a, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.deepEqual(await crypto.verifyPassword('correct horse battery staple', a), { ok: true, needsRehash: false });
  assert.equal((await crypto.verifyPassword('correct horse battery stapl', a)).ok, false);
  assert.equal((await crypto.verifyPassword('', a)).ok, false);
});

test('unicode passwords are normalized (NFC vs NFD typing of the same text)', async () => {
  const hash = await crypto.hashPassword('mot-de-passe-été-2026'); // precomposed é
  assert.equal((await crypto.verifyPassword('mot-de-passe-été-2026', hash)).ok, true); // e + combining accent
});

test('legacy bcrypt hashes verify and ask to be upgraded; garbage never verifies or throws', async () => {
  const legacy = bcrypt.hashSync('old-password-123', 4);
  assert.deepEqual(await crypto.verifyPassword('old-password-123', legacy), { ok: true, needsRehash: true });
  assert.equal((await crypto.verifyPassword('wrong', legacy)).ok, false);
  for (const junk of ['', 'plaintext', 'scrypt$', 'scrypt$1$2$3$4$5', 'scrypt$99999999999$8$1$AAAA$AAAA', '$2a$bad', null, undefined, 42]) {
    assert.equal((await crypto.verifyPassword('anything-at-all', junk)).ok, false, String(junk));
  }
});

test('oversized passwords are refused instead of being hashed (denial-of-service guard)', async () => {
  const hash = await crypto.hashPassword('fine-password-123');
  assert.equal((await crypto.verifyPassword('x'.repeat(crypto.MAX_PASSWORD_LENGTH + 1), hash)).ok, false);
});

test('weaker stored parameters are flagged for rehash', async () => {
  // Same password, deliberately cheap parameters (N=1024).
  const { scryptSync, randomBytes } = await import('node:crypto');
  const salt = randomBytes(16);
  const weak = ['scrypt', 1024, 8, 1, salt.toString('base64'), scryptSync('some-password-1'.normalize('NFKC'), salt, 32, { N: 1024, r: 8, p: 1 }).toString('base64')].join('$');
  assert.deepEqual(await crypto.verifyPassword('some-password-1', weak), { ok: true, needsRehash: true });
});

// ---- signed tokens & encryption ---------------------------------------------

test('signed payloads round-trip, expire and reject tampering', () => {
  const token = crypto.signPayload({ uid: 7, purpose: 'mfa' }, 60);
  assert.equal(crypto.verifyPayload(token).uid, 7);
  assert.equal(crypto.verifyPayload(crypto.signPayload({ uid: 1 }, -1)), null, 'expired');
  const [body, sig] = token.split('.');
  assert.equal(crypto.verifyPayload(`${body}x.${sig}`), null);
  assert.equal(crypto.verifyPayload(`${body}.${sig.slice(0, -2)}AA`), null);
  for (const junk of [null, undefined, 12, '', '.', 'a.b.c', 'only-one-part']) assert.equal(crypto.verifyPayload(junk), null);
});

test('secrets encrypt with a random IV, decrypt, and fail loudly if altered', () => {
  const blob = crypto.encryptSecret('JBSWY3DPEHPK3PXP');
  assert.notEqual(blob, crypto.encryptSecret('JBSWY3DPEHPK3PXP'));
  assert.equal(crypto.decryptSecret(blob), 'JBSWY3DPEHPK3PXP');
  const parts = blob.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => crypto.decryptSecret(parts.join(':')));
  assert.throws(() => crypto.decryptSecret('v2:a:b:c'));
});

test('safeEqual and tokens', () => {
  assert.equal(crypto.safeEqual('abc', 'abc'), true);
  assert.equal(crypto.safeEqual('abc', 'abd'), false);
  assert.equal(crypto.safeEqual('abc', 'abcd'), false);
  assert.notEqual(crypto.randomToken(), crypto.randomToken());
  assert.equal(crypto.randomToken(32).length, 43);
  assert.equal(crypto.sha256('x').length, 64);
});

// ---- TOTP, against the published test vectors --------------------------------

test('HOTP matches RFC 4226 appendix D', () => {
  const secret = Buffer.from('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(totp.hotp(secret, counter), code, `counter ${counter}`));
});

test('TOTP matches RFC 6238 appendix B (SHA-1; last six digits of the 8-digit vectors)', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
  for (const [seconds, code] of vectors) assert.equal(totp.totpAt(secret, seconds * 1000), code, `t=${seconds}`);
});

test('base32 round-trips and tolerates spaces/case/padding', () => {
  for (const len of [1, 5, 10, 20, 33]) {
    const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256));
    assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  }
  assert.equal(totp.base32Decode('jbsw y3dp ehpk 3pxp==').toString(), 'Hello!Þ­¾ï'.slice(0, 0) + totp.base32Decode('JBSWY3DPEHPK3PXP').toString());
  assert.throws(() => totp.base32Decode('not*base32'));
  assert.match(totp.generateSecret(), /^[A-Z2-7]{32}$/);
});

test('verifyTotp: ±1 step window, malformed codes, and replay protection', () => {
  const secret = totp.generateSecret();
  const now = 1_700_000_000_000;
  const step = totp.stepAt(now);
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now), { ms: now }), step);
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now - 30_000), { ms: now }), step - 1);
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now + 30_000), { ms: now }), step + 1);
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now - 90_000), { ms: now }), null, 'too old');
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now), { ms: now, lastUsedStep: step }), null, 'replay');
  assert.equal(totp.verifyTotp(secret, totp.totpAt(secret, now - 30_000), { ms: now, lastUsedStep: step }), null, 'older than the last used step');
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '12 34 5']) assert.equal(totp.verifyTotp(secret, bad, { ms: now }), null, String(bad));
  assert.equal(totp.verifyTotp(secret, ` ${totp.totpAt(secret, now).slice(0, 3)} ${totp.totpAt(secret, now).slice(3)} `, { ms: now }), step, 'spaces in the middle are fine');
});

test('otpauth URL and recovery codes', () => {
  const url = totp.otpauthUrl({ secret: 'ABCDEFGH', account: 'a+b@example.com' });
  assert.equal(url, 'otpauth://totp/HomeVault:a%2Bb%40example.com?secret=ABCDEFGH&issuer=HomeVault&algorithm=SHA1&digits=6&period=30');
  const codes = totp.generateRecoveryCodes(10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c) && !/[ilo01]/.test(c.replace('-', ''))));
  assert.equal(totp.normalizeRecoveryCode(' ABCDE-fghjk '), 'abcdefghjk');
});

// ---- throttle & policy --------------------------------------------------------

test('FailureThrottle blocks after the limit, reports retry time, forgets after the window, and bounds memory', () => {
  const th = new FailureThrottle({ limit: 3, windowMs: 1000, maxKeys: 3 });
  const t0 = 10_000;
  assert.equal(th.check('a', t0).blocked, false);
  th.fail('a', t0); th.fail('a', t0 + 100); th.fail('a', t0 + 200);
  const gate = th.check('a', t0 + 300);
  assert.equal(gate.blocked, true);
  assert.equal(gate.retryAfterSeconds, 1);
  assert.equal(th.check('b', t0 + 300).blocked, false, 'keys are independent');
  assert.equal(th.check('a', t0 + 999).blocked, true, 'still inside the window');
  assert.equal(th.check('a', t0 + 1001).blocked, false, 'the oldest failure aged out, leaving two (sliding window)');
  th.fail('a', t0 + 2000); th.reset('a');
  assert.equal(th.hits.has('a'), false);
  ['k1', 'k2', 'k3', 'k4', 'k5'].forEach((k) => th.fail(k, t0));
  assert.ok(th.hits.size <= 3, 'oldest keys are evicted');
});

test('password policy', () => {
  const ctx = { email: 'jordan.smith@example.com', name: 'Jordan Smith' };
  assert.equal(passwordProblem('correct-horse-battery', ctx), null);
  assert.equal(passwordProblem('日本語のパスワードです長い', ctx), null, 'non-latin passwords are fine');
  assert.match(passwordProblem('short', ctx), /at least 10/);
  assert.match(passwordProblem('x'.repeat(300), ctx), /at most/);
  for (const weak of ['password123', 'Password-1234', '1234567890', 'qwertyuiop', 'aaaaaaaaaaaa', 'abcdefghijkl', '9876543210', 'IloveYou12!']) {
    assert.match(passwordProblem(weak, ctx) ?? '', /common|predictable/, weak);
  }
  assert.match(passwordProblem('jordan-is-great-1', ctx), /name or email/);
  assert.match(passwordProblem('smith-family-2026', ctx), /name or email/);
  assert.equal(passwordProblem(12345678901, ctx), 'Password is required');
});
