import ICAL from 'ical.js';

// Turns an iCalendar (.ics) file into a flat list of dated events for a window of time.
// Handles what real calendars contain: all-day and timed events, UTC / floating / TZID times
// (with or without a VTIMEZONE), recurring events with exceptions and moved instances, and
// multi-day events. Everything is converted to wall-clock date + time in one chosen time zone,
// because HomeVault's calendar is date-based.

export const LIMITS = {
  maxEvents: 5000, // total events kept from one calendar
  maxOccurrencesPerSeries: 1000,
  maxIterationsPerSeries: 20000, // a rule like FREQ=SECONDLY must not spin forever
  maxSpanDays: 14, // longer events are shown only on their first days
  maxTitle: 300,
  maxLocation: 300,
  maxDescription: 2000,
};

const pad = (n) => String(n).padStart(2, '0');

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

// The wall-clock parts of an instant (ms since epoch) in a time zone.
function wallParts(ms, tz) {
  const parts = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

// Offset of a zone from UTC at an instant, in ms.
function zoneOffsetMs(ms, tz) {
  const w = wallParts(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

// The instant at which a wall-clock time occurs in a zone (settles twice to cope with DST edges).
function wallToInstantMs(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = guess - zoneOffsetMs(guess, tz);
  ms = guess - zoneOffsetMs(ms, tz);
  return ms;
}

function wallString(ms, tz) {
  const w = wallParts(ms, tz);
  return { date: `${w.year}-${pad(w.month)}-${pad(w.day)}`, time: `${pad(w.hour)}:${pad(w.minute)}` };
}

// An ICAL.Time -> { date, time|null }. `tzidParam` is the TZID of the property it came from.
function toWall(time, tzidParam, targetTz) {
  if (time.isDate) return { date: `${time.year}-${pad(time.month)}-${pad(time.day)}`, time: null };

  const zone = time.zone;
  const known = zone && zone !== ICAL.Timezone.localTimezone; // UTC or a registered VTIMEZONE
  if (known) return wallString(time.toUnixTime() * 1000, targetTz);

  // Floating wall time. If it names a real zone that was never defined, honour it; otherwise it is
  // simply "that time, wherever you are".
  if (tzidParam && isValidTimeZone(tzidParam)) {
    return wallString(wallToInstantMs(time.year, time.month, time.day, time.hour, time.minute, time.second, tzidParam), targetTz);
  }
  return { date: `${time.year}-${pad(time.month)}-${pad(time.day)}`, time: `${pad(time.hour)}:${pad(time.minute)}` };
}

const clean = (value, max) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

const dateAddDays = (isoDate, days) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};

const tzidOf = (component, name) => component.getFirstProperty(name)?.getParameter('tzid') ?? null;

// Parses `text` and returns { name, timezone, events }. `from` / `to` are YYYY-MM-DD bounds (inclusive):
// events outside them are dropped, and recurring events are expanded only inside them.
export function parseCalendar(text, { timezone, from, to } = {}) {
  let root;
  try {
    ICAL.TimezoneService.reset();
    root = new ICAL.Component(ICAL.parse(String(text)));
    if (root.name !== 'vcalendar') throw new Error('not a calendar');
  } catch {
    throw Object.assign(new Error('That does not look like a calendar file (.ics).'), { status: 400, code: 'not_a_calendar' });
  }
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      /* a broken VTIMEZONE: its events fall back to the TZID name or floating time */
    }
  }

  const calendarTz = clean(root.getFirstPropertyValue('x-wr-timezone'), 64);
  const targetTz = [timezone, calendarTz, process.env.TZ, 'UTC'].find(isValidTimeZone);
  const name = clean(root.getFirstPropertyValue('x-wr-calname'), 120);

  // Group instances by UID: the series, and any changed or moved occurrences of it.
  const series = new Map();
  for (const component of root.getAllSubcomponents('vevent')) {
    let ev;
    try {
      ev = new ICAL.Event(component);
      if (!ev.uid || !ev.startDate) continue;
    } catch {
      continue;
    }
    const entry = series.get(ev.uid) ?? { main: null, changes: [] };
    if (ev.isRecurrenceException()) entry.changes.push(ev);
    else entry.main = ev;
    series.set(ev.uid, entry);
  }

  const events = [];
  const seen = new Set();
  const push = (uid, item, startTime, endTime) => {
    if (events.length >= LIMITS.maxEvents) return false;
    if (String(item.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return true;

    const start = toWall(startTime, tzidOf(item.component, 'dtstart'), targetTz);
    let end = start;
    if (endTime) end = toWall(endTime, tzidOf(item.component, 'dtend'), targetTz);
    const allDay = start.time === null;
    let startDate = start.date;
    let endDate = end.date;
    // An all-day DTEND is exclusive ("Oct 30 to Nov 2" ends on Nov 1).
    if (allDay && endTime && endDate > startDate) endDate = dateAddDays(endDate, -1);
    if (endDate < startDate) endDate = startDate;
    if (endDate > dateAddDays(startDate, LIMITS.maxSpanDays - 1)) endDate = dateAddDays(startDate, LIMITS.maxSpanDays - 1);

    if ((from && endDate < from) || (to && startDate > to)) return true;
    const key = `${uid}|${startDate}|${start.time ?? ''}`;
    if (seen.has(key)) return true;
    seen.add(key);

    events.push({
      uid,
      title: clean(item.summary, LIMITS.maxTitle) || '(no title)',
      location: clean(item.location, LIMITS.maxLocation) || null,
      description: clean(item.description, LIMITS.maxDescription) || null,
      start_date: startDate,
      start_time: allDay ? null : start.time,
      end_date: endDate,
      end_time: allDay ? null : (end.time ?? start.time),
      all_day: allDay ? 1 : 0,
    });
    return true;
  };

  for (const [uid, { main, changes }] of series) {
    if (events.length >= LIMITS.maxEvents) break;

    // A lone changed instance (its series is not in this file) is still a real event.
    if (!main) {
      for (const ev of changes) push(uid, { component: ev.component, summary: ev.summary, location: ev.location, description: ev.description }, ev.startDate, ev.endDate);
      continue;
    }

    if (!main.isRecurring()) {
      push(uid, { component: main.component, summary: main.summary, location: main.location, description: main.description }, main.startDate, main.endDate);
      continue;
    }

    for (const change of changes) {
      try {
        main.relateException(change);
      } catch {
        /* an exception that does not belong to this series */
      }
    }
    let iterations = 0;
    let produced = 0;
    try {
      const it = main.iterator();
      for (let next = it.next(); next; next = it.next()) {
        iterations += 1;
        if (iterations > LIMITS.maxIterationsPerSeries || produced >= LIMITS.maxOccurrencesPerSeries) break;
        const startWall = toWall(next, tzidOf(main.component, 'dtstart'), targetTz);
        if (to && startWall.date > dateAddDays(to, 1)) break; // the series is past the window
        const detail = main.getOccurrenceDetails(next);
        const item = detail.item ?? main;
        const before = events.length;
        if (!push(uid, { component: item.component, summary: item.summary, location: item.location, description: item.description }, detail.startDate, detail.endDate)) break;
        if (events.length > before) produced += 1;
      }
    } catch {
      /* a rule the library cannot expand: keep what was produced */
    }
  }

  events.sort((a, b) => (a.start_date + (a.start_time ?? '')).localeCompare(b.start_date + (b.start_time ?? '')));
  return { name: name || null, timezone: targetTz, events };
}
