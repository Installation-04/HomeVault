import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useConfirm } from '../ConfirmDialog.jsx';
import ErrorBox from '../ErrorBox.jsx';
import { btnPrimary, card, input, label } from '../ui.js';
import { Feedback, useAction } from './shared.jsx';

export default function MembersSection({ property, isAdmin }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { user } = useAuth();
  const { data: members, error, reload } = useAsync(() => api.properties.members(property.id), [property.id]);
  // Admins can pick from the household's accounts; owners type an email.
  const { data: accounts } = useAsync(() => (isAdmin ? api.users.list() : Promise.resolve([])), [isAdmin]);
  const [form, setForm] = useState({ email: '', role: 'viewer' });
  const [state, run] = useAction();
  const [actionError, setActionError] = useState('');

  const share = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.properties.share(property.id, form));
    if (ok) {
      setForm({ email: '', role: 'viewer' });
      reload();
    }
  };

  const changeRole = async (m, role) => {
    setActionError('');
    try {
      await api.properties.share(property.id, { email: m.email, role });
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  };

  const remove = async (m) => {
    const ok = await confirm({ message: t('settings.remove_member_confirm', { name: m.name }), danger: true, confirmLabel: t('settings.remove') });
    if (!ok) return;
    setActionError('');
    try {
      await api.properties.removeMember(property.id, m.user_id);
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  };

  const memberEmails = new Set((members || []).map((m) => m.email));
  const suggestions = (accounts || []).filter((a) => !memberEmails.has(a.email) && !a.disabled);

  return (
    <section className={card}>
      <h2 className="font-semibold">{t('settings.members')}</h2>
      <p className="text-xs text-gray-500 mb-3">{t('settings.members_hint')}</p>
      <ErrorBox error={error} onRetry={reload} />
      {actionError && <p role="alert" className="text-sm text-red-600 mb-2">{actionError}</p>}

      <ul className="divide-y text-sm mb-4">
        {(members || []).map((m) => (
          <li key={m.user_id} className="py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium truncate">
                {m.name} {m.user_id === user.id && <span className="text-xs text-gray-400">({t('settings.you')})</span>}
              </p>
              <p className="text-xs text-gray-500 truncate">{m.email}</p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <select aria-label={t('settings.role')} className="border rounded px-2 py-1 text-xs" value={m.role} onChange={(e) => changeRole(m, e.target.value)}>
                <option value="owner">{t('role.owner')}</option>
                <option value="viewer">{t('role.viewer')}</option>
              </select>
              <button onClick={() => remove(m)} className="text-red-600 hover:underline text-xs">{t('settings.remove')}</button>
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={share} className="grid gap-2 sm:grid-cols-[1fr_auto_auto] items-end text-sm">
        <div>
          <label className={label} htmlFor="share-email">{t('settings.share_with')}</label>
          <input
            id="share-email"
            type="email"
            list="share-suggestions"
            className={input}
            placeholder={t('login.email')}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <datalist id="share-suggestions">
            {suggestions.map((a) => (
              <option key={a.id} value={a.email}>{a.name}</option>
            ))}
          </datalist>
        </div>
        <div>
          <label className={label} htmlFor="share-role">{t('settings.role')}</label>
          <select id="share-role" className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="viewer">{t('role.viewer')}</option>
            <option value="owner">{t('role.owner')}</option>
          </select>
        </div>
        <button className={btnPrimary} disabled={state.busy}>{t('settings.share')}</button>
      </form>
      <div className="mt-2"><Feedback state={state} /></div>
      <p className="text-xs text-gray-400 mt-2">{t('settings.role_hint')}</p>
    </section>
  );
}
