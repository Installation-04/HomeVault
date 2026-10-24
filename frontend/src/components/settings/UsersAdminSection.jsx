import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { timeAgo } from '../../utils/dates.js';
import { useConfirm } from '../ConfirmDialog.jsx';
import ErrorBox from '../ErrorBox.jsx';
import Modal from '../Modal.jsx';
import { btnPrimary, btnSecondary, card, input, label } from '../ui.js';
import { Badge, CopyButton, Feedback, useAction } from './shared.jsx';

function TempPasswordDialog({ title, intro, password, onClose }) {
  const { t } = useTranslation();
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-gray-700">{intro}</p>
        <p className="font-mono text-lg bg-gray-50 rounded p-3 text-center select-all break-all">{password}</p>
        <div className="flex justify-between items-center">
          <CopyButton text={password} />
          <button className={btnPrimary} onClick={onClose}>{t('common.done')}</button>
        </div>
        <p className="text-xs text-gray-500">{t('admin.temp_shown_once')}</p>
      </div>
    </Modal>
  );
}

export default function UsersAdminSection() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const { data: accounts, error, reload } = useAsync(() => api.users.list(), []);
  const [form, setForm] = useState({ name: '', email: '', password: '', is_admin: false });
  const [state, run] = useAction();
  const [actionError, setActionError] = useState('');
  const [temp, setTemp] = useState(null); // { title, intro, password }

  const act = async (fn) => {
    setActionError('');
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  };

  const create = async (e) => {
    e.preventDefault();
    const created = await run(async () => {
      await api.users.create(form);
      return form;
    });
    if (created) {
      setTemp({ title: t('admin.account_created'), intro: t('admin.account_created_intro', { email: form.email }), password: form.password });
      setForm({ name: '', email: '', password: '', is_admin: false });
      reload();
    }
  };

  const resetPassword = (u) =>
    confirm({ message: t('admin.reset_password_confirm', { name: u.name }), confirmLabel: t('admin.reset_password') }).then((ok) => {
      if (!ok) return;
      act(async () => {
        const res = await api.users.resetPassword(u.id);
        setTemp({ title: t('admin.reset_password'), intro: t('admin.reset_password_intro', { name: u.name }), password: res.temp_password });
      });
    });

  const remove = (u) =>
    confirm({ message: t('admin.delete_confirm', { name: u.name }), danger: true }).then((ok) => ok && act(() => api.users.remove(u.id)));

  const resetTwoFactor = (u) =>
    confirm({ message: t('admin.reset_2fa_confirm', { name: u.name }), danger: true, confirmLabel: t('admin.reset_2fa') }).then((ok) => ok && act(() => api.users.resetTwoFactor(u.id)));

  return (
    <section className={card}>
      <h2 className="font-semibold">{t('settings.accounts')}</h2>
      <p className="text-xs text-gray-500 mb-3">{t('settings.accounts_hint')}</p>
      <ErrorBox error={error || (actionError && { message: actionError })} onRetry={error ? reload : undefined} />

      <ul className="divide-y text-sm mb-4">
        {(accounts || []).map((u) => {
          const self = u.id === me.id;
          return (
            <li key={u.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{u.name}</span>
                {self && <span className="text-xs text-gray-400">({t('settings.you')})</span>}
                {u.is_admin && <Badge tone="brand">{t('settings.admin')}</Badge>}
                {u.totp_enabled && <Badge tone="green">2FA</Badge>}
                {u.disabled && <Badge tone="red">{t('admin.disabled')}</Badge>}
                {u.must_change_password && <Badge tone="amber">{t('admin.must_change')}</Badge>}
              </div>
              <p className="text-xs text-gray-500">
                {u.email} · {u.last_login_at ? t('admin.last_login', { when: timeAgo(u.last_login_at, i18n.language) }) : t('admin.never_logged_in')}
              </p>
              {!self && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs">
                  <button className="text-brand-700 hover:underline" onClick={() => act(() => api.users.update(u.id, { disabled: !u.disabled }))}>
                    {u.disabled ? t('admin.enable') : t('admin.disable')}
                  </button>
                  <button className="text-brand-700 hover:underline" onClick={() => act(() => api.users.update(u.id, { is_admin: !u.is_admin }))}>
                    {u.is_admin ? t('admin.remove_admin') : t('admin.make_admin')}
                  </button>
                  <button className="text-brand-700 hover:underline" onClick={() => resetPassword(u)}>{t('admin.reset_password')}</button>
                  {u.totp_enabled && <button className="text-brand-700 hover:underline" onClick={() => resetTwoFactor(u)}>{t('admin.reset_2fa')}</button>}
                  <button className="text-red-600 hover:underline" onClick={() => remove(u)}>{t('common.delete')}</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <form onSubmit={create} className="grid gap-2 sm:grid-cols-3 text-sm pt-3 border-t">
        <h3 className="sm:col-span-3 font-medium">{t('settings.add_account')}</h3>
        <div>
          <label className={label} htmlFor="acc-name">{t('login.name')}</label>
          <input id="acc-name" className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div>
          <label className={label} htmlFor="acc-email">{t('login.email')}</label>
          <input id="acc-email" type="email" className={input} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </div>
        <div>
          <label className={label} htmlFor="acc-pw">{t('settings.temp_password')}</label>
          <input id="acc-pw" type="text" autoComplete="off" spellCheck="false" minLength={10} className={`${input} font-mono`} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </div>
        <label className="sm:col-span-3 flex items-center gap-2">
          <input type="checkbox" checked={form.is_admin} onChange={(e) => setForm({ ...form, is_admin: e.target.checked })} />
          {t('admin.make_admin_checkbox')}
        </label>
        <div className="sm:col-span-3 flex items-center gap-3">
          <button className={btnPrimary} disabled={state.busy}>{t('settings.add_account')}</button>
          <Feedback state={state} />
        </div>
        <p className="sm:col-span-3 text-xs text-gray-400">{t('admin.temp_hint')}</p>
      </form>

      {temp && <TempPasswordDialog {...temp} onClose={() => setTemp(null)} />}
    </section>
  );
}
