import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { httpError } from '../utils/http.js';
import { safeFetch, checkUrl } from './safeFetch.js';
import { isValidTimeZone, parseCalendar } from './ics.js';
import { claimToken, fetchAccounts, readSetupInput } from './bank/simplefin.js';
import { defaultCurrency, importTransactions } from './bank/store.js';

// Connections HomeVault pulls from on a schedule. Each type knows how to (1) check what a person typed
// and turn it into a stored config, and (2) run one sync. Secrets (private calendar addresses, access
// tokens) are kept encrypted and never returned by the API.

export const integrationsEnabled = () => process.env.INTEGRATIONS_ENABLED !== 'false';

const MIN_INTERVAL = 15; // minutes
const MAX_INTERVAL = 24 * 60;
const MAX_BACKOFF_MINUTES = 24 * 60;
const MANUAL_COOLDOWN_SECONDS = 20;

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const daysFromNow = (days) => isoDate(new Date(Date.now() + days * 86_400_000));

// ---- calendar subscribed by URL ----------------------------------------------------------------

const calendarIcs = {
  label: 'calendar_ics',
  defaultInterval: 60,

  // Checks the form input; returns { name, config } or throws a 400.
  prepare(body) {
    const url = checkUrl(body.url); // throws a readable error for bad / private addresses
    const timezone = body.timezone ? String(body.timezone) : null;
    if (timezone && !isValidTimeZone(timezone)) throw httpError(400, 'That time zone is not recognised.', 'bad_timezone');
    return { name: String(body.name ?? '').trim() || url.hostname, config: { url: url.href, timezone } };
  },

  describe(config) {
    try {
      return { source: new URL(config.url).hostname };
    } catch {
      return { source: null };
    }
  },

  // Fetches and parses; returns { summary, apply(integration) } where apply writes to the database.
  async fetch(config) {
    const res = await safeFetch(config.url, { headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' } });
    if (res.status === 401 || res.status === 403) throw httpError(400, 'The calendar refused access. Check that the address is the private/secret one.', 'forbidden');
    if (res.status === 404 || res.status === 410) throw httpError(400, 'The calendar was not found at that address.', 'not_found');
    if (res.status < 200 || res.status >= 300) throw httpError(400, `The calendar server answered HTTP ${res.status}.`, 'http_error');
    if (!/^\s*(﻿)?\s*BEGIN:VCALENDAR/i.test(res.text)) {
      throw httpError(400, 'That address did not return a calendar. It may need a login, or be a web page rather than an .ics link.', 'not_a_calendar');
    }
    const { events, name, timezone } = parseCalendar(res.text, { timezone: config.timezone, from: daysFromNow(-31), to: daysFromNow(400) });
    return {
      summary: { events: events.length, calendar_name: name, timezone },
      apply(integration) {
        db.prepare('DELETE FROM external_events WHERE integration_id = ?').run(integration.id);
        const insert = db.prepare(
          `INSERT INTO external_events (integration_id, property_id, uid, title, location, description, start_date, start_time, end_date, end_time, all_day)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const e of events) {
          insert.run(integration.id, integration.property_id, e.uid, e.title, e.location, e.description, e.start_date, e.start_time, e.end_date, e.end_time, e.all_day);
        }
      },
    };
  },
};

// ---- bank accounts through a SimpleFIN Bridge -----------------------------------------------------
// The bridge allows roughly 24 requests a day, so this type syncs rarely (twice a day by default), has a
// longer minimum interval and manual-sync cooldown, and keeps its own rolling cap as a second line of defence.

const DAILY_REQUEST_CAP = 20;
const requestLog = new Map(); // integration id -> timestamps of requests made in the last 24 hours

function underDailyCap(id) {
  const now = Date.now();
  const recent = (requestLog.get(id) ?? []).filter((at) => now - at < 86_400_000);
  const allowed = recent.length < DAILY_REQUEST_CAP;
  if (allowed) recent.push(now);
  requestLog.set(id, recent);
  return allowed;
}

const simplefin = {
  label: 'simplefin',
  defaultInterval: 720,
  minInterval: 120,
  manualCooldownSeconds: 600,

  prepare(body) {
    const input = readSetupInput(body.setup_token);
    return { name: String(body.name ?? '').trim() || 'Bank (SimpleFIN)', config: input };
  },

  // The one-time token is traded for the access address only now, after every other check has passed, so a
  // rejected form never uses it up.
  async connect(config) {
    return { access: config.access ?? (await claimToken(config.claim_url)), accounts: [] };
  },

  describe(config) {
    return { source: new URL(config.access.base).hostname, selected_accounts: config.accounts ?? [] };
  },

  // Nothing is read from any account until the owner has chosen which ones; connecting only lists them.
  async fetch(config, row) {
    if (row && !underDailyCap(row.id)) throw httpError(429, `HomeVault has already asked the bridge ${DAILY_REQUEST_CAP} times in the last 24 hours and will wait.`, 'daily_cap');
    const selected = new Set(config.accounts ?? []);
    const { accounts, messages } = await fetchAccounts(config.access, { withTransactions: selected.size > 0 });
    const chosen = accounts.filter((a) => selected.has(a.id));
    const transactions = chosen.flatMap((a) => a.transactions.map((t) => ({ ...t, currency: t.currency ?? a.currency })));
    const summary = {
      accounts: accounts.map(({ id, name, org, currency }) => ({ id, name, org, currency })),
      selected: chosen.length,
      messages,
      added: 0,
      duplicates: 0,
    };
    return {
      summary,
      apply(integration) {
        if (transactions.length === 0) return;
        const counts = importTransactions({
          propertyId: integration.property_id,
          userId: integration.created_by,
          source: 'simplefin',
          integrationId: integration.id,
          transactions,
          batch: crypto.randomBytes(8).toString('hex'),
          defaultCurrency: defaultCurrency(integration.property_id),
        });
        summary.added = counts.added;
        summary.duplicates = counts.duplicates;
      },
    };
  },

  // PATCH { accounts: [id, …] }: which accounts to import. Only accounts the bridge actually listed are accepted.
  update(config, body, row) {
    if (body.accounts === undefined) return null;
    const known = new Set((JSON.parse(row.summary || '{}').accounts ?? []).map((a) => a.id));
    if (!Array.isArray(body.accounts) || body.accounts.length > 50 || !body.accounts.every((id) => typeof id === 'string' && known.has(id))) {
      throw httpError(400, 'Choose accounts from the list the bridge provided.', 'bad_accounts');
    }
    return { ...config, accounts: [...new Set(body.accounts)] };
  },
};

const TYPES = { calendar_ics: calendarIcs, simplefin };

export const integrationTypes = () => Object.keys(TYPES);

// ---- storage helpers ---------------------------------------------------------------------------

const readConfig = (row) => JSON.parse(decryptSecret(row.config_enc));

// What the API may show: no config, no secrets, just enough to recognise the source.
export function publicView(row) {
  let described = {};
  try {
    described = TYPES[row.type]?.describe(readConfig(row)) ?? {};
  } catch {
    /* an unreadable config (e.g. the data key changed) shows as an error state below */
  }
  let summary = null;
  try {
    summary = row.summary ? JSON.parse(row.summary) : null;
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    property_id: row.property_id,
    type: row.type,
    name: row.name,
    interval_minutes: row.interval_minutes,
    paused: Boolean(row.paused),
    status: row.status,
    last_sync_at: row.last_sync_at,
    last_attempt_at: row.last_attempt_at,
    next_sync_at: row.next_sync_at,
    last_error: row.last_error,
    summary,
    ...described,
  };
}

export function listForProperty(propertyId) {
  return db.prepare('SELECT * FROM integrations WHERE property_id = ? ORDER BY name COLLATE NOCASE, id').all(propertyId).map(publicView);
}

function clampInterval(value, fallback, type) {
  const min = type?.minInterval ?? MIN_INTERVAL;
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > MAX_INTERVAL) {
    const shown = min >= 60 ? `${min / 60} hours` : `${min} minutes`;
    throw httpError(400, `The refresh interval must be between ${shown} and ${MAX_INTERVAL / 60} hours.`, 'bad_interval');
  }
  return n;
}

// ---- running a sync ----------------------------------------------------------------------------

const inFlight = new Set();

// Runs the type's fetch, then records the outcome. Throws httpError(…) with a person-readable message on
// failure after recording it (so the settings screen shows what went wrong).
export async function syncIntegration(id, { manual = false } = {}) {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'Not found');
  const type = TYPES[row.type];
  if (!type) throw httpError(400, 'This kind of connection is not supported.');
  if (inFlight.has(id)) throw httpError(409, 'A sync is already running.', 'sync_running');
  if (manual && row.last_attempt_at) {
    const cooldown = type.manualCooldownSeconds ?? MANUAL_COOLDOWN_SECONDS;
    const waited = db.prepare("SELECT (julianday('now') - julianday(?)) * 86400 AS s").get(row.last_attempt_at).s;
    if (waited < cooldown) {
      throw httpError(429, cooldown > 60 ? `Please wait about ${Math.ceil((cooldown - waited) / 60)} minutes before syncing this again.` : 'Please wait a few seconds before syncing again.', 'too_soon');
    }
  }

  inFlight.add(id);
  db.prepare("UPDATE integrations SET last_attempt_at = datetime('now') WHERE id = ?").run(id);
  try {
    let result;
    try {
      result = await type.fetch(readConfig(row), row);
    } catch (err) {
      const failures = row.failures + 1;
      const backoff = Math.min(row.interval_minutes * 2 ** Math.min(failures, 6), MAX_BACKOFF_MINUTES);
      const message = (err.status && (err.status < 500 || err.expose) ? err.message : `The sync failed (${err.code || 'error'}).`).slice(0, 300);
      db.prepare("UPDATE integrations SET status = 'error', failures = ?, last_error = ?, next_sync_at = datetime('now', ?) WHERE id = ?").run(
        failures,
        message,
        `+${backoff} minutes`,
        id
      );
      throw err.status ? err : httpError(502, message, 'sync_failed');
    }
    db.transaction(() => {
      result.apply(row);
      db.prepare(
        `UPDATE integrations SET status = 'ok', failures = 0, last_error = NULL, last_sync_at = datetime('now'),
           next_sync_at = datetime('now', ?), summary = ? WHERE id = ?`
      ).run(`+${row.interval_minutes} minutes`, JSON.stringify(result.summary), id);
    })();
    return publicView(db.prepare('SELECT * FROM integrations WHERE id = ?').get(id));
  } finally {
    inFlight.delete(id);
  }
}

// Called every few minutes by the scheduler: syncs whatever is due, one at a time so a slow server
// never makes several outbound requests at once.
export async function runDueIntegrations({ limit = 20 } = {}) {
  if (!integrationsEnabled()) return { ran: 0, failed: 0 };
  const due = db
    .prepare("SELECT id FROM integrations WHERE paused = 0 AND (next_sync_at IS NULL OR next_sync_at <= datetime('now')) ORDER BY COALESCE(next_sync_at, '') LIMIT ?")
    .all(limit);
  let ran = 0;
  let failed = 0;
  for (const { id } of due) {
    try {
      await syncIntegration(id);
      ran += 1;
    } catch {
      failed += 1;
    }
  }
  return { ran, failed };
}

// ---- creating / changing -----------------------------------------------------------------------

// Validates, makes a real first sync (so a wrong address is reported now rather than saved), and stores.
export async function createIntegration({ user, propertyId, body }) {
  if (!integrationsEnabled()) throw httpError(409, 'Integrations are switched off on this server (INTEGRATIONS_ENABLED=false).', 'integrations_disabled');
  const type = TYPES[body.type];
  if (!type) throw httpError(400, `type must be one of: ${integrationTypes().join(', ')}`);
  const prepared = type.prepare(body);
  const { name } = prepared;
  const interval = clampInterval(body.interval_minutes, type.defaultInterval, type);

  const count = db.prepare('SELECT COUNT(*) AS c FROM integrations WHERE property_id = ?').get(propertyId).c;
  if (count >= 20) throw httpError(409, 'This property already has the maximum number of connections (20).', 'too_many');

  // Types with a one-time handshake (a setup token) do it only now that nothing else can reject the request.
  const config = type.connect ? await type.connect(prepared.config) : prepared.config;

  // Prove it works before saving anything. A connection that cost a one-time token is kept even if the first
  // read fails, so the token is not wasted: it shows the problem and can be retried.
  let result = null;
  let failure = null;
  try {
    result = await type.fetch(config, null);
  } catch (err) {
    if (!type.connect) throw err;
    failure = err;
  }
  const id = db.transaction(() => {
    const info = failure
      ? db
          .prepare(
            `INSERT INTO integrations (property_id, type, name, config_enc, interval_minutes, status, failures, last_error, last_attempt_at, next_sync_at, created_by)
             VALUES (?, ?, ?, ?, ?, 'error', 1, ?, datetime('now'), datetime('now', ?), ?)`
          )
          .run(propertyId, body.type, name.slice(0, 120), encryptSecret(JSON.stringify(config)), interval, (failure.status && (failure.status < 500 || failure.expose) ? failure.message : 'The first read failed.').slice(0, 300), `+${interval} minutes`, user.id)
      : db
          .prepare(
            `INSERT INTO integrations (property_id, type, name, config_enc, interval_minutes, status, last_attempt_at, last_sync_at, next_sync_at, summary, created_by)
             VALUES (?, ?, ?, ?, ?, 'ok', datetime('now'), datetime('now'), datetime('now', ?), ?, ?)`
          )
          .run(propertyId, body.type, name.slice(0, 120), encryptSecret(JSON.stringify(config)), interval, `+${interval} minutes`, JSON.stringify(result.summary), user.id);
    result?.apply({ id: info.lastInsertRowid, property_id: propertyId, created_by: user.id });
    return Number(info.lastInsertRowid);
  })();
  return publicView(db.prepare('SELECT * FROM integrations WHERE id = ?').get(id));
}

export function updateIntegration(row, body) {
  const type = TYPES[row.type];
  const name = body.name === undefined ? row.name : String(body.name).trim().slice(0, 120);
  if (!name) throw httpError(400, 'A name is required.');
  const interval = body.interval_minutes === undefined ? row.interval_minutes : clampInterval(body.interval_minutes, row.interval_minutes, type);
  const paused = body.paused === undefined ? row.paused : body.paused ? 1 : 0;
  // Type-specific settings (which bank accounts to read). Changing them makes the next sync due straight away.
  const nextConfig = type?.update ? type.update(readConfig(row), body, row) : null;
  // Resuming makes it due straight away.
  const dueNow = (row.paused && !paused) || nextConfig;
  db.transaction(() => {
    db.prepare(`UPDATE integrations SET name = ?, interval_minutes = ?, paused = ?, next_sync_at = ${dueNow ? "datetime('now')" : 'next_sync_at'} WHERE id = ?`).run(name, interval, paused, row.id);
    if (nextConfig) db.prepare('UPDATE integrations SET config_enc = ?, last_attempt_at = NULL WHERE id = ?').run(encryptSecret(JSON.stringify(nextConfig)), row.id);
  })();
  return publicView(db.prepare('SELECT * FROM integrations WHERE id = ?').get(row.id));
}

export function deleteIntegration(row) {
  requestLog.delete(row.id);
  db.prepare('DELETE FROM integrations WHERE id = ?').run(row.id);
}
