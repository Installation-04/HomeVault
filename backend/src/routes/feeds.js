import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { addDays, localToday } from '../utils/dates.js';
import { nonEmptyString, parseId } from '../utils/http.js';

// Subscribable calendar (ICS) feeds: add the URL to Apple Calendar, Google
// Calendar or Outlook and reminders, tasks, document expiries and warranty
// ends show up (with alarms) alongside everything else in your life.
//
// Calendar apps can't send cookies, so the URL itself carries a secret. We keep
// only its hash, each feed can be revoked on its own, and the response is
// read-only and covers just what that person could already see in the app.

const MAX_FEEDS_PER_USER = 10;
const TOKEN_PREFIX = 'hvcal_';

export const feedsRouter = Router();
export const publicFeedRouter = Router();

// ---- managing feeds (signed in) --------------------------------------------

const accessibleProperty = (user, propertyId) =>
  user.is_admin
    ? db.prepare('SELECT id, name FROM properties WHERE id = ?').get(propertyId)
    : db
        .prepare('SELECT p.id, p.name FROM properties p JOIN property_access pa ON pa.property_id = p.id WHERE p.id = ? AND pa.user_id = ?')
        .get(propertyId, user.id);

feedsRouter.use(requireAuth);

feedsRouter.get('/', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT f.id, f.label, f.property_id, p.name AS property_name, f.created_at, f.last_used_at
         FROM calendar_feeds f LEFT JOIN properties p ON p.id = f.property_id
         WHERE f.user_id = ? ORDER BY f.id DESC`
      )
      .all(req.user.id)
  );
});

feedsRouter.post('/', (req, res) => {
  const label = String(req.body?.label ?? '').trim().slice(0, 60);
  if (!nonEmptyString(label)) return res.status(400).json({ error: 'label required' });

  let propertyId = null;
  if (req.body?.property_id !== undefined && req.body?.property_id !== null && req.body?.property_id !== '') {
    propertyId = parseId(Number(req.body.property_id));
    if (!propertyId || !accessibleProperty(req.user, propertyId)) return res.status(403).json({ error: 'No access to this property' });
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM calendar_feeds WHERE user_id = ?').get(req.user.id).c >= MAX_FEEDS_PER_USER) {
    return res.status(409).json({ error: `You can have at most ${MAX_FEEDS_PER_USER} calendar links. Remove one you no longer use.` });
  }

  const token = TOKEN_PREFIX + randomToken(32);
  const info = db
    .prepare('INSERT INTO calendar_feeds (user_id, property_id, label, token_hash) VALUES (?, ?, ?, ?)')
    .run(req.user.id, propertyId, label, sha256(token));
  audit(req, 'calendar_feed_created', { target: label });
  // The only time the secret URL is ever shown.
  res.status(201).json({ id: Number(info.lastInsertRowid), label, property_id: propertyId, path: `/api/calendar-feed/${token}.ics` });
});

feedsRouter.delete('/:id', (req, res) => {
  const id = parseId(req.params.id);
  const feed = id && db.prepare('SELECT label FROM calendar_feeds WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!feed) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM calendar_feeds WHERE id = ?').run(id);
  audit(req, 'calendar_feed_revoked', { target: feed.label });
  res.status(204).end();
});

// ---- RFC 5545 helpers -------------------------------------------------------

const icsText = (s) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

// Lines may not exceed 75 octets; continuation lines start with one space.
// Count bytes, not characters, and never split inside a multi-byte character.
export function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

const compactDate = (iso) => iso.replace(/-/g, '');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const RRULES = { monthly: () => 'FREQ=MONTHLY', yearly: () => 'FREQ=YEARLY', custom: (n) => `FREQ=DAILY;INTERVAL=${Math.max(1, Number(n) || 30)}` };

const LABELS = {
  en: { expires: 'Expires', warranty: 'Warranty ends', reminder: 'Reminder' },
  fr: { expires: 'Expire', warranty: 'Fin de garantie', reminder: 'Rappel' },
};

export function buildCalendar({ name, events, now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HomeVault//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}@homevault`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${compactDate(e.date)}`,
      `DTEND;VALUE=DATE:${compactDate(addDays(e.date, 1))}`,
      `SUMMARY:${icsText(e.summary)}`
    );
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    lines.push('TRANSP:TRANSPARENT');
    if (e.alertDays !== undefined) {
      // Alarm at 09:00 local, N days before (all-day events start at 00:00).
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsText(e.summary)}`,
        `TRIGGER:${e.alertDays > 0 ? `-P${e.alertDays - 1}DT15H` : 'PT9H'}`,
        'END:VALARM'
      );
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

