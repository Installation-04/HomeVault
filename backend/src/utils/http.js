export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Positive integer from a route/body value, or null. Rejects '1.5', '1e3',
// '../../x', etc. so ids can be used in file paths and SQL safely.
export function parseId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value)) return Number(value);
  return null;
}

// Strict YYYY-MM-DD that is also a real calendar day (rejects 2026-02-31).
export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Escape LIKE wildcards so a search for "100%" matches literally.
// Use together with: LIKE ? ESCAPE '\'
export function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, '\\$&')}%`;
}

// PUT helper: for each key present in the body use it (empty string -> NULL,
// so a field can be cleared); for absent keys keep the stored value.
export function mergeFields(body, current, keys) {
  const out = {};
  for (const key of keys) {
    if (Object.hasOwn(body, key)) {
      const v = body[key];
      out[key] = v === '' || v === undefined ? null : v;
    } else {
      out[key] = current[key] ?? null;
    }
  }
  return out;
}

export const RECURRENCES = ['none', 'monthly', 'yearly', 'custom'];

// Validates recurrence + custom interval; returns an error message or null.
export function recurrenceError(recurrence, intervalDays) {
  if (!RECURRENCES.includes(recurrence)) return `recurrence must be one of ${RECURRENCES.join(', ')}`;
  if (recurrence === 'custom' && parseId(intervalDays === null || intervalDays === undefined ? null : Number(intervalDays)) === null) {
    return 'recurrence_interval_days must be a positive whole number for custom recurrence';
  }
  return null;
}
