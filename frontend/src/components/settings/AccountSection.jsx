import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { btnPrimary, btnSecondary, card, input, label } from '../ui.js';
import { Feedback, useAction } from './shared.jsx';

export default function AccountSection() {
  const { t, i18n } = useTranslation();
  const { user, updateProfile } = useAuth();
  const [name, setName] = useState(user.name);
  const [profile, runProfile] = useAction();
  const [pw, setPw] = useState({ current_password: '', new_password: '', confirm: '' });
  const [pwState, runPw] = useAction();
  const [mismatch, setMismatch] = useState(false);

  const saveProfile = (e) => {
    e.preventDefault();
    runProfile(() => updateProfile({ name }));
  };

  const changePassword = async (e) => {
    e.preventDefault();
    if (pw.new_password !== pw.confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    const ok = await runPw(() => api.changePassword({ current_password: pw.current_password, new_password: pw.new_password }));
    if (ok) setPw({ current_password: '', new_password: '', confirm: '' });
  };

  const changeLanguage = (lng) => {
    i18n.changeLanguage(lng);
    try {
      localStorage.setItem('locale', lng);
    } catch {
      /* storage unavailable */
    }
    updateProfile({ locale: lng }).catch(() => {});
  };

  return (
    <section className={card}>
      <h2 className="font-semibold mb-1">{t('settings.my_account')}</h2>
      <p className="text-xs text-gray-500 mb-3">{user.email}</p>

      <form onSubmit={saveProfile} className="grid gap-3 sm:grid-cols-2 text-sm">
        <div>
          <label className={label} htmlFor="me-name">{t('login.name')}</label>
          <input id="me-name" className={input} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className={label} htmlFor="me-lang">{t('settings.language')}</label>
          <select id="me-lang" className={input} value={i18n.language.slice(0, 2)} onChange={(e) => changeLanguage(e.target.value)}>
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">{t('settings.language_hint')}</p>
        </div>
        <div className="sm:col-span-2 flex items-center gap-3">
          <button className={btnSecondary} disabled={profile.busy || name.trim() === user.name}>{t('common.save')}</button>
          <Feedback state={profile} />
        </div>
      </form>

      <form onSubmit={changePassword} className="grid gap-3 sm:grid-cols-3 text-sm mt-5 pt-4 border-t">
        <h3 className="sm:col-span-3 font-medium">{t('settings.change_password')}</h3>
        <div>
          <label className={label} htmlFor="pw-current">{t('settings.current_password')}</label>
          <input id="pw-current" type="password" autoComplete="current-password" className={input} value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} required />
        </div>
        <div>
          <label className={label} htmlFor="pw-new">{t('settings.new_password')}</label>
          <input id="pw-new" type="password" autoComplete="new-password" minLength={10} className={input} value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} required />
        </div>
        <div>
          <label className={label} htmlFor="pw-confirm">{t('settings.confirm_password')}</label>
          <input id="pw-confirm" type="password" autoComplete="new-password" className={input} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
        </div>
        <div className="sm:col-span-3 flex items-center gap-3">
          <button className={btnPrimary} disabled={pwState.busy}>{t('settings.change_password')}</button>
          {mismatch ? <p role="alert" className="text-sm text-red-600">{t('settings.passwords_dont_match')}</p> : <Feedback state={pwState} />}
        </div>
        <p className="sm:col-span-3 text-xs text-gray-400">{t('settings.password_hint')} {t('settings.password_signs_out')}</p>
      </form>
    </section>
  );
}
