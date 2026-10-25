import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startTestServer } from './helpers.js';

// A stand-in SimpleFIN Bridge. The test decides what it answers and can see what it was asked.
const USER = 'user1';
const PASS = 'pa/ss:word+1'; // awkward on purpose: must survive percent-encoding in the access address
let bridge;
let elsewhere; // a second host, to prove credentials are not replayed on a redirect
let state;
let elsewhereAuth;

const now = () => Math.floor(Date.now() / 1000);
const accountsBody = (withTx) => ({
  errors: ['Connection to Example Bank may need attention.'],
  accounts: [
    {
      org: { name: 'Example Bank', domain: 'example.test' },
      id: 'ACC-CHQ',
      name: 'Joint chequing',
      currency: 'CAD',
      balance: '1234.56',
      transactions: withTx
        ? [
            { id: 'T1', posted: now() - 2 * 86400, amount: '-182.40', description: 'HYDRO-QUEBEC' },
            { id: 'T2', posted: now() - 3 * 86400, amount: '40.00', description: 'Intact Insurance refund' },
            { id: 'T3', posted: now() - 4 * 86400, amount: '-54.10', description: 'GROCERY STORE #12' },
            { id: 'TP', posted: 0, amount: '-9.99', description: 'Still pending', pending: true },
            { id: 'BAD', posted: now(), amount: 'NaN', description: 'Garbage amount' },
          ]
        : [],
    },
    {
      org: { name: 'Example Bank' },
      id: 'ACC-CARD',
      name: 'Visa',
      currency: 'CAD',
      balance: '-300.00',
      transactions: withTx ? [{ id: 'C1', posted: now() - 86400, amount: '-120.00', description: 'RONA QUEBEC' }] : [],
    },
  ],
});

let t;
let admin;
let viewer;
let stranger;
let property;
let db;
let service;
let simplefin;

const tokenFor = (name) => Buffer.from(`http://127.0.0.1:${bridge.address().port}/simplefin/claim/${name}`).toString('base64');
const create = (body = {}, token = admin.token) =>
  t.api.post('/api/integrations', { property_id: property.id, type: 'simplefin', name: 'Bank', setup_token: tokenFor(`TOKEN-${++state.tokenCounter}`), ...body }, { token });
const list = async () => (await t.api.get(`/api/integrations/property/${property.id}`, { token: admin.token })).body.integrations;
const inbox = () => db.prepare('SELECT * FROM bank_transactions WHERE property_id = ? ORDER BY posted_date, id').all(property.id);

before(async () => {
  bridge = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? null });
    if (req.method === 'POST' && url.pathname.startsWith('/simplefin/claim/')) {
      const token = url.pathname.split('/').pop();
      if (state.claimed.has(token) || state.rejectClaims) {
        res.writeHead(403);
        return res.end('nope');
      }
      state.claimed.add(token);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(`http://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:${bridge.address().port}/simplefin`);
    }
    if (url.pathname === '/simplefin/accounts') {
      const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
      if (state.mode === 'redirect-away') {
        res.writeHead(302, { Location: `http://localhost:${elsewhere.address().port}/steal` });
        return res.end();
      }
      if (req.headers.authorization !== expected || state.mode === 'forbidden') {
        res.writeHead(403);
        return res.end('forbidden');
      }
      if (state.mode === 'rate') {
        res.writeHead(429);
        return res.end();
      }
      if (state.mode === 'garbage') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('<html>maintenance</html>');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(accountsBody(url.searchParams.get('balances-only') !== '1')));
    }
    res.writeHead(404);
    res.end();
  });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');

  elsewhere = http.createServer((req, res) => {
    elsewhereAuth.push(req.headers.authorization ?? null);
    res.writeHead(200);
    res.end('{}');
  });
  elsewhere.listen(0, '127.0.0.1');
  await once(elsewhere, 'listening');

  t = await startTestServer({ INTEGRATIONS_ALLOW_PRIVATE_HOSTS: 'true' });
  ({ db } = await import('../src/db/index.js'));
  service = await import('../src/integrations/service.js');
  simplefin = await import('../src/integrations/bank/simplefin.js');
  admin = await t.setupAdmin();
  viewer = await t.createUser(admin.token, 'viewer@example.com');
  stranger = await t.createUser(admin.token, 'stranger@example.com');
  property = await t.createProperty(admin.token, 'Maple House');
  await t.api.post(`/api/properties/${property.id}/share`, { email: 'viewer@example.com', role: 'viewer' }, { token: admin.token });
});

