// Drives an in-app update the way the Settings page does, against a running instance, and checks
// the outcome. Exits non-zero when the result is not the expected one.
//   node drive-update.mjs <base-url> <state.json> <target-tag> <expect: success|rolled_back> <admin-email> <admin-password>
import fs from 'node:fs';

const [base, stateFile, tag, expect, email, password] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};
const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => /^(__Host-)?hv_session=.+/.test(c));

const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
const cookie = cookieOf(login);
if (!cookie) fail(`login failed (${login.status})`);
const H = { Cookie: cookie, 'Content-Type': 'application/json' };
const get = async (p) => {
  const r = await fetch(base + p, { headers: H });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// The updater reports in with a heartbeat every few seconds; right after an install the first one
// may not have landed yet, so give it a little time before calling it missing.
let before;
for (let i = 0; i < 30; i += 1) {
  before = (await get('/api/admin/update')).body;
  if (before.updater?.available) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log(`before: running ${before.current}, updater ${JSON.stringify(before.updater)}`);
if (!before.updater?.available) fail('the updater is not reporting in');

// Publish the release, then ask again. A forced refresh within 30 s of the last check is served from
// cache on purpose, so wait that out.
fs.writeFileSync(stateFile, JSON.stringify({ tag }));
await sleep(32000);
const offered = (await get('/api/admin/update?refresh=1')).body;
console.log(`offered: update_available=${offered.update_available} latest=${offered.latest?.version} check_error=${offered.check_error}`);
if (!offered.update_available || offered.latest?.tag !== tag) fail(`the new release was not offered (check_error: ${offered.check_error})`);

const wrong = await fetch(`${base}/api/admin/update/apply`, { method: 'POST', headers: H, body: JSON.stringify({ current_password: 'not-the-password-1' }) });
if (wrong.status !== 400) fail(`a wrong password must be refused (got ${wrong.status})`);

const res = await fetch(`${base}/api/admin/update/apply`, { method: 'POST', headers: H, body: JSON.stringify({ current_password: password }) });
const request = await res.json();
if (res.status !== 202) fail(`apply returned ${res.status} ${JSON.stringify(request)}`);
console.log(`requested ${request.from} -> ${request.to} (id ${request.id})`);

const started = Date.now();
let final = null;
let last = '';
while (Date.now() - started < 600000) {
  await sleep(3000);
  let r;
  try {
    r = await get('/api/admin/update');
  } catch {
    if (last !== 'down') console.log('  (app unreachable: restarting)');
    last = 'down';
    continue;
  }
  if (r.status !== 200) continue;
  const st = r.body.status;
  const line = `${r.body.current} ${st?.state ?? '-'} ${st?.step ?? ''}`;
  if (line !== last) console.log(`  current=${r.body.current} state=${st?.state ?? '-'} step=${JSON.stringify(st?.step ?? '')}`);
  last = line;
  if (st && st.request_id === request.id && ['success', 'failed', 'rolled_back'].includes(st.state)) {
    final = { ...st, current: r.body.current, in_progress: r.body.in_progress };
    break;
  }
}
if (!final) fail('timed out waiting for the update to finish');
console.log(`finished: ${final.state} - ${final.message}`);
if (final.state !== expect) {
  console.error((final.log || []).join('\n'));
  fail(`expected ${expect} but the update ended as ${final.state}`);
}
const wantVersion = expect === 'success' ? tag.slice(1) : before.current;
if (final.current !== wantVersion) fail(`the app should be running ${wantVersion} but reports ${final.current}`);
if (final.in_progress) fail('the update still counts as in progress after it finished');

const audit = (await get('/api/admin/audit?limit=20')).body.events.map((e) => e.action);
for (const action of ['update_requested', 'update_finished']) if (!audit.includes(action)) fail(`the audit log has no ${action}`);
console.log(`OK: ${expect}, running ${final.current}`);
