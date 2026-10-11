import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useProperties } from '../property/PropertyContext.jsx';
import { useAsync } from '../hooks/useAsync.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import ErrorBox from '../components/ErrorBox.jsx';
import { btnDanger, btnPrimary, btnSecondary, card, input, label } from '../components/ui.js';

const PROPERTY_TYPES = ['house', 'condo', 'rental', 'cottage', 'other'];

// Small helper for forms: runs an async action, tracks busy/error/"saved".
function useAction() {
  const [state, setState] = useState({ busy: false, error: '', saved: false });
  useEffect(() => {
    if (!state.saved) return undefined;
    const id = setTimeout(() => setState((s) => ({ ...s, saved: false })), 2500);
    return () => clearTimeout(id);
  }, [state.saved]);
  const run = async (fn) => {
    setState({ busy: true, error: '', saved: false });
    try {
      await fn();
      setState({ busy: false, error: '', saved: true });
      return true;
    } catch (err) {
      setState({ busy: false, error: err.message, saved: false });
      return false;
    }
  };
  return [state, run];
}

function Feedback({ state }) {
  const { t } = useTranslation();
  if (state.error) return <p role="alert" className="text-sm text-red-600">{state.error}</p>;
  if (state.saved) return <p role="status" className="text-sm text-emerald-700">✓ {t('common.saved')}</p>;
  return null;
}

