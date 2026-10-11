import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;

before(async () => {
  t = await startTestServer({ LOGIN_RATE_LIMIT: '4' });
  await t.setupAdmin('admin@example.com', 'correct-horse-battery');
});
after(() => t.close());

test('repeated failed logins are throttled with a 429 JSON error', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await t.api.post('/api/auth/login', { email: 'admin@example.com', password: 'wrong-wrong-wrong' });
    statuses.push(res.status);
    if (res.status === 429) assert.ok(res.body.error);
  }
  assert.ok(statuses.includes(401));
  assert.ok(statuses.includes(429), `expected a 429 in ${statuses}`);
  assert.equal(statuses.at(-1), 429);
});

test('throttling does not affect other API routes', async () => {
  const res = await t.api.get('/api/health');
  assert.equal(res.status, 200);
});
