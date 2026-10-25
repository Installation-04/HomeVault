import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { timeAgo } from '../../utils/dates.js';
import { useConfirm } from '../ConfirmDialog.jsx';
import ErrorBox from '../ErrorBox.jsx';
import { btnPrimary, btnSecondary, card, input, label } from '../ui.js';
import { useAction } from './shared.jsx';

const INTERVALS = [120, 360, 720, 1440];

const STATUS_STYLE = {
  ok: 'bg-emerald-100 text-emerald-800',
  error: 'bg-red-100 text-red-700',
  paused: 'bg-gray-100 text-gray-600',
};

const hours = (t, minutes) => t('integrations.hours_short', { n: minutes / 60 });

// One connected bank: which accounts to read, when it last ran, and the usual controls.
function Connection({ item, onChange }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const accounts = item.summary?.accounts ?? [];
  const [picked, setPicked] = useState(() => new Set(item.selected_accounts ?? []));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const status = item.paused ? 'paused' : item.status === 'error' ? 'error' : 'ok';
  const savedCount = (item.selected_accounts ?? []).length;
  const canSync = !item.paused && (savedCount > 0 || accounts.length === 0);
  const changed = picked.size !== (item.selected_accounts ?? []).length || [...picked].some((id) => !(item.selected_accounts ?? []).includes(id));

  const act = async (what, fn) => {
    setBusy(what);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
      onChange();
    }
  };

  const toggle = (id) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Saving the choice also reads those accounts straight away, so the person sees the result.
  const save = () =>
    act('save', async () => {
      await api.integrations.update(item.id, { accounts: [...picked] });
      if (picked.size === 0) return;
      const synced = await api.integrations.sync(item.id);
      setNotice(t('simplefin.saved_added', { n: synced.summary?.added ?? 0 }));
    });

  const remove = async () => {
    if (!(await confirm({ message: t('simplefin.remove_confirm', { name: item.name }), danger: true, confirmLabel: t('integrations.remove') }))) return;
    act('remove', () => api.integrations.remove(item.id));
  };

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium truncate">
            {item.name} <span className={`ml-1 text-[11px] px-1.5 py-0.5 rounded font-normal ${STATUS_STYLE[status]}`}>{t(`integrations.status_${status}`)}</span>
          </p>
          <p className="text-xs text-gray-500">
            {item.last_sync_at ? t('integrations.last_sync', { when: timeAgo(item.last_sync_at, i18n.language) }) : t('integrations.never')}
            {item.summary && item.selected_accounts?.length > 0 && <> · {t('simplefin.last_added', { n: item.summary.added ?? 0 })}</>}
            {' · '}
            {t('integrations.every', { when: hours(t, item.interval_minutes) })}
            {item.source && <> · {item.source}</>}
          </p>
          {item.last_error && <p role="alert" className="text-xs text-red-600 mt-1">{item.last_error}</p>}
          {error && <p role="alert" className="text-xs text-red-600 mt-1">{error}</p>}
          {notice && <p role="status" className="text-xs text-emerald-700 mt-1">{notice}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 shrink-0 text-xs">
          <button disabled={Boolean(busy) || !canSync} onClick={() => act('sync', () => api.integrations.sync(item.id))} className="text-brand-700 hover:underline disabled:opacity-50 disabled:no-underline">
            {busy === 'sync' ? t('integrations.syncing') : t('integrations.sync_now')}
          </button>
          <button disabled={Boolean(busy)} onClick={() => act('pause', () => api.integrations.update(item.id, { paused: !item.paused }))} className="text-brand-700 hover:underline disabled:opacity-50">
            {item.paused ? t('integrations.resume') : t('integrations.pause')}
          </button>
          <button disabled={Boolean(busy)} onClick={remove} className="text-red-600 hover:underline disabled:opacity-50">{t('integrations.remove')}</button>
        </div>
      </div>

      {item.summary?.messages?.length > 0 && (
        <ul className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 space-y-0.5">
          {item.summary.messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      {accounts.length > 0 && (
        <fieldset className="mt-3 text-sm">
          <legend className={label}>{t('simplefin.accounts_title')}</legend>
          {(item.selected_accounts ?? []).length === 0 && <p role="status" className="mb-1 text-xs text-amber-800">{t('simplefin.choose_accounts')}</p>}
          <ul className="space-y-1">
            {accounts.map((a) => (
              <li key={a.id}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
                  <span className="min-w-0 truncate">{[a.org, a.name].filter(Boolean).join(' · ')}</span>
                  {a.currency && <span className="text-xs text-gray-500">{a.currency}</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button className={btnSecondary} disabled={!changed || Boolean(busy)} onClick={save}>
              {busy === 'save' ? t('integrations.syncing') : t('simplefin.save_accounts')}
            </button>
            <Link to="/expenses/import" className="text-xs text-brand-700 hover:underline">{t('simplefin.open_inbox')}</Link>
          </div>
        </fieldset>
      )}
    </li>
  );
}

// Live bank transactions through a SimpleFIN Bridge: read-only, the household's own account at the
// bridge, and everything lands in the same review inbox as an imported statement.
export default function BankConnections({ property }) {
  const { t } = useTranslation();
  const { data, error, reload } = useAsync(() => api.integrations.list(property.id), [property.id]);
  const [form, setForm] = useState({ name: '', setup_token: '', interval_minutes: 720 });
  const [state, run] = useAction();
  const [added, setAdded] = useState(null);

  const banks = (data?.integrations || []).filter((i) => i.type === 'simplefin');

  const add = async (e) => {
    e.preventDefault();
    setAdded(null);
    const ok = await run(async () => {
      const created = await api.integrations.create({
        property_id: property.id,
        type: 'simplefin',
        name: form.name,
        setup_token: form.setup_token,
        interval_minutes: Number(form.interval_minutes),
      });
      setAdded(created);
      setForm({ name: '', setup_token: '', interval_minutes: 720 });
      reload();
    });
    if (!ok) setAdded(null);
  };

  return (
    <section className={card}>
      <h2 className="font-semibold">{t('simplefin.title')}</h2>
      <p className="text-xs text-gray-500 mb-3">{t('simplefin.summary')}</p>
      <ErrorBox error={error} onRetry={reload} />
      {data && data.enabled === false && <p role="alert" className="text-sm text-amber-800 mb-3">{t('integrations.disabled')}</p>}

      <ul className="divide-y text-sm mb-4">
        {banks.map((b) => (
          <Connection key={b.id} item={b} onChange={reload} />
        ))}
        {data && banks.length === 0 && <li className="py-2 text-gray-400">{t('simplefin.none')}</li>}
      </ul>

      {added && (
        <p role="status" className="mb-3 rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">
          {added.status === 'error' ? t('simplefin.added_with_problem', { name: added.name }) : t('simplefin.added', { name: added.name, n: added.summary?.accounts?.length ?? 0 })}
        </p>
      )}

      <form onSubmit={add} className="grid gap-2 sm:grid-cols-[1fr_2fr] text-sm">
        <div>
          <label className={label} htmlFor="sfin-name">{t('integrations.name')}</label>
          <input id="sfin-name" className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('simplefin.name_placeholder')} maxLength={120} />
        </div>
        <div>
          <label className={label} htmlFor="sfin-token">{t('simplefin.token')}</label>
          <input id="sfin-token" className={input} value={form.setup_token} onChange={(e) => setForm({ ...form, setup_token: e.target.value })} required autoComplete="off" spellCheck={false} />
        </div>
        <div>
          <label className={label} htmlFor="sfin-interval">{t('integrations.refresh')}</label>
          <select id="sfin-interval" className={input} value={form.interval_minutes} onChange={(e) => setForm({ ...form, interval_minutes: e.target.value })}>
            {INTERVALS.map((m) => (
              <option key={m} value={m}>{hours(t, m)}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button className={btnPrimary} disabled={state.busy || !form.setup_token.trim()}>{state.busy ? t('integrations.checking') : t('simplefin.connect')}</button>
        </div>
      </form>
      {state.error && <p role="alert" className="text-sm text-red-600 mt-2">{state.error}</p>}

      <details className="mt-4 text-xs text-gray-500">
        <summary className="cursor-pointer text-brand-700">{t('simplefin.help_title')}</summary>
        <ol className="list-decimal pl-5 mt-2 space-y-1">
          <li>{t('simplefin.help_1')}</li>
          <li>{t('simplefin.help_2')}</li>
          <li>{t('simplefin.help_3')}</li>
          <li>{t('simplefin.help_4')}</li>
        </ol>
        <p className="mt-2">{t('simplefin.help_safety')}</p>
      </details>
    </section>
  );
}
