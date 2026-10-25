// Light / dark theme. The choice is "system" (follow the device), "light" or "dark", remembered
// per device in localStorage. public/theme-init.js applies it before the first paint so a dark
// page never flashes white; this module keeps it in step afterwards.
import { useSyncExternalStore } from 'react';

const KEY = 'theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const CHANGED = 'hv-themechange';
const BAR_COLOR = { light: '#0f766e', dark: '#0b1120' };

export const THEMES = ['system', 'light', 'dark'];

export function getThemePreference() {
  try {
    const stored = localStorage.getItem(KEY);
    return THEMES.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

const prefersDark = () => typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;

export const resolveTheme = (preference = getThemePreference()) =>
  preference === 'system' ? (prefersDark() ? 'dark' : 'light') : preference;

// Puts the theme on <html> (the class drives the CSS variables) and tints the browser's address bar.
export function applyTheme(preference = getThemePreference()) {
  const resolved = resolveTheme(preference);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLOR[resolved]);
  return resolved;
}

export function setThemePreference(preference) {
  try {
    if (preference === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  } catch {
    /* storage unavailable: the choice lasts until the page is closed */
  }
  applyTheme(preference);
  window.dispatchEvent(new Event(CHANGED));
}

// Call once at start-up. Follows the device when the preference is "system", picks up a change made
// in another tab, and prints on a light page whatever the theme (labels and QR codes go on paper).
export function initTheme() {
  applyTheme();
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(DARK_QUERY).addEventListener('change', () => {
      if (getThemePreference() === 'system') {
        applyTheme();
        window.dispatchEvent(new Event(CHANGED));
      }
    });
  }
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) {
      applyTheme();
      window.dispatchEvent(new Event(CHANGED));
    }
  });
  window.addEventListener('beforeprint', () => document.documentElement.classList.remove('dark'));
  window.addEventListener('afterprint', () => applyTheme());
}

function subscribe(callback) {
  window.addEventListener(CHANGED, callback);
  return () => window.removeEventListener(CHANGED, callback);
}

// { preference: 'system' | 'light' | 'dark', resolved: 'light' | 'dark', setPreference }
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, getThemePreference, () => 'system');
  const resolved = useSyncExternalStore(subscribe, () => resolveTheme(), () => 'light');
  return { preference, resolved, setPreference: setThemePreference };
}
