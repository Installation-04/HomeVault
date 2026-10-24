import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.close());

// Two people (or a person and a bot) hitting /setup at the same moment on an
// empty instance: exactly one may become the admin.
test('simultaneous first-run setups: exactly one wins', async () => {
  const results = await Promise.all(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((n) =>
      t.api.post('/api/auth/setup', { email: `${n}-user@example.com`, password: 'correct-horse-battery', name: `Person ${n}` })
    )
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 403));
  const { db } = await import('../src/db/index.js');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 1);
});