beforeEach(() => {
  state = { requests: [], claimed: new Set(), mode: 'ok', rejectClaims: false, tokenCounter: state?.tokenCounter ?? 0 };
  elsewhereAuth = [];
  db.prepare('DELETE FROM integrations').run();
  db.prepare('DELETE FROM bank_transactions').run();
});

after(async () => {
  bridge.close();
  elsewhere.close();
  bridge.closeAllConnections?.();
  elsewhere.closeAllConnections?.();
  await t.close();
});

// ---------------------------------------------------------------- reading what a person pastes

test('setup tokens: only real-looking ones are accepted, and plain http needs the LAN opt-in', () => {
  const good = simplefin.readSetupInput(Buffer.from('http://127.0.0.1:9/simplefin/claim/ABC').toString('base64'));
  assert.equal(good.claim_url, 'http://127.0.0.1:9/simplefin/claim/ABC');

  for (const bad of ['', '   ', 'hello world', 'aGVsbG8=', Buffer.from('https://example.com/not-a-claim').toString('base64'), Buffer.from('file:///etc/passwd').toString('base64'), Buffer.from('javascript:alert(1)').toString('base64'), 'x'.repeat(5000)]) {
    assert.throws(() => simplefin.readSetupInput(bad), (e) => e.status === 400 && e.code === 'bad_token', JSON.stringify(bad).slice(0, 40));
  }

  process.env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS = 'false';
  try {
    assert.throws(() => simplefin.readSetupInput(Buffer.from('http://bridge.example.com/simplefin/claim/ABC').toString('base64')), (e) => e.code === 'bad_url', 'http is refused');
    assert.throws(() => simplefin.readSetupInput(Buffer.from('https://127.0.0.1/simplefin/claim/ABC').toString('base64')), (e) => e.code === 'private_address', 'private networks are refused');
    assert.equal(simplefin.readSetupInput(Buffer.from('https://bridge.example.com/simplefin/claim/ABC').toString('base64')).claim_url, 'https://bridge.example.com/simplefin/claim/ABC');
  } finally {
    process.env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS = 'true';
  }
});

test('access addresses: credentials are split out (and decoded), a bare address is refused', () => {
  const a = simplefin.parseAccessUrl('https://u%40x:p%2Fw@bridge.example.com/simplefin/');
  // (https passes either policy; the host name is not resolved here)
  assert.deepEqual(a, { base: 'https://bridge.example.com/simplefin', username: 'u@x', password: 'p/w' });
  assert.throws(() => simplefin.parseAccessUrl('https://bridge.example.com/simplefin'), (e) => e.code === 'bad_token');
  assert.throws(() => simplefin.parseAccessUrl('not a url'), (e) => e.code === 'bad_token');
});

test('the bridge’s answer is read defensively', () => {
  const ok = simplefin.parseAccounts({
    errors: ['a'.repeat(500), 5, null],
    accounts: [
      { id: 'A', name: 'Chequing', currency: 'cad', org: { name: 'Bank' }, transactions: [{ id: '1', posted: 1_700_000_000, amount: '-12.345', description: '  Tim  Hortons ' }, { id: '2', posted: 0, amount: '1' }, { id: '3', posted: 5, amount: 'abc' }, { id: '4', posted: 5, amount: '1', pending: true }, { posted: 5, amount: '1' }, 'junk', null] },
      { name: 'No id' },
      null,
      { id: 'B', name: 'Gold', currency: 'https://example.com/custom-currency', transactions: 'not a list' },
    ],
  });
  assert.equal(ok.accounts.length, 2);
  assert.equal(ok.accounts[0].currency, 'CAD');
  assert.equal(ok.accounts[1].currency, null, 'a custom-currency URL is not a currency code');
  assert.equal(ok.accounts[0].transactions.length, 1);
  assert.deepEqual(ok.accounts[0].transactions[0], { external_id: '1', account_id: 'A', account: 'Bank · Chequing', posted_date: '2023-11-14', amount: -12.35, currency: 'CAD', description: 'Tim Hortons' });
  assert.equal(ok.messages.length, 1);
  assert.ok(ok.messages[0].length <= 200);

  for (const bad of [null, 'text', 42, {}, { accounts: 'x' }, []]) {
    assert.throws(() => simplefin.parseAccounts(bad), (e) => e.code === 'bad_response');
  }
});

