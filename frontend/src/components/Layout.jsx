import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext.jsx';
import PropertySwitcher from './PropertySwitcher.jsx';

const navItem = ({ isActive }) =>
  `px-3 py-2 rounded-md text-sm font-medium ${isActive ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-brand-50'}`;

export default function Layout({ children }) {
  const { t, i18n } = useTranslation();
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-4">
            <span className="text-lg font-bold text-brand-700">{t('app_name')}</span>
            <nav className="flex gap-1">
              <NavLink to="/" end className={navItem}>{t('nav.dashboard')}</NavLink>
              <NavLink to="/documents" className={navItem}>{t('nav.documents')}</NavLink>
              <NavLink to="/calendar" className={navItem}>{t('nav.calendar')}</NavLink>
              <NavLink to="/expenses" className={navItem}>{t('nav.expenses')}</NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <PropertySwitcher />
            <select
              className="text-sm border rounded px-1 py-1"
              value={i18n.language}
              onChange={(e) => {
                i18n.changeLanguage(e.target.value);
                localStorage.setItem('locale', e.target.value);
              }}
            >
              <option value="en">EN</option>
              <option value="fr">FR</option>
            </select>
            <span className="text-sm text-gray-500 hidden sm:inline">{user?.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-brand-700">
              {t('nav.logout')}
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">{children}</main>
    </div>
  );
}