function collectEvents(user, feed) {
  const t = LABELS[user.locale] || LABELS.en;
  const properties = feed.property_id
    ? db
        .prepare(
          user.is_admin
            ? 'SELECT id, name FROM properties WHERE id = ?'
            : 'SELECT p.id, p.name FROM properties p JOIN property_access pa ON pa.property_id = p.id WHERE p.id = ? AND pa.user_id = ?'
        )
        .all(...(user.is_admin ? [feed.property_id] : [feed.property_id, user.id]))
    : user.is_admin
      ? db.prepare('SELECT id, name FROM properties ORDER BY name').all()
      : db.prepare('SELECT p.id, p.name FROM properties p JOIN property_access pa ON pa.property_id = p.id WHERE pa.user_id = ? ORDER BY p.name').all(user.id);

  const multi = properties.length > 1;
  const since = addDays(localToday(), -30);
  const events = [];

  for (const p of properties) {
    const tag = (s) => (multi ? `[${p.name}] ${s}` : s);
    for (const r of db.prepare('SELECT * FROM reminders WHERE property_id = ? AND completed_at IS NULL').all(p.id)) {
      events.push({
        uid: `reminder-${r.id}`,
        date: r.due_date,
        summary: tag(r.title),
        description: [r.notes, `${t.reminder} · ${p.name}`].filter(Boolean).join('\n'),
        rrule: RRULES[r.recurrence]?.(r.recurrence_interval_days),
        alertDays: r.lead_time_days,
      });
    }
    for (const k of db.prepare('SELECT * FROM tasks WHERE property_id = ? AND completed_at IS NULL').all(p.id)) {
      events.push({ uid: `task-${k.id}`, date: k.event_date, summary: tag(k.title), description: k.notes, rrule: RRULES[k.recurrence]?.(k.recurrence_interval_days) });
    }
    for (const d of db.prepare('SELECT id, title, expiry_date FROM documents WHERE property_id = ? AND expiry_date >= ?').all(p.id, since)) {
      events.push({ uid: `doc-${d.id}`, date: d.expiry_date, summary: tag(`${t.expires}: ${d.title}`), alertDays: 14 });
    }
    for (const e of db.prepare('SELECT id, name, warranty_expiry FROM equipment WHERE property_id = ? AND warranty_expiry >= ?').all(p.id, since)) {
      events.push({ uid: `warranty-${e.id}`, date: e.warranty_expiry, summary: tag(`${t.warranty}: ${e.name}`), alertDays: 14 });
    }
  }
  return { events, name: multi || !properties[0] ? 'HomeVault' : `HomeVault – ${properties[0].name}` };
}

// ---- the public, token-protected feed --------------------------------------

// Wrong guesses are throttled hard; normal calendar polling (a few times a day) never notices.
const failedGuesses = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).type('text/plain').send('Too many attempts'),
});
const generalLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

publicFeedRouter.get('/:file', generalLimit, failedGuesses, (req, res) => {
  const match = /^(hvcal_[A-Za-z0-9_-]{20,80})\.ics$/.exec(req.params.file);
  const feed = match && db.prepare('SELECT * FROM calendar_feeds WHERE token_hash = ?').get(sha256(match[1]));
  const user = feed && db.prepare('SELECT id, email, is_admin, locale, disabled_at FROM users WHERE id = ?').get(feed.user_id);
  if (!feed || !user || user.disabled_at) return res.status(404).type('text/plain').send('Not found');

  db.prepare("UPDATE calendar_feeds SET last_used_at = datetime('now') WHERE id = ?").run(feed.id);
  const { events, name } = collectEvents({ ...user, is_admin: !!user.is_admin }, feed);
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="homevault.ics"',
    'Cache-Control': 'private, max-age=900',
    'Referrer-Policy': 'no-referrer',
  });
  res.send(buildCalendar({ name, events }));
});