// ---------------------------------------------------------------- connecting

test('connecting trades the token once, lists the accounts, and imports nothing yet', async () => {
  const res = await create();
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.type, 'simplefin');
  assert.equal(res.body.status, 'ok');
  assert.deepEqual(res.body.selected_accounts, []);
  assert.deepEqual(res.body.summary.accounts.map((a) => a.id), ['ACC-CHQ', 'ACC-CARD']);
  assert.equal(res.body.summary.selected, 0);
  assert.equal(res.body.interval_minutes, 720, 'twice a day by default: the bridge allows about 24 requests a day');
  assert.deepEqual(res.body.summary.messages, ['Connection to Example Bank may need attention.']);

  assert.equal(state.requests.filter((r) => r.method === 'POST').length, 1, 'the token is used once');
  const read = state.requests.find((r) => r.path === '/simplefin/accounts');
  assert.equal(read.query['balances-only'], '1', 'only the account list is asked for');
  assert.equal(read.query['start-date'], undefined);
  assert.equal(inbox().length, 0, 'no transactions are read before the owner chooses accounts');
});

test('secrets: the access address is encrypted at rest and never returned, logged or audited', async () => {
  const res = await create({ name: 'Joint account' });
  assert.equal(res.status, 201);
  const everything = JSON.stringify([res.body, (await list()), db.prepare('SELECT * FROM audit_log').all()]);
  for (const secret of [PASS, encodeURIComponent(PASS), USER, 'TOKEN-', Buffer.from(`${USER}:${PASS}`).toString('base64')]) {
    assert.equal(everything.includes(secret), false, `${secret} must not appear in API output or the audit log`);
  }
  const stored = db.prepare('SELECT config_enc FROM integrations').get().config_enc;
  for (const secret of [PASS, encodeURIComponent(PASS), USER, '127.0.0.1']) assert.equal(stored.includes(secret), false, 'config is encrypted');
  const logged = db.prepare("SELECT detail FROM audit_log WHERE action = 'integration_created' ORDER BY id DESC LIMIT 1").get();
  assert.ok(logged.detail.includes('simplefin') && logged.detail.includes('Joint account'));
});

test('a token the bridge refuses saves nothing and explains', async () => {
  state.rejectClaims = true;
  const res = await create();
  assert.equal(res.status, 400);
  assert.match(res.body.error, /works only once|did not accept/i);
  assert.equal((await list()).length, 0);
});

test('a form that is wrong in another way does not use up the one-time token', async () => {
  const tooOften = await create({ interval_minutes: 30 });
  assert.equal(tooOften.status, 400);
  assert.equal(state.requests.filter((r) => r.method === 'POST').length, 0, 'the bridge was never contacted');
  const notAToken = await create({ setup_token: 'hello' });
  assert.equal(notAToken.status, 400);
  assert.equal(state.requests.length, 0);
});

test('if the first read fails after the token was used, the connection is kept so the token is not wasted', async () => {
  state.mode = 'forbidden';
  const res = await create();
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'error');
  assert.match(res.body.last_error, /refused access/i);
  assert.equal((await list()).length, 1);
  // later, once the bridge works, a sync repairs it
  state.mode = 'ok';
  const row = db.prepare('SELECT id FROM integrations').get();
  const fixed = await service.syncIntegration(row.id);
  assert.equal(fixed.status, 'ok');
  assert.equal(fixed.summary.accounts.length, 2);
});

test('an access address pasted directly works too (token claimed elsewhere)', async () => {
  const access = `http://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:${bridge.address().port}/simplefin`;
  const res = await create({ setup_token: access });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(state.requests.filter((r) => r.method === 'POST').length, 0, 'nothing to claim');
  assert.equal(res.body.summary.accounts.length, 2);
});

