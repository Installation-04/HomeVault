// Advances a YYYY-MM-DD date string by the given recurrence rule.
export function advanceDate(dateStr, recurrence, intervalDays) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (recurrence === 'monthly') {
    d.setUTCMonth(d.getUTCMonth() + 1);
  } else if (recurrence === 'yearly') {
    d.setUTCFullYear(d.getUTCFullYear() + 1);
  } else if (recurrence === 'custom') {
    d.setUTCDate(d.getUTCDate() + (intervalDays || 30));
  }
  return d.toISOString().slice(0, 10);
}
