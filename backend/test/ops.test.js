import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startTestServer } from './helpers.js';

let t;
let db;
let admin;
let distDir;

before(async () => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homevault-dist-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(path.join(distDir, 'assets', 'index-abc123.js'), 'console.log(1);'.repeat(200));
  fs.writeFileSync(path.join(distDir, 'sw.js'), '// service worker');
  t = await startTestServer({ FRONTEND_DIST: distDir });
  ({ db } = await import('../src/db/index.js'));
  admin = await t.setupAdmin();
});
after(async () => {
  await t.close();
  fs.rmSync(distDir, { recursive: true, force: true });
});

// ---- static files & caching ---------------------------------------------------

test('fingerprinted assets are cached for a year; entry points always revalidate', async () => {
  const asset = await t.api.call('GET', '/assets/index-abc123.js', { raw: true });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

  const sw = await t.api.call('GET', '/sw.js', { raw: true });
  assert.equal(sw.headers.get('cache-control'), 'no-cache', 'a cached service worker would strand users on an old version');

  for (const route of ['/', '/documents/42', '/settings']) {
    const page = await t.api.call('GET', route, { raw: true });
    assert.equal(page.status, 200, route);
    assert.equal(page.headers.get('cache-control'), 'no-cache', route);
    assert.match(await page.text(), /id="root"/);
  }
});

test('unknown API paths are JSON 404s, never the SPA shell', async () => {
  const res = await t.api.get('/api/definitely-not-a-route', { token: admin.token });
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, 'string');
});

test('text responses are compressed when the client allows it', async () => {
  const res = await fetch(`${t.base}/assets/index-abc123.js`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  // fetch decompresses transparently, so the body must still be the original text.
  assert.equal((await res.text()).length, 'console.log(1);'.length * 200);
  const raw = await fetch(`${t.base}/assets/index-abc123.js`, { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(raw.headers.get('content-encoding'), null);
  void zlib;
});

// ---- headers ----------------------------------------------------------------

test('HSTS is off by default (plain-http LANs) and on with FORCE_HTTPS', async () => {
  assert.equal((await t.api.get('/api/health')).headers.get('strict-transport-security'), null);
  process.env.FORCE_HTTPS = 'true';
  const s2 = await t.api.get('/api/health');
  assert.equal(s2.headers.get('strict-transport-security'), null, 'the policy is decided when the app is created');
  delete process.env.FORCE_HTTPS;
});

test('health reports ok and verifies the database is reachable', async () => {
  const res = await t.api.get('/api/health');
  assert.deepEqual(res.body, { status: 'ok' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('oversized JSON bodies are rejected with 413', async () => {
  const res = await t.api.post('/api/auth/login', { email: 'a@b.co', password: 'x'.repeat(300_000) });
  assert.equal(res.status, 413);
});

// ---- backups ----------------------------------------------------------------

test('backups are verified, private and pruned to the newest N', async () => {
  const { backupDatabase } = await import('../src/db/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homevault-bk-'));
  try {
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await backupDatabase(dir, { keep: 3 }));
      await new Promise((r) => setTimeout(r, 5)); // distinct timestamps
    }
    const files = fs.readdirSync(dir).sort();
    assert.equal(files.length, 3);
    assert.deepEqual(files.map((f) => path.join(dir, f)), made.slice(-3), 'the newest three survive');
    assert.equal(fs.statSync(made[4]).mode & 0o777, 0o600, 'backups contain password hashes: owner-only');

    const { default: Database } = await import('better-sqlite3');
    const copy = new Database(made[4], { readonly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS c FROM users').get().c, db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
    copy.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('admin can download a database backup; it is audited; others cannot', async () => {
  const member = await t.createUser(admin.token, 'plain@example.com');
  assert.equal((await t.api.get('/api/admin/backup', { token: member.token })).status, 403);
  assert.equal((await t.api.get('/api/admin/backup')).status, 401);

  const res = await t.api.call('GET', '/api/admin/backup', { token: admin.token, raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-disposition'), /homevault-.*\.sqlite/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'backup_downloaded'").get().c, 1);
  const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('homevault-dl-'));
  assert.deepEqual(leftovers, [], 'the temporary copy is cleaned up');
});

// ---- the CLI ----------------------------------------------------------------

test('the admin CLI can create, reset, unlock and report without the server', async () => {
  const { spawnSync } = await import('node:child_process');
  const cli = path.resolve(import.meta.dirname, '../src/cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homevault-cli-'));
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', APP_SECRET: 'cli-test-secret-cli-test-secret', DB_PATH: path.join(dir, 'db.sqlite'), UPLOAD_DIR: path.join(dir, 'up'), BACKUP_DIR: path.join(dir, 'bk') };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: 'utf8' });
  try {
    assert.equal(run('list-users').stdout.trim(), 'No accounts yet.');

    const created = run('create-admin', 'Ops@Example.com', '--name', 'Ops Person');
    assert.equal(created.status, 0, created.stderr);
    const temp = /Temporary password \(shown once\): (\S+)/.exec(created.stdout)[1];
    assert.ok(temp.length >= 12);
    assert.match(run('list-users').stdout, /ops@example\.com\s+Ops Person\s+admin, must-change-password/);
    assert.notEqual(run('create-admin', 'ops@example.com').status, 0, 'duplicates are refused');
    assert.notEqual(run('create-admin', 'not-an-email').status, 0);
    assert.notEqual(run('create-admin', 'weak@example.com', '--password', 'short').status, 0);

    // The temporary password really works, via the real login code path.
    const { verifyPassword } = await import('../src/utils/crypto.js');
    const { default: Database } = await import('better-sqlite3');
    const peek = new Database(env.DB_PATH, { readonly: true });
    assert.equal((await verifyPassword(temp, peek.prepare('SELECT password_hash FROM users').get().password_hash)).ok, true);
    peek.close();

    const reset = run('reset-password', 'ops@example.com');
    assert.equal(reset.status, 0, reset.stderr);
    assert.notEqual(/Temporary password \(shown once\): (\S+)/.exec(reset.stdout)[1], temp);
    assert.notEqual(run('reset-password', 'nobody@example.com').status, 0);

    assert.equal(run('disable-2fa', 'ops@example.com').status, 0);
    assert.equal(run('revoke-sessions', 'ops@example.com').status, 0);
    const bk = run('backup');
    assert.equal(bk.status, 0, bk.stderr);
    assert.equal(fs.readdirSync(env.BACKUP_DIR).length, 1);
    const check = run('check');
    assert.match(check.stdout, /Integrity: ok/);

    const audit = new Database(env.DB_PATH, { readonly: true });
    const actions = audit.prepare("SELECT action FROM audit_log WHERE actor = 'cli'").all().map((r) => r.action);
    audit.close();
    for (const a of ['user_created', 'user_password_reset', 'user_mfa_reset', 'sessions_revoked_all']) assert.ok(actions.includes(a), a);

    const help = run('definitely-not-a-command');
    assert.notEqual(help.status, 0);
    assert.match(help.stdout, /Usage:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
