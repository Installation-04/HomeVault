import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from './helpers.js';

let t;
let admin;
let owner; // owns property P
let stranger; // no access
let viewer;
let P;

before(async () => {
  t = await startTestServer();
  admin = await t.setupAdmin();
  owner = await t.createUser(admin.token, 'owner@example.com');
  stranger = await t.createUser(admin.token, 'stranger@example.com');
  viewer = await t.createUser(admin.token, 'viewer@example.com');
  P = await t.createProperty(owner.token, 'Owner House');
  await t.api.post(`/api/properties/${P.id}/share`, { email: viewer.email, role: 'viewer' }, { token: owner.token });
});
after(() => t.close());

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

test('path traversal via property_id is rejected and nothing is written outside UPLOAD_DIR', async () => {
  const escaped = path.join(t.dir, 'escaped');
  const form = t.uploadForm({ property_id: '../../escaped', title: 'evil' });
  const res = await t.api.call('POST', '/api/documents', { token: stranger.token, form });
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  assert.equal(fs.existsSync(escaped), false, 'directory was created outside the upload dir');
  assert.deepEqual(t.listFiles(t.dir).filter((f) => !f.endsWith('.sqlite') && !f.includes('.sqlite-')), []);
});

test('a non-numeric property_id is a 400', async () => {
  const form = t.uploadForm({ property_id: 'abc' });
  const res = await t.api.call('POST', '/api/documents', { token: owner.token, form });
  assert.equal(res.status, 400);
});

test('rejected uploads (no access / viewer) leave no orphan files on disk', async () => {
  const asStranger = await t.api.call('POST', '/api/documents', {
    token: stranger.token,
    form: t.uploadForm({ property_id: String(P.id) }),
  });
  assert.equal(asStranger.status, 403);

  const asViewer = await t.api.call('POST', '/api/documents', {
    token: viewer.token,
    form: t.uploadForm({ property_id: String(P.id) }),
  });
  assert.equal(asViewer.status, 403);

  assert.deepEqual(t.listFiles(t.uploadDir), []);
});

test('owner upload -> stored under the property folder, downloadable, removed from disk on delete', async () => {
  const res = await t.api.call('POST', '/api/documents', {
    token: owner.token,
    form: t.uploadForm({ property_id: String(P.id), title: 'Warranty', category: 'warranty' }, 'warranty.txt', 'hello world'),
  });
  assert.equal(res.status, 201);
  const doc = res.body;
  assert.equal(doc.title, 'Warranty');

  const files = t.listFiles(t.uploadDir);
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith(path.join(t.uploadDir, String(P.id)) + path.sep), files[0]);

  const dl = await t.api.call('GET', `/api/documents/${doc.id}/download`, { token: owner.token, raw: true });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'hello world');

  // Browser <a href> downloads can't set headers, so ?token= must work here.
  const viaQuery = await t.api.call('GET', `/api/documents/${doc.id}/download?token=${owner.token}`, { raw: true });
  assert.equal(viaQuery.status, 200);

  assert.equal((await t.api.call('GET', `/api/documents/${doc.id}/download`, { token: stranger.token })).status, 403);

  assert.equal((await t.api.del(`/api/documents/${doc.id}`, { token: owner.token })).status, 204);
  assert.deepEqual(t.listFiles(t.uploadDir), []);
});

test('equipment photos: only images are accepted, served with a safe content type', async () => {
  const eq = await t.api.post('/api/equipment', { property_id: P.id, name: 'Dishwasher' }, { token: owner.token });
  assert.equal(eq.status, 201);

  const html = new FormData();
  html.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
  const bad = await t.api.call('POST', `/api/equipment/${eq.body.id}/photos`, { token: owner.token, form: html });
  assert.equal(bad.status, 400);
  assert.deepEqual(t.listFiles(t.uploadDir), [], 'rejected photo must not stay on disk');

  const good = new FormData();
  good.append('file', new Blob([png], { type: 'image/png' }), 'pic.png');
  const ok = await t.api.call('POST', `/api/equipment/${eq.body.id}/photos`, { token: owner.token, form: good });
  assert.equal(ok.status, 201);

  const served = await t.api.call('GET', `/api/equipment/${eq.body.id}/photos/${ok.body.id}?token=${owner.token}`, { raw: true });
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type'), /^image\/png/);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
});

test('deleting a property removes its files from disk', async () => {
  const before = t.listFiles(t.uploadDir).length; // earlier tests leave property P's photo behind
  const Q = await t.createProperty(owner.token, 'Doomed');
  const up = await t.api.call('POST', '/api/documents', {
    token: owner.token,
    form: t.uploadForm({ property_id: String(Q.id) }, 'doomed.txt'),
  });
  assert.equal(up.status, 201);

  const eq = await t.api.post('/api/equipment', { property_id: Q.id, name: 'Heater' }, { token: owner.token });
  const photo = new FormData();
  photo.append('file', new Blob([png], { type: 'image/png' }), 'p.png');
  assert.equal((await t.api.call('POST', `/api/equipment/${eq.body.id}/photos`, { token: owner.token, form: photo })).status, 201);
  assert.equal(t.listFiles(t.uploadDir).length, before + 2);

  assert.equal((await t.api.del(`/api/properties/${Q.id}`, { token: owner.token })).status, 204);
  assert.equal(t.listFiles(t.uploadDir).length, before);
});
