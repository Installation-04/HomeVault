import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { audit } from './audit.js';
import { httpError } from './http.js';
import { compareVersions, currentVersion, parseVersion } from './version.js';

// In-app updates. The app itself never touches Docker: it only (1) asks GitHub which
// release is newest and (2) drops a small request file into the data folder. A separate
// "updater" container (see updater/) watches that folder, runs `deploy.sh update` and writes
// its progress to status.json. Nothing in the request is trusted by the updater except
// that it exists: the target is looked up from GitHub again on its side.

const CACHE_MS = 6 * 60 * 60 * 1000;
const FORCE_MIN_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_CHARS = 262144;
const HEARTBEAT_FRESH_MS = 60 * 1000;
const REQUEST_STALE_MS = 15 * 60 * 1000;
const RUNNING_STALE_MS = 45 * 60 * 1000;
const STATES = new Set(['idle', 'updating', 'success', 'failed', 'rolled_back']);

export const updatesEnabled = () => process.env.UPDATE_CHECK !== 'false';
const repo = () => process.env.UPDATE_REPO || 'Installation-04/HomeVault';
const apiBase = () => (process.env.UPDATE_API_BASE || 'https://api.github.com').replace(/\/+$/, '');

export function updateDir() {
  return path.join(path.dirname(process.env.DB_PATH || './data/homevault.sqlite'), '.update');
}
const file = (name) => path.join(updateDir(), name);

// The app (one user) and the updater (another, with no extra privileges) both write here and
// must be able to replace each other's small files, so the folder is world-writable (and not
// sticky). It holds no secrets: only requests and progress.
export function ensureUpdateDir() {
  const dir = updateDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
    fs.chmodSync(dir, 0o777);
  } catch {
    /* read-only or unsupported filesystem: updates simply won't be available */
  }
}

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

function releaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : null;
  } catch {
    return null;
  }
}

// --- asking GitHub which release is newest ------------------------------------------------

let cache = null; // { release, error, checked_at }
let inflight = null;

async function fetchLatest() {
  const response = await fetch(`${apiBase()}/repos/${repo()}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `HomeVault/${currentVersion()}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) return { release: null, error: 'No release has been published yet.' };
  if (!response.ok) return { release: null, error: `GitHub answered HTTP ${response.status}.` };

  const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
  const data = JSON.parse(text);
  const parsed = parseVersion(data.tag_name);
  if (!parsed || data.draft || data.prerelease) {
    return { release: null, error: 'The newest release does not have a version number HomeVault understands.' };
  }
  return {
    release: {
      tag: `v${parsed.join('.')}`,
      version: parsed.join('.'),
      name: clip(data.name, 120),
      notes: clip(data.body, 5000),
      url: releaseUrl(data.html_url),
      published_at: clip(data.published_at, 40),
    },
    error: null,
  };
}

