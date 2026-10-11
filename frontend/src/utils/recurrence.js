import { parseDate, toDateStr } from './dates.js';

// Mirrors backend/src/utils/recurrence.js so the calendar can show where a
// recurring item will land in future months (the API only stores the next one).
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return toDateStr(new Date(year, month, Math.min(d, lastDay)));
}

function occurrence(dateStr, recurrence, intervalDays, k) {
  if (recurrence === 'monthly') return addMonths(dateStr, k);
  if (recurrence === 'yearly') return addMonths(dateStr, 12 * k);
  if (recurrence === 'custom') {
    const d = parseDate(dateStr);
    const step = Number.isInteger(Number(intervalDays)) && Number(intervalDays) > 0 ? Number(intervalDays) : 30;
    d.setDate(d.getDate() + step * k);
    return toDateStr(d);
  }
  return dateStr;
}

// Future repeats of a recurring item that fall inside [from, to] (inclusive).
export function projectOccurrences(dateStr, recurrence, intervalDays, from, to) {
  if (!['monthly', 'yearly', 'custom'].includes(recurrence)) return [];
  const out = [];
  for (let k = 1; k <= 1000; k += 1) {
    const next = occurrence(dateStr, recurrence, intervalDays, k);
    if (next > to) break;
    if (next >= from) out.push(next);
  }
  return out;
}
