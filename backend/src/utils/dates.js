const pad = (n) => String(n).padStart(2, '0');

// Today's date as YYYY-MM-DD in the server's local timezone (the container's
// TZ), so "due today" matches what the household sees on the wall calendar
// rather than the UTC date SQLite's date('now') would give.
export function localToday(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
