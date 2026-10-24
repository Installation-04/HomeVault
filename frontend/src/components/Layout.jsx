import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext.jsx';
import PropertySwitcher from './PropertySwitcher.jsx';
import InstallPrompt from './InstallPrompt.jsx';

const SearchPalette = lazy(() => import('./SearchPalette.jsx'));

const navItem = ({ isActive }) =>
  `px-3 py-2 rounded-md text-sm font-medium ${isActive ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-brand-50'}`;

const tabItem = ({ isActive }) =>
  `flex flex-col items-center justify-center gap-0.5 flex-1 py-1.5 text-[11px] font-medium ${
    isActive ? 'text-brand-700' : 'text-gray-500'
  }`;

const icons = {
  dashboard: (
    <path d="M3 11.5 12 4l9 7.5M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
  ),
  documents: (
    <path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v4h4M9 12h6M9 16h6" />
  ),
  equipment: (
    <path d="m14.7 6.3 3 3-7.4 7.4a3 3 0 0 1-2.1.9H5v-3.2a3 3 0 0 1 .9-2.1l7.4-7.4a2.1 2.1 0 0 1 3 0l.7.7a2.1 2.1 0 0 1 0 3ZM4 20h16" />
  ),
  calendar: (
    <path d="M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6ZM4 10h16M8 3v4M16 3v4" />
  ),
  expenses: (
    <path d="M12 3v18M17 6.5c0-1.4-1.8-2.5-5-2.5S7 5.1 7 6.5 8.8 9 12 9s5 1.1 5 2.5-1.8 2.5-5 2.5-5-1.1-5-2.5" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
};

function TabIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {icons[name]}
    </svg>
  );
}

export default function Layout({ children }) {
  const { t, i18n } = useTranslation();
  const { user, logout, updateProfile } = useAuth();

  const [searchOpen, setSearchOpen] = useState(false);

  // Ctrl/Cmd+K opens "find anything" from every page.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep <html lang> in sync for screen readers and hyphenation.
  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  const changeLanguage = (lng) => {
    i18n.changeLanguage(lng);
    try {
      localStorage.setItem('locale', lng);
    } catch {
      /* storage unavailable */
    }
    // Also remember it on the account so reminder emails use the same language.
    updateProfile({ locale: lng }).catch(() => {});
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header
        className="bg-white border-b sticky top-0 z-10"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-4">
            <span className="text-lg font-bold text-brand-700">{t('app_name')}</span>
            <nav className="hidden sm:flex gap-1">
              <NavLink to="/" end className={navItem}>{t('nav.dashboard')}</NavLink>
              <NavLink to="/documents" className={navItem}>{t('nav.documents')}</NavLink>
              <NavLink to="/equipment" className={navItem}>{t('nav.equipment')}</NavLink>
              <NavLink to="/calendar" className={navItem}>{t('nav.calendar')}</NavLink>
              <NavLink to="/expenses" className={navItem}>{t('nav.expenses')}</NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <PropertySwitcher />
            <select
              className="text-sm border rounded px-1 py-1"
              value={i18n.language}
              aria-label={t('settings.language')}
              onChange={(e) => changeLanguage(e.target.value)}
            >
              <option value="en">EN</option>
              <option value="fr">FR</option>
            </select>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label={t('search.title')}
              title={`${t('search.title')} (Ctrl+K)`}
              className="p-1 rounded text-gray-500 hover:text-brand-700"
            >
              <TabIcon name="search" />
            </button>
            <NavLink
              to="/settings"
              aria-label={t('nav.settings')}
              title={t('nav.settings')}
              className={({ isActive }) => `p-1 rounded ${isActive ? 'text-brand-700 bg-brand-50' : 'text-gray-500 hover:text-brand-700'}`}
            >
              <TabIcon name="settings" />
            </NavLink>
            <span className="text-sm text-gray-500 hidden sm:inline">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-brand-700 whitespace-nowrap">
              {t('nav.logout')}
            </button>
          </div>
        </div>
      </header>

      <InstallPrompt />

      {searchOpen && (
        <Suspense fallback={null}>
          <SearchPalette onClose={() => setSearchOpen(false)} />
        </Suspense>
      )}

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 pb-20 sm:pb-6">{children}</main>

      {/* Mobile bottom tab bar — the primary nav on phones, where a cramped
          top row of text links doesn't hold up under one-handed use. */}
      <nav
        className="sm:hidden fixed bottom-0 inset-x-0 z-10 bg-white border-t flex"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <NavLink to="/" end className={tabItem}>
          <TabIcon name="dashboard" />
          {t('nav.dashboard')}
        </NavLink>
        <NavLink to="/documents" className={tabItem}>
          <TabIcon name="documents" />
          {t('nav.documents')}
        </NavLink>
        <NavLink to="/equipment" className={tabItem}>
          <TabIcon name="equipment" />
          {t('nav.equipment')}
        </NavLink>
        <NavLink to="/calendar" className={tabItem}>
          <TabIcon name="calendar" />
          {t('nav.calendar')}
        </NavLink>
        <NavLink to="/expenses" className={tabItem}>
          <TabIcon name="expenses" />
          {t('nav.expenses')}
        </NavLink>
      </nav>
    </div>
  );
}
