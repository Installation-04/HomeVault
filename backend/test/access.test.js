import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let alice; // regular user who owns property P
let bob; // regular user, initially no access
let P;

before(async () => {
  t = await startTestServer();
  admin = await t.setupAdmin();
  alice = await t.createUser(admin.token, 'alice@example.com');
  bob = await t.createUser(admin.token, 'bob@example.com');
  P = await t.createProperty(alice.token, 'Alice House');
});
after(() => t.close());

const withProp = (extra = {}) => ({ property_id: P.id, ...extra });

test('a user without access gets 403 on every property-scoped resource', async () => {
  const token = bob.token;
  assert.equal((await t.api.get(`/api/properties/${P.id}`, { token })).status, 403);
  assert.equal((await t.api.get(`/api/equipment/property/${P.id}`, { token })).status, 403);
  assert.equal((await t.api.get(`/api/documents/property/${P.id}`, { token })).status, 403);
  assert.equal((await t.api.get(`/api/reminders/property/${P.id}`, { token })).status, 403);
  assert.equal((await t.api.get(`/api/expenses/property/${P.id}`, { token })).status, 403);
  assert.equal((await t.api.get(`/api/calendar/property/${P.id}`, { token })).status, 403);
  assert.equal((await t.api.get(`/api/export/property/${P.id}/bundle.zip`, { token })).status, 403);
  assert.equal((await t.api.post('/api/equipment', withProp({ name: 'Fridge' }), { token })).status, 403);

  const list = await t.api.get('/api/properties', { token });
  assert.deepEqual(list.body, []);
});

test('viewers can read but not write; owners can do both', async () => {
  const share = await t.api.post(`/api/properties/${P.id}/share`, { email: 'bob@example.com', role: 'viewer' }, { token: alice.token });
  assert.equal(share.status, 204);

  const eq = await t.api.post('/api/equipment', withProp({ name: 'Furnace' }), { token: alice.token });
  assert.equal(eq.status, 201);

  assert.equal((await t.api.get(`/api/equipment/property/${P.id}`, { token: bob.token })).status, 200);
  assert.equal((await t.api.get(`/api/equipment/${eq.body.id}`, { token: bob.token })).status, 200);
  assert.equal((await t.api.post('/api/equipment', withProp({ name: 'Nope' }), { token: bob.token })).status, 403);
  assert.equal((await t.api.put(`/api/equipment/${eq.body.id}`, { name: 'Hacked' }, { token: bob.token })).status, 403);
  assert.equal((await t.api.del(`/api/equipment/${eq.body.id}`, { token: bob.token })).status, 403);
  assert.equal((await t.api.put(`/api/properties/${P.id}`, { name: 'Mine now' }, { token: bob.token })).status, 403);

  const rem = await t.api.post('/api/reminders', withProp({ title: 'Change filter', due_date: '2030-01-01' }), { token: alice.token });
  assert.equal(rem.status, 201);
  assert.equal((await t.api.post('/api/reminders', withProp({ title: 'x', due_date: '2030-01-01' }), { token: bob.token })).status, 403);
  // Viewers may tick things off.
  assert.equal((await t.api.post(`/api/reminders/${rem.body.id}/complete`, {}, { token: bob.token })).status, 200);
});

test('members: owner can list and revoke; viewer cannot; last owner is protected', async () => {
  const asViewer = await t.api.get(`/api/properties/${P.id}/members`, { token: bob.token });
  assert.equal(asViewer.status, 403);

  const list = await t.api.get(`/api/properties/${P.id}/members`, { token: alice.token });
  assert.equal(list.status, 200);
  const byEmail = Object.fromEntries(list.body.map((m) => [m.email, m.role]));
  assert.deepEqual(byEmail, { 'alice@example.com': 'owner', 'bob@example.com': 'viewer' });
  assert.ok(list.body.every((m) => !('password_hash' in m)));

  // Cannot remove the only owner.
  const lastOwner = await t.api.del(`/api/properties/${P.id}/members/${alice.user.id}`, { token: alice.token });
  assert.equal(lastOwner.status, 400);

  const revoke = await t.api.del(`/api/properties/${P.id}/members/${bob.user.id}`, { token: alice.token });
  assert.equal(revoke.status, 204);
  assert.equal((await t.api.get(`/api/equipment/property/${P.id}`, { token: bob.token })).status, 403);
});

test('sharing with an unknown email -> 404; unknown roles fall back to viewer', async () => {
  const unknown = await t.api.post(`/api/properties/${P.id}/share`, { email: 'nobody@example.com' }, { token: alice.token });
  assert.equal(unknown.status, 404);

  await t.api.post(`/api/properties/${P.id}/share`, { email: 'bob@example.com', role: 'superuser' }, { token: alice.token });
  const list = await t.api.get(`/api/properties/${P.id}/members`, { token: alice.token });
  assert.equal(list.body.find((m) => m.email === 'bob@example.com').role, 'viewer');
});

test('the property list reports the caller\'s role for each property', async () => {
  const asOwner = await t.api.get('/api/properties', { token: alice.token });
  assert.equal(asOwner.body.find((p) => p.id === P.id).role, 'owner');

  await t.api.post(`/api/properties/${P.id}/share`, { email: 'bob@example.com', role: 'viewer' }, { token: alice.token });
  const asViewer = await t.api.get('/api/properties', { token: bob.token });
  assert.equal(asViewer.body.find((p) => p.id === P.id).role, 'viewer');

  const asAdmin = await t.api.get('/api/properties', { token: admin.token });
  assert.equal(asAdmin.body.find((p) => p.id === P.id).role, 'owner');
});

test('property update requires a name; admins can see all properties', async () => {
  const bad = await t.api.put(`/api/properties/${P.id}`, { address: '1 Main St' }, { token: alice.token });
  assert.equal(bad.status, 400);

  const all = await t.api.get('/api/properties', { token: admin.token });
  assert.ok(all.body.some((p) => p.id === P.id));
});
