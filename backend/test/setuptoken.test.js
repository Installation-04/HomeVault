import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;

before(async () => {
  t = await startTestServer({ SETUP_TOKEN: 'launch-code-4242' });
});
after(() => t.close());

const body = (extra = {}) => ({ email: 'owner@example.com', password: 'correct-horse-battery', name: 'Owner', ...extra });

test('status tells the UI that a setup token is required', async () => {
  assert.deepEqual((await t.api.get('/api/auth/status')).body, { needs_setup: true, setup_token_required: true });
});

test('a stranger who reaches the empty instance cannot claim the admin account', async () => {
  for (const attempt of [undefined, '', 'wrong-code', 'launch-code-424', 'launch-code-42420']) {
    const res = await t.api.post('/api/auth/setup', body(attempt === undefined ? {} : { setup_token: attempt }));
    assert.equal(res.status, 403, String(attempt));
    assert.equal(res.body.code, 'setup_token');
    assert.equal(res.cookie, null);
  }
  assert.deepEqual((await t.api.get('/api/auth/status')).body.needs_setup, true, 'still unclaimed');
});

test('the right token creates the admin; the token is useless afterwards', async () => {
  const ok = await t.api.post('/api/auth/setup', body({ setup_token: 'launch-code-4242' }));
  assert.equal(ok.status, 201);
  assert.ok(ok.cookie);
  const again = await t.api.post('/api/auth/setup', body({ email: 'second@example.com', setup_token: 'launch-code-4242' }));
  assert.equal(again.status, 403);
  assert.deepEqual((await t.api.get('/api/auth/status')).body, { needs_setup: false, setup_token_required: false });
});

test('failed setup attempts are audited', async () => {
  const { db } = await import('../src/db/index.js');
  const rows = db.prepare("SELECT detail FROM audit_log WHERE action = 'setup_failed'").all();
  assert.ok(rows.length >= 5);
  assert.ok(rows.every((r) => !r.detail.includes('wrong-code') && !r.detail.includes('launch-code')));
});
