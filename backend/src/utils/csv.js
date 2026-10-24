// Cells starting with = + - @ are executed as formulas by Excel/Sheets, so text
// entered by one family member (e.g. "=HYPERLINK(...)") would run on whoever
// opens the export. Free-text cells get an apostrophe prefix; numbers don't
// (a refund of -25 must stay -25).
export function csvCell(value, { text = false } = {}) {
  let s = String(value ?? '');
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// rows: arrays of { value, text? } or plain values. A UTF-8 BOM makes Excel
// show accented characters correctly.
export function toCsv(header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(row.map((cell) => (cell && typeof cell === 'object' && 'value' in cell ? csvCell(cell.value, { text: cell.text }) : csvCell(cell))).join(','));
  }
  return '﻿' + lines.join('\r\n');
}
