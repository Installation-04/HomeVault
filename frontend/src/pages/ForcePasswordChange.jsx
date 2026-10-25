import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { btnPrimary, input, label } from '../components/ui.js';

// Shown instead of the app after an admin created the account or reset its
// password: the temporary password has to be replaced before anything else.
export default function ForcePasswordChange() {
  const { t } = useTranslation();
  const { user, refresh, logout } = useAuth();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (form.next !== form.confirm) {
      setError(t('settings.passwords_dont_match'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.changePassword({ current_password: form.current, new_password: form.next });
      await refresh();
    } catch (err) {
      setError(err.code === 'bad_current_password' ? t('settings.current_password_wrong') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-surface p-6 rounded-lg shadow space-y-3">
        <h1 className="text-xl font-bold text-brand-700">{t('force.title')}</h1>
        <p className="text-sm text-gray-600">{t('force.intro', { name: user.name })}</p>
        <div>
          <label htmlFor="fp-current" className={label}>{t('force.temporary_password')}</label>
          <input id="fp-current" type="password" autoComplete="current-password" className={input} value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required autoFocus />
        </div>
        <div>
          <label htmlFor="fp-new" className={label}>{t('settings.new_password')}</label>
          <input id="fp-new" type="password" autoComplete="new-password" minLength={10} className={input} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required />
          <p className="text-xs text-gray-400 mt-1">{t('settings.password_hint')}</p>
        </div>
        <div>
          <label htmlFor="fp-confirm" className={label}>{t('settings.confirm_password')}</label>
          <input id="fp-confirm" type="password" autoComplete="new-password" className={input} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button className={`${btnPrimary} w-full py-2`} disabled={busy}>
          {t('settings.change_password')}
        </button>
        <button type="button" onClick={logout} className="w-full text-xs text-gray-500 hover:underline">
          {t('nav.logout')}
        </button>
      </form>
    </div>
  );
}
