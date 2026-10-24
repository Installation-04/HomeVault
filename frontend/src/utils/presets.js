// One-click maintenance schedules offered on an equipment page, by category.
// Titles come from i18n (presets.<key>); the cadence is the part worth
// standardising -- people forget these precisely because they're infrequent.
export const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP'];

const SEASONAL = { recurrence: 'custom', interval: 180 };
const QUARTERLY = { recurrence: 'custom', interval: 90 };
const YEARLY = { recurrence: 'yearly', interval: null };

export const PRESETS = {
  hvac: [
    { key: 'hvac_filter', ...QUARTERLY },
    { key: 'hvac_service', ...YEARLY },
  ],
  appliance: [
    { key: 'appliance_clean', ...SEASONAL },
    { key: 'appliance_hoses', ...YEARLY },
  ],
  plumbing: [
    { key: 'plumbing_flush', ...YEARLY },
    { key: 'plumbing_leaks', ...SEASONAL },
  ],
  electrical: [
    { key: 'electrical_test', ...SEASONAL },
    { key: 'electrical_batteries', ...YEARLY },
  ],
  tool: [{ key: 'tool_service', ...YEARLY }],
  electronics: [{ key: 'electronics_update', ...SEASONAL }],
  vehicle: [
    { key: 'vehicle_service', ...YEARLY },
    { key: 'vehicle_tires', ...SEASONAL },
  ],
  other: [{ key: 'generic_inspect', ...YEARLY }],
};

export const PRESET_KEYS = Object.values(PRESETS).flat().map((p) => p.key);

// First due date for a preset: one interval from today.
export function firstDueDate(preset, today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (preset.recurrence === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setDate(d.getDate() + preset.interval);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
