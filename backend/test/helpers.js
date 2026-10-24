import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

// Boots the real express app against a throwaway SQLite DB + upload dir.
// Env must be set before src/ modules are imported because db/index.js and
// the upload routes read it at import time; node --test runs each test file
// in its own process so there is no cross-file leakage.
// Pulls the session token out of a response's Set-Cookie header (or null).
export function sessionCookie(res) {
  const list = res.headers.getSetCookie?.() ?? [];
  for (const line of list) {
    const m = /^(?:__Host-)?hv_session=([^;]*)/.exec(line);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

export async function startTestServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homevault-test-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_SECRET: 'test-secret-test-secret-test-secret',
    DB_PATH: path.join(dir, 'data', 'db.sqlite'),
    UPLOAD_DIR: path.join(dir, 'data', 'uploads'),
    BACKUP_DIR: path.join(dir, 'data', 'backups'),
    LOGIN_RATE_LIMIT: '1000',
    ...extraEnv,
  });

  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, urlPath, { token, json, form, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    // Sessions travel in an HttpOnly cookie; `token` is that cookie's value.
    if (token) h.Cookie = `hv_session=${token}`;
    let body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    const res = await fetch(base + urlPath, { method, headers: h, body });
    if (raw) return res;
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers, cookie: sessionCookie(res) };
  }

  const api = {
    get: (p, o) => call('GET', p, o),
    post: (p, json, o) => call('POST', p, { ...o, json }),
    put: (p, json, o) => call('PUT', p, { ...o, json }),
    patch: (p, json, o) => call('PATCH', p, { ...o, json }),
    del: (p, o) => call('DELETE', p, o),
    call,
  };

  // Convenience: first-run admin + helpers to mint family members.
  async function setupAdmin(email = 'admin@example.com', password = 'correct-horse-battery') {
    const res = await api.post('/api/auth/setup', { email, password, name: 'Admin' });
    if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { token: res.cookie, user: res.body.user, email, password };
  }

  // Accounts made through the API normally must change their temporary password
  // at first sign-in; tests opt out so they can use the account straight away.
  async function createUser(adminToken, email, password = 'sturdy-fence-lamp-42', name = 'Member', extra = {}) {
    const res = await api.post('/api/auth/users', { email, password, name, must_change_password: false, ...extra }, { token: adminToken });
    if (res.status !== 201) throw new Error(`createUser failed: ${res.status} ${JSON.stringify(res.body)}`);
    const login = await api.post('/api/auth/login', { email, password });
    if (login.status !== 200 || !login.cookie) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
    return { token: login.cookie, user: login.body.user, email, password };
  }

  async function createProperty(token, name = 'Test House') {
    const res = await api.post('/api/properties', { name }, { token });
    if (res.status !== 201) throw new Error(`createProperty failed: ${res.status}`);
    return res.body;
  }

  function uploadForm(fields, fileName = 'a.txt', content = 'hello') {
    const fd = new FormData();
    // Field order matters: multer only sees fields that precede the file part.
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', new Blob([content], { type: 'text/plain' }), fileName);
    return fd;
  }

  function listFiles(root) {
    const out = [];
    if (!fs.existsSync(root)) return out;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, entry.name);
      if (entry.isDirectory()) out.push(...listFiles(p));
      else out.push(p);
    }
    return out;
  }

  async function close() {
    server.close();
    server.closeAllConnections?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return {
    api,
    base,
    dir,
    uploadDir: process.env.UPLOAD_DIR,
    setupAdmin,
    createUser,
    createProperty,
    uploadForm,
    listFiles,
    close,
  };
}