function PropertySection({ property, canEdit }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { refresh } = useProperties();
  const [form, setForm] = useState(null);
  const [state, run] = useAction();
  const [deleteState, runDelete] = useAction();

  useEffect(() => {
    setForm({
      name: property.name || '',
      address: property.address || '',
      type: property.type || '',
      purchase_date: property.purchase_date || '',
      notes: property.notes || '',
    });
  }, [property]);

  if (!form) return null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      await api.properties.update(property.id, form);
      await refresh();
    });
  };

  const remove = async () => {
    const ok = await confirm({
      title: t('settings.delete_property'),
      message: t('settings.delete_property_confirm', { name: property.name }),
      danger: true,
    });
    if (!ok) return;
    const done = await runDelete(async () => {
      await api.properties.remove(property.id);
      await refresh();
    });
    if (done) navigate('/');
  };

  return (
    <section className={card}>
      <h2 className="font-semibold mb-3">{t('settings.property')}</h2>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2 text-sm">
        <div>
          <label className={label} htmlFor="p-name">{t('properties.name')}</label>
          <input id="p-name" className={input} value={form.name} onChange={(e) => set({ name: e.target.value })} required disabled={!canEdit} />
        </div>
        <div>
          <label className={label} htmlFor="p-type">{t('properties.type')}</label>
          <select id="p-type" className={input} value={form.type} onChange={(e) => set({ type: e.target.value })} disabled={!canEdit}>
            <option value="">—</option>
            {PROPERTY_TYPES.map((p) => (
              <option key={p} value={p}>{t(`property_type.${p}`)}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="p-address">{t('properties.address')}</label>
          <input id="p-address" className={input} value={form.address} onChange={(e) => set({ address: e.target.value })} disabled={!canEdit} />
        </div>
        <div>
          <label className={label} htmlFor="p-date">{t('properties.purchase_date')}</label>
          <input id="p-date" type="date" className={input} value={form.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} disabled={!canEdit} />
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="p-notes">{t('properties.notes')}</label>
          <textarea id="p-notes" rows={2} className={input} value={form.notes} onChange={(e) => set({ notes: e.target.value })} disabled={!canEdit} />
        </div>
        {canEdit ? (
          <div className="sm:col-span-2 flex items-center gap-3">
            <button className={btnPrimary} disabled={state.busy}>{t('common.save')}</button>
            <Feedback state={state} />
          </div>
        ) : (
          <p className="sm:col-span-2 text-xs text-gray-500">{t('settings.viewer_note')}</p>
        )}
      </form>

      {canEdit && (
        <div className="mt-5 pt-4 border-t">
          <h3 className="text-sm font-medium text-red-700 mb-1">{t('settings.danger_zone')}</h3>
          <p className="text-xs text-gray-500 mb-2">{t('settings.delete_property_hint')}</p>
          <button className={btnDanger} onClick={remove} disabled={deleteState.busy}>{t('settings.delete_property')}</button>
          <Feedback state={deleteState} />
        </div>
      )}
    </section>
  );
}

function MembersSection({ property, isAdmin }) {
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
  const suggestions = (accounts || []).filter((a) => !memberEmails.has(a.email));

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
              <select
                aria-label={t('settings.role')}
                className="border rounded px-2 py-1 text-xs"
                value={m.role}
                onChange={(e) => changeRole(m, e.target.value)}
              >
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

function AccountsSection() {
  const { t } = useTranslation();
  const { data: accounts, error, reload } = useAsync(() => api.users.list(), []);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [state, run] = useAction();

  const create = async (e) => {
    e.preventDefault();
    const ok = await run(() => api.users.create(form));
    if (ok) {
      setForm({ name: '', email: '', password: '' });
      reload();
    }
  };

  return (
    <section className={card}>
      <h2 className="font-semibold">{t('settings.accounts')}</h2>
      <p className="text-xs text-gray-500 mb-3">{t('settings.accounts_hint')}</p>
      <ErrorBox error={error} onRetry={reload} />
      <ul className="divide-y text-sm mb-4">
        {(accounts || []).map((a) => (
          <li key={a.id} className="py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium truncate">{a.name}</p>
              <p className="text-xs text-gray-500 truncate">{a.email}</p>
            </div>
            {a.is_admin && <span className="text-[11px] px-1.5 py-0.5 rounded bg-brand-100 text-brand-700">{t('settings.admin')}</span>}
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="grid gap-2 sm:grid-cols-3 text-sm">
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
          <input
            id="acc-pw"
            type="password"
            autoComplete="new-password"
            minLength={8}
            className={input}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </div>
        <div className="sm:col-span-3 flex items-center gap-3">
          <button className={btnPrimary} disabled={state.busy}>{t('settings.add_account')}</button>
          <Feedback state={state} />
        </div>
      </form>
    </section>
  );
}

function MyAccountSection() {
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
      <h2 className="font-semibold mb-3">{t('settings.my_account')}</h2>
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
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            className={input}
            value={pw.current_password}
            onChange={(e) => setPw({ ...pw, current_password: e.target.value })}
            required
          />
        </div>
        <div>
          <label className={label} htmlFor="pw-new">{t('settings.new_password')}</label>
          <input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            minLength={8}
            className={input}
            value={pw.new_password}
            onChange={(e) => setPw({ ...pw, new_password: e.target.value })}
            required
          />
        </div>
        <div>
          <label className={label} htmlFor="pw-confirm">{t('settings.confirm_password')}</label>
          <input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            className={input}
            value={pw.confirm}
            onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
            required
          />
        </div>
        <div className="sm:col-span-3 flex items-center gap-3">
          <button className={btnPrimary} disabled={pwState.busy}>{t('settings.change_password')}</button>
          {mismatch ? <p role="alert" className="text-sm text-red-600">{t('settings.passwords_dont_match')}</p> : <Feedback state={pwState} />}
        </div>
        <p className="sm:col-span-3 text-xs text-gray-400">{t('settings.password_hint')}</p>
      </form>
    </section>
  );
}

export default function Settings() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { current, canEdit } = useProperties();

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="font-semibold text-lg">{t('nav.settings')}</h1>
      {current && <PropertySection property={current} canEdit={canEdit} />}
      {current && canEdit && <MembersSection property={current} isAdmin={user.is_admin} />}
      {user.is_admin && <AccountsSection />}
      <MyAccountSection />
    </div>
  );
}
