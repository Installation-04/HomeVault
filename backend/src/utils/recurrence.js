const fmt = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  // Clamp to the last day of the target month: Jan 31 + 1 month is Feb 28,
  // not Mar 3 (which is what Date#setUTCMonth overflow would give).
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fmt(year, month + 1, Math.min(d, lastDay));
}

function customDays(intervalDays) {
  const n = Number(intervalDays);
  return Number.isInteger(n) && n > 0 ? n : 30;
}

// The k-th occurrence after `dateStr`, always counted from the original date
// so a month-end clamp in one period doesn't permanently shift the cadence.
function occurrence(dateStr, recurrence, intervalDays, k) {
  if (recurrence === 'monthly') return addMonths(dateStr, k);
  if (recurrence === 'yearly') return addMonths(dateStr, 12 * k);
  if (recurrence === 'custom') {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + customDays(intervalDays) * k);
    return d.toISOString().slice(0, 10);
  }
  return dateStr;
}

// Advances a YYYY-MM-DD date string by one period of the given recurrence rule.
export function advanceDate(dateStr, recurrence, intervalDays) {
  return occurrence(dateStr, recurrence, intervalDays, 1);
}

// First occurrence strictly after `afterStr` (usually today). Completing a
// recurring item that is months overdue should land on the next real
// upcoming date, not on another date in the past.
export function nextOccurrenceAfter(dateStr, recurrence, intervalDays, afterStr) {
  if (!['monthly', 'yearly', 'custom'].includes(recurrence)) return dateStr;
  let k = 1;
  let next = occurrence(dateStr, recurrence, intervalDays, k);
  while (next <= afterStr && k < 10000) {
    k += 1;
    next = occurrence(dateStr, recurrence, intervalDays, k);
  }
  return next;
}