// ---------------------------------------------------------------- choosing accounts and syncing

test('choosing accounts: only listed ones are accepted, and then transactions flow into the inbox', async () => {
  const created = (await create()).body;
  const bad = await t.api.patch(`/api/integrations/${created.id}`, { accounts: ['SOMETHING-ELSE'] }, { token: admin.token });
  assert.equal(bad.status, 400);
  assert.equal((await t.api.patch(`/api/integrations/${created.id}`, { accounts: 'ACC-CHQ' }, { token: admin.token })).status, 400);

  const chosen = await t.api.patch(`/api/integrations/${created.id}`, { accounts: ['ACC-CHQ'] }, { token: admin.token });
  assert.equal(chosen.status, 200);
  assert.deepEqual(chosen.body.selected_accounts, ['ACC-CHQ']);
  assert.equal(chosen.body.config_enc, undefined);

  state.requests.length = 0;
  const synced = await t.api.post(`/api/integrations/${created.id}/sync`, {}, { token: admin.token });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.summary.added, 3, 'pending and unreadable transactions are left out');
  assert.equal(synced.body.summary.selected, 1);

  const read = state.requests.find((r) => r.path === '/simplefin/accounts');
  assert.equal(read.query['balances-only'], undefined);
  assert.ok(Number(read.query['start-date']) > now() - 90 * 86400 && Number(read.query['end-date']) > now(), 'a window under the 90-day limit');
  assert.equal(read.auth, `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`);

  const rows = inbox();
  assert.deepEqual(rows.map((r) => r.description).sort(), ['GROCERY STORE #12', 'HYDRO-QUEBEC', 'Intact Insurance refund']);
  assert.ok(rows.every((r) => r.status === 'new' && r.source === 'simplefin' && r.integration_id === created.id));
  assert.equal(rows.find((r) => r.description === 'HYDRO-QUEBEC').amount, -182.4);
  assert.equal(rows.find((r) => r.description === 'HYDRO-QUEBEC').suggested_category, 'utility', 'a suggestion, as with files');
  assert.equal(rows[0].account, 'Example Bank · Joint chequing');
  assert.equal(rows.some((r) => r.description === 'RONA QUEBEC'), false, 'accounts that were not chosen are never stored');
});

