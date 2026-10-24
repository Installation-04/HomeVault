import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve(import.meta.dirname, '../src/cli.js');
let dir;
let env;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homevault-cli-'));
  env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    APP_SECRET: 'cli-test-secret-cli-test-secret',
    DB_PATH: path.join(dir, 'data', 'db.sqlite'),
    UPLOAD_DIR: path.join(dir, 'data', 'uploads'),
    BACKUP_DIR: path.join(dir, 'data', 'backups'),
  };
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8', timeout: 20000 });

test('create-admin --password-stdin takes the password from standard input, not the command line', () => {
  const ok = run(['create-admin', 'owner@example.com', '--name', 'House Owner', '--password-stdin'], 'orbit-lantern-maple-71\n');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Administrator created: owner@example\.com/);
  assert.doesNotMatch(ok.stdout, /Temporary password/, 'a chosen password is not echoed or forced to change');
  assert.ok(!ok.stdout.includes('orbit-lantern-maple-71'));

  const users = run(['list-users']);
  assert.match(users.stdout, /owner@example\.com\s+House Owner\s+admin/);
  assert.doesNotMatch(users.stdout, /must-change-password/);
});

test('a weak password from standard input is refused with the policy message', () => {
  const bad = run(['create-admin', 'weak@example.com', '--password-stdin'], 'password123\n');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /too common|at least/);
  assert.doesNotMatch(run(['list-users']).stdout, /weak@example\.com/);
});