export async function checkLatest({ force = false } = {}) {
  const now = Date.now();
  const fresh = cache && now - cache.checked_at < CACHE_MS;
  const allowForce = force && (!cache || now - cache.checked_at > FORCE_MIN_MS);
  if (fresh && !allowForce) return cache;
  if (!inflight) {
    inflight = fetchLatest()
      .catch((err) => ({ release: null, error: `Could not reach GitHub (${err.name === 'TimeoutError' ? 'timed out' : err.message}).` }))
      .then((result) => {
        // A failed check keeps the last good answer, so a flaky network doesn't hide a known update.
        cache = result.release || !cache?.release ? { ...result, checked_at: Date.now() } : { ...cache, error: result.error, checked_at: Date.now() };
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

// --- talking to the updater --------------------------------------------------------------

function readJson(name, maxBytes = 65536) {
  try {
    const stat = fs.statSync(file(name));
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return null;
  }
}

export function updaterState() {
  try {
    const stat = fs.statSync(file('heartbeat'));
    if (Date.now() - stat.mtimeMs > HEARTBEAT_FRESH_MS) return { available: false };
    const version = clip(fs.readFileSync(file('heartbeat'), 'utf8').trim(), 40);
    return { available: true, version: parseVersion(version) ? parseVersion(version).join('.') : null };
  } catch {
    return { available: false };
  }
}

export function readStatus() {
  const raw = readJson('status.json');
  if (!raw || typeof raw !== 'object' || !STATES.has(raw.state)) return null;
  return {
    state: raw.state,
    request_id: clip(raw.request_id, 64),
    from: clip(raw.from, 40),
    to: clip(raw.to, 40),
    step: clip(raw.step, 120),
    message: clip(raw.message, 500),
    started_at: clip(raw.started_at, 40),
    finished_at: clip(raw.finished_at, 40),
    log: Array.isArray(raw.log) ? raw.log.slice(-40).map((line) => clip(String(line), 300)) : [],
  };
}

function pendingRequest() {
  const request = readJson('request.json', 4096);
  if (!request) return null;
  const age = Date.now() - Date.parse(request.requested_at);
  return Number.isFinite(age) && age < REQUEST_STALE_MS ? request : null;
}

function updateInProgress(status) {
  const request = pendingRequest();
  // A request whose result is already in is finished, even if its file could not be removed.
  if (request && !(status && status.request_id === request.id && status.state !== 'updating' && status.state !== 'idle')) return true;
  if (status?.state !== 'updating') return false;
  const age = Date.now() - Date.parse(status.started_at);
  return !Number.isFinite(age) || age < RUNNING_STALE_MS;
}

const audited = new Set();
function auditFinished(status) {
  if (!status?.request_id || status.state === 'updating' || status.state === 'idle' || audited.has(status.request_id)) return;
  audited.add(status.request_id);
  const seen = db.prepare("SELECT 1 FROM audit_log WHERE action = 'update_finished' AND target = ?").get(status.request_id);
  if (!seen) audit(null, 'update_finished', { user: null, actor: 'updater', target: status.request_id, detail: { state: status.state, from: status.from, to: status.to } });
}

export async function updateSummary({ force = false } = {}) {
  const current = currentVersion();
  const enabled = updatesEnabled();
  const check = enabled ? await checkLatest({ force }) : null;
  const latest = check?.release ?? null;
  const currentParsed = parseVersion(current);
  const available = Boolean(latest && currentParsed && compareVersions(parseVersion(latest.version), currentParsed) > 0);
  const status = readStatus();
  auditFinished(status);
  return {
    current,
    enabled,
    latest,
    update_available: available,
    checked_at: check ? new Date(check.checked_at).toISOString() : null,
    check_error: check?.error ?? null,
    updater: updaterState(),
    in_progress: updateInProgress(status),
    status,
  };
}

// Called by the apply route once the admin has confirmed with their password.
export async function requestUpdate(user) {
  const summary = await updateSummary();
  if (!summary.enabled) throw httpError(409, 'Update checks are switched off (UPDATE_CHECK=false).', 'updates_disabled');
  if (!summary.update_available) throw httpError(409, 'HomeVault is already up to date.', 'up_to_date');
  if (!summary.updater.available) {
    throw httpError(409, 'The updater is not running. Install it with ./deploy.sh (see docs/DEPLOYMENT.md), or update from the command line.', 'updater_unavailable');
  }
  if (summary.in_progress) throw httpError(409, 'An update is already in progress.', 'update_in_progress');

  ensureUpdateDir();
  const request = { id: randomUUID(), requested_at: new Date().toISOString(), target: summary.latest.tag, requested_by: user.email };
  // A stale request nobody picked up must not block new ones forever.
  fs.rmSync(file('request.json'), { force: true });
  try {
    fs.writeFileSync(file('request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o644 });
  } catch (err) {
    throw httpError(500, `Could not write the update request (${err.code || err.message}).`, 'request_failed');
  }
  return { request, from: summary.current, to: summary.latest.version };
}

// For tests: forget the cached GitHub answer.
export function resetUpdateCache() {
  cache = null;
  inflight = null;
  audited.clear();
}