test('syncing again adds nothing twice, even after the owner has dealt with the transactions', async () => {
  const created = (await create()).body;
  await t.api.patch(`/api/integrations/${created.id}`, { accounts: ['ACC-CHQ', 'ACC-CARD'] }, { token: admin.token });
  const first = await service.syncIntegration(created.id);
  assert.equal(first.summary.added, 4);

  const rows = inbox();
  const hydro = rows.find((r) => r.description === 'HYDRO-QUEBEC');
  const accepted = await t.api.post(`/api/bank/property/${property.id}/accept`, { items: [{ id: hydro.id, category: 'utility' }] }, { token: admin.token });
  assert.equal(accepted.status, 201);
  await t.api.post(`/api/bank/property/${property.id}/ignore`, { ids: [rows.find((r) => r.description === 'GROCERY STORE #12').id] }, { token: admin.token });

  const second = await service.syncIntegration(created.id);
  assert.equal(second.summary.added, 0);
  assert.equal(second.summary.duplicates, 4);
  assert.equal(inbox().length, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM expenses WHERE property_id = ?').get(property.id).c, 1, 'nothing becomes an expense on its own');
});

test('rules apply to synced transactions like to imported ones', async () => {
  await t.api.post(`/api/bank/property/${property.id}/rules`, { pattern: 'GROCERY', action: 'ignore' }, { token: admin.token });
  const created = (await create()).body;
  await t.api.patch(`/api/integrations/${created.id}`, { accounts: ['ACC-CHQ'] }, { token: admin.token });
  const synced = await service.syncIntegration(created.id);
  assert.equal(synced.summary.added, 3);
  assert.equal(inbox().find((r) => r.description.startsWith('GROCERY')).status, 'ignored');
  db.prepare('DELETE FROM bank_rules').run();
});

test('removing the connection keeps what is already in the inbox', async () => {
  const created = (await create()).body;
  await t.api.patch(`/api/integrations/${created.id}`, { accounts: ['ACC-CHQ'] }, { token: admin.token });
  await service.syncIntegration(created.id);
  assert.equal((await t.api.del(`/api/integrations/${created.id}`, { token: admin.token })).status, 204);
  assert.equal(inbox().length, 3);
  assert.ok(inbox().every((r) => r.integration_id === null));
});

// ---------------------------------------------------------------- limits and failures

test('the refresh interval cannot go below two hours, and manual syncs are spaced out', async () => {
  const created = (await create()).body;
  assert.equal((await t.api.patch(`/api/integrations/${created.id}`, { interval_minutes: 60 }, { token: admin.token })).status, 400);
  assert.equal((await t.api.patch(`/api/integrations/${created.id}`, { interval_minutes: 120 }, { token: admin.token })).status, 200);

  const first = await t.api.post(`/api/integrations/${created.id}/sync`, {}, { token: admin.token });
  assert.equal(first.status, 429, 'the connect request counted: no hammering the bridge');
  assert.match(first.body.error, /minutes/);
});

test('a hard daily cap protects the bridge’s own limit', async () => {
  const created = (await create()).body;
  let capped = null;
  for (let i = 0; i < 25 && !capped; i += 1) {
    try {
      await service.syncIntegration(created.id);
    } catch (err) {
      capped = err;
    }
  }
  assert.ok(capped, 'the cap was reached');
  assert.equal(capped.code, 'daily_cap');
  assert.ok(state.requests.filter((r) => r.path === '/simplefin/accounts').length <= 21, 'the bridge was not asked more than the cap');
});

test('bridge problems become readable messages, with backoff', async () => {
  const created = (await create()).body;
  for (const [mode, pattern] of [['forbidden', /refused access/i], ['rate', /too many requests/i], ['garbage', /did not answer with data/i]]) {
    state.mode = mode;
    await assert.rejects(() => service.syncIntegration(created.id), (e) => pattern.test(e.message), mode);
    const row = db.prepare('SELECT status, last_error, failures FROM integrations WHERE id = ?').get(created.id);
    assert.equal(row.status, 'error');
    assert.match(row.last_error, pattern);
  }
  assert.equal(db.prepare('SELECT failures FROM integrations WHERE id = ?').get(created.id).failures, 3);
});

test('credentials are never replayed to another host by a redirect', async () => {
  const created = (await create()).body;
  state.mode = 'redirect-away';
  await assert.rejects(() => service.syncIntegration(created.id), (e) => e.code === 'cross_origin_redirect');
  assert.deepEqual(elsewhereAuth, [], 'the other host never saw a request, let alone the Authorization header');
});

// ---------------------------------------------------------------- who may do this

test('only owners can connect or change a bank connection; viewers and strangers are refused', async () => {
  assert.equal((await create({}, viewer.token)).status, 403);
  assert.equal((await create({}, stranger.token)).status, 403);
  assert.equal(state.requests.length, 0, 'refused before the bridge was contacted');
  const created = (await create()).body;
  assert.equal((await t.api.patch(`/api/integrations/${created.id}`, { accounts: ['ACC-CHQ'] }, { token: viewer.token })).status, 403);
  assert.equal((await t.api.patch(`/api/integrations/${created.id}`, { accounts: ['ACC-CHQ'] }, { token: stranger.token })).status, 403);
});

test('changing the accounts is audited with a count, never names or ids', async () => {
  const created = (await create()).body;
  await t.api.patch(`/api/integrations/${created.id}`, { accounts: ['ACC-CHQ', 'ACC-CARD'] }, { token: admin.token });
  const row = db.prepare("SELECT detail FROM audit_log WHERE action = 'integration_accounts' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row, 'audited');
  assert.equal(row.detail.includes('ACC-'), false);
  assert.match(row.detail, /"count":2/);
});

test('INTEGRATIONS_ENABLED=false refuses new bank connections', async () => {
  process.env.INTEGRATIONS_ENABLED = 'false';
  try {
    assert.equal((await create()).status, 409);
    assert.equal(state.requests.length, 0);
  } finally {
    delete process.env.INTEGRATIONS_ENABLED;
  }
});
