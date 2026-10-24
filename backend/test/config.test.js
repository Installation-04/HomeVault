import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configProblems, assertConfig, PLACEHOLDER_SECRET } from '../src/config.js';

const prod = (extra = {}) => ({ NODE_ENV: 'production', ...extra });

test('production requires a real secret (APP_SECRET, or the legacy JWT_SECRET name)', () => {
  assert.equal(configProblems(prod()).length, 1);
  assert.equal(configProblems(prod({ JWT_SECRET: PLACEHOLDER_SECRET })).length, 1);
  assert.equal(configProblems(prod({ JWT_SECRET: 'too-short' })).length, 1);
  assert.deepEqual(configProblems(prod({ JWT_SECRET: 'a'.repeat(32) })), [], 'existing deployments keep working');
  assert.deepEqual(configProblems(prod({ APP_SECRET: 'b'.repeat(32) })), []);
  assert.equal(configProblems(prod({ APP_SECRET: PLACEHOLDER_SECRET })).length, 1);
  assert.equal(configProblems(prod({ APP_SECRET: 'b'.repeat(32), DATA_KEY: 'short' })).length, 1);
  assert.equal(configProblems(prod({ APP_SECRET: 'b'.repeat(32), SETUP_TOKEN: 'abc' })).length, 1);
});

test('assertConfig throws a readable error in production and is lenient in dev', () => {
  assert.throws(() => assertConfig(prod()), /APP_SECRET/);
  assert.doesNotThrow(() => assertConfig(prod({ JWT_SECRET: 'x'.repeat(40) })));
  assert.doesNotThrow(() => assertConfig({ NODE_ENV: 'development' }));
  assert.doesNotThrow(() => assertConfig({}));
});

test('numeric/boolean-ish env values are validated', () => {
  const ok = prod({ JWT_SECRET: 'x'.repeat(40) });
  assert.deepEqual(configProblems({ ...ok, PORT: '4000', EXPIRY_NOTICE_DAYS: '30' }), []);
  assert.equal(configProblems({ ...ok, PORT: 'abc' }).length, 1);
  assert.equal(configProblems({ ...ok, EXPIRY_NOTICE_DAYS: '-1' }).length, 1);
  assert.equal(configProblems({ ...ok, SESSION_DAYS: '0' }).length, 1);
  assert.equal(configProblems({ ...ok, COOKIE_SECURE: 'sometimes' }).length, 1);
  assert.deepEqual(configProblems({ ...ok, COOKIE_SECURE: 'always', SESSION_DAYS: '7', BACKUP_KEEP: '30' }), []);
});

test('the server process refuses to boot in production with the placeholder secret', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'homevault-boot-')); // no .env here for dotenv to find
  const serverJs = path.resolve(import.meta.dirname, '../src/server.js');
  try {
    const run = (env) =>
      spawnSync(process.execPath, [serverJs], { cwd, env: { PATH: process.env.PATH, PORT: '0', ...env }, encoding: 'utf8', timeout: 8000 });

    const bad = run({ NODE_ENV: 'production', JWT_SECRET: PLACEHOLDER_SECRET });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /APP_SECRET/);
    assert.ok(!fs.existsSync(path.join(cwd, 'data')), 'must fail before creating the database');

    const missing = run({ NODE_ENV: 'production' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /not set/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
