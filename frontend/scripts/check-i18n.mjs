// Fails if the EN/FR files drift apart, or if the code asks for a translation
// key that doesn't exist (which would silently render the raw key on screen).
//   node scripts/check-i18n.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRESET_KEYS } = await import(path.join(root, 'src/utils/presets.js'));

// Every audit action the backend can record must have a human-readable label,
// otherwise the activity lists would show raw codes like "mfa_enroll_failed".
function backendAuditActions() {
  const found = new Set();
  const walkDir = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walkDir(p);
    if (!p.endsWith('.js')) return;
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/\baudit\(\s*(?:req|null)\s*,\s*'([a-z_]+)'/g)) found.add(m[1]);
    for (const m of src.matchAll(/\baudit\(\s*'([a-z_]+)'/g)) found.add(m[1]);
  });
  walkDir(path.join(root, '../backend/src'));
  // Emitted through a conditional (audit(req, flag ? 'a' : 'b')), which the patterns above can't see.
  for (const action of ['user_promoted', 'user_demoted']) found.add(action);
  return [...found].sort();
}
const load = (lng) => JSON.parse(fs.readFileSync(path.join(root, 'src/i18n', `${lng}.json`), 'utf8'));
const en = load('en');
const fr = load('fr');
const problems = [];

for (const key of Object.keys(en)) if (!(key in fr)) problems.push(`fr.json is missing "${key}"`);
for (const key of Object.keys(fr)) if (!(key in en)) problems.push(`en.json is missing "${key}"`);

// Placeholders ({{name}}) must match between languages.
const placeholders = (s) => [...String(s).matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort().join(',');
for (const key of Object.keys(en)) {
  if (key in fr && placeholders(en[key]) !== placeholders(fr[key])) problems.push(`"${key}" uses different {{placeholders}} in en/fr`);
}

// Keys built at runtime (t(`category.${c}`)) -- the values each call site can produce.
const DYNAMIC = {
  'category.': ['invoice', 'warranty', 'insurance', 'contract', 'photo', 'maintenance', 'tax', 'other'],
  'equipment_category.': ['appliance', 'hvac', 'plumbing', 'electrical', 'tool', 'electronics', 'vehicle', 'other'],
  'expense_category.': ['maintenance', 'insurance', 'tax', 'utility', 'improvement', 'other'],
  'reminder_category.': ['maintenance', 'insurance_renewal', 'payment', 'other'],
  'recurrence.': ['none', 'monthly', 'yearly', 'custom'],
  'property_type.': ['house', 'condo', 'rental', 'cottage', 'other'],
  'role.': ['owner', 'viewer'],
  'status.': ['expired', 'soon', 'ok'],
  'calendar.type_': ['reminder', 'task'],
  'calendar.view_': ['list', 'month'],
  'dashboard.count_': ['documents', 'equipment', 'calendar'],
  'audit.': backendAuditActions(),
  'presets.': PRESET_KEYS,
  'search.group_': ['documents', 'equipment', 'reminders', 'tasks', 'expenses'],
  'theme.': ['system', 'light', 'dark'],
};
for (const [prefix, values] of Object.entries(DYNAMIC)) {
  for (const v of values) if (!(`${prefix}${v}` in en)) problems.push(`missing dynamic key "${prefix}${v}"`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(jsx?|mjs)$/.test(e.name) ? [p] : [];
  });
}

const used = new Map();
for (const file of walk(path.join(root, 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*(['"])([A-Za-z0-9_.]+)\1/g)) used.set(m[2], file);
  for (const m of src.matchAll(/\bt\(\s*`([A-Za-z0-9_.]+)\$\{/g)) {
    if (!DYNAMIC[m[1]]) problems.push(`${path.relative(root, file)}: dynamic key prefix "${m[1]}" is not listed in scripts/check-i18n.mjs`);
  }
}
for (const [key, file] of used) {
  if (!(key in en)) problems.push(`${path.relative(root, file)}: unknown translation key "${key}"`);
}

if (problems.length) {
  console.error(problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`i18n OK: ${Object.keys(en).length} keys, ${used.size} used statically`);
