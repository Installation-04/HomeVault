import { db } from '../db/index.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { httpError } from '../utils/http.js';
import { safeFetch, checkUrl } from './safeFetch.js';
import { isValidTimeZone, parseCalendar } from './ics.js';

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

const TYPES = { calendar_ics: calendarIcs };

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

function clampInterval(value, fallback) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) {
    throw httpError(400, `The refresh interval must be between ${MIN_INTERVAL} minutes and ${MAX_INTERVAL / 60} hours.`, 'bad_interval');
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
    const waited = db.prepare("SELECT (julianday('now') - julianday(?)) * 86400 AS s").get(row.last_attempt_at).s;
    if (waited < MANUAL_COOLDOWN_SECONDS) throw httpError(429, 'Please wait a few seconds before syncing again.', 'too_soon');
  }

  inFlight.add(id);
  db.prepare("UPDATE integrations SET last_attempt_at = datetime('now') WHERE id = ?").run(id);
  try {
    let result;
    try {
      result = await type.fetch(readConfig(row));
    } catch (err) {
      const failures = row.failures + 1;
      const backoff = Math.min(row.interval_minutes * 2 ** Math.min(failures, 6), MAX_BACKOFF_MINUTES);
      const message = (err.status && err.status < 500 ? err.message : `The sync failed (${err.code || 'error'}).`).slice(0, 300);
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
  const { name, config } = type.prepare(body);
  const interval = clampInterval(body.interval_minutes, type.defaultInterval);

  const count = db.prepare('SELECT COUNT(*) AS c FROM integrations WHERE property_id = ?').get(propertyId).c;
  if (count >= 20) throw httpError(409, 'This property already has the maximum number of connections (20).', 'too_many');

  // Prove it works before saving anything.
  const result = await type.fetch(config);
  const id = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO integrations (property_id, type, name, config_enc, interval_minutes, status, last_attempt_at, last_sync_at, next_sync_at, summary, created_by)
         VALUES (?, ?, ?, ?, ?, 'ok', datetime('now'), datetime('now'), datetime('now', ?), ?, ?)`
      )
      .run(propertyId, body.type, name.slice(0, 120), encryptSecret(JSON.stringify(config)), interval, `+${interval} minutes`, JSON.stringify(result.summary), user.id);
    result.apply({ id: info.lastInsertRowid, property_id: propertyId });
    return Number(info.lastInsertRowid);
  })();
  return publicView(db.prepare('SELECT * FROM integrations WHERE id = ?').get(id));
}

export function updateIntegration(row, body) {
  const name = body.name === undefined ? row.name : String(body.name).trim().slice(0, 120);
  if (!name) throw httpError(400, 'A name is required.');
  const interval = body.interval_minutes === undefined ? row.interval_minutes : clampInterval(body.interval_minutes, row.interval_minutes);
  const paused = body.paused === undefined ? row.paused : body.paused ? 1 : 0;
  // Resuming makes it due straight away.
  const resumeNow = row.paused && !paused;
  db.prepare(`UPDATE integrations SET name = ?, interval_minutes = ?, paused = ?, next_sync_at = ${resumeNow ? "datetime('now')" : 'next_sync_at'} WHERE id = ?`).run(name, interval, paused, row.id);
  return publicView(db.prepare('SELECT * FROM integrations WHERE id = ?').get(row.id));
}

export function deleteIntegration(row) {
  db.prepare('DELETE FROM integrations WHERE id = ?').run(row.id);
}
