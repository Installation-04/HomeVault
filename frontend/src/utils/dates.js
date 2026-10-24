// Dates in HomeVault are plain YYYY-MM-DD strings (what <input type="date">
// produces). Parse them as *local* dates so a date never shifts a day because
// of the browser's timezone.
const pad = (n) => String(n).padStart(2, '0');

export const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => toDateStr(new Date());

export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(str, n) {
  const d = parseDate(str);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

// Whole days from `fromStr` to `toStr` (negative when `toStr` is earlier).
export function daysBetween(fromStr, toStr) {
  return Math.round((parseDate(toStr) - parseDate(fromStr)) / 86400000);
}

export function formatDate(str, locale) {
  if (!str) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(parseDate(str));
}

// "tomorrow", "in 5 days", "3 days ago" -- localized.
export function relativeDays(str, locale, from = todayStr()) {
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(daysBetween(from, str), 'day');
}

// null (no date) | 'expired' | 'soon' | 'ok'
export function expiryStatus(str, soonDays = 30, from = todayStr()) {
  if (!str) return null;
  const n = daysBetween(from, str);
  if (n < 0) return 'expired';
  return n <= soonDays ? 'soon' : 'ok';
}

export function monthLabel(year, month, locale) {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(year, month, 1));
}

// Narrow weekday names starting on Sunday, localized.
export function weekdayLabels(locale) {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
}

// SQLite stores timestamps as UTC "YYYY-MM-DD HH:MM:SS"; turn one into a Date.
export const parseSqlTime = (str) => (str ? new Date(`${String(str).replace(' ', 'T')}Z`) : null);

export function formatDateTime(str, locale) {
  const d = parseSqlTime(str);
  return d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d) : '—';
}

// "5 minutes ago", "yesterday" -- localized.
export function timeAgo(str, locale, now = Date.now()) {
  const d = parseSqlTime(str);
  if (!d || Number.isNaN(d.getTime())) return '—';
  const seconds = Math.round((d.getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'second');
}
