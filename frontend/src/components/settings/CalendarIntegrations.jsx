import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { timeAgo } from '../../utils/dates.js';
import { useConfirm } from '../ConfirmDialog.jsx';
import ErrorBox from '../ErrorBox.jsx';
import { btnPrimary, card, input, label } from '../ui.js';
import { useAction } from './shared.jsx';

const INTERVALS = [15, 60, 180, 720, 1440];

const STATUS_STYLE = {
  ok: 'bg-emerald-100 text-emerald-800',
  error: 'bg-red-100 text-red-700',
  paused: 'bg-gray-100 text-gray-600',
};

function intervalLabel(t, minutes) {
  return minutes < 60 ? t('integrations.minutes_short', { n: minutes }) : t('integrations.hours_short', { n: minutes / 60 });
}

// Calendars from elsewhere (Google, Apple, Outlook, a school or club) shown, read-only, next to
// HomeVault's own reminders. The address is a secret: it is checked now, then stored encrypted.
export default function CalendarIntegrations({ property }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { data, error, reload } = useAsync(() => api.integrations.list(property.id), [property.id]);
  const [form, setForm] = useState({ name: '', url: '', interval_minutes: 60 });
  const [state, run] = useAction();
  const [added, setAdded] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [rowError, setRowError] = useState({});

  const calendars = (data?.integrations || []).filter((i) => i.type === 'calendar_ics');

  const add = async (e) => {
    e.preventDefault();
    setAdded(null);
    const ok = await run(async () => {
      const created = await api.integrations.create({
        property_id: property.id,
        type: 'calendar_ics',
        name: form.name,
        url: form.url,
        interval_minutes: Number(form.interval_minutes),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setAdded(created);
      setForm({ name: '', url: '', interval_minutes: 60 });
      reload();
    });
    if (!ok) setAdded(null);
  };

  const act = async (item, fn) => {
    setBusyId(item.id);
    setRowError((r) => ({ ...r, [item.id]: '' }));
    try {
      await fn();
    } catch (err) {
      setRowError((r) => ({ ...r, [item.id]: err.message }));
    } finally {
      setBusyId(null);
      reload();
    }
  };

  const remove = async (item) => {
    if (!(await confirm({ message: t('integrations.remove_confirm', { name: item.name }), danger: true, confirmLabel: t('integrations.remove') }))) return;
    act(item, () => api.integrations.remove(item.id));
  };

  return (
    <section className={card}>
      <h2 className="font-semibold">{t('integrations.calendars_title')}</h2>
      <p className="text-xs text-gray-500 mb-3">{t('integrations.calendars_summary')}</p>
      <ErrorBox error={error} onRetry={reload} />
      {data && data.enabled === false && <p role="alert" className="text-sm text-amber-800 mb-3">{t('integrations.disabled')}</p>}

      <ul className="divide-y text-sm mb-4">
        {calendars.map((c) => {
          const status = c.paused ? 'paused' : c.status === 'error' ? 'error' : 'ok';
          return (
            <li key={c.id} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {c.name} <span className={`ml-1 text-[11px] px-1.5 py-0.5 rounded font-normal ${STATUS_STYLE[status]}`}>{t(`integrations.status_${status}`)}</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {c.last_sync_at ? t('integrations.last_sync', { when: timeAgo(c.last_sync_at, i18n.language) }) : t('integrations.never')}
                    {c.summary?.events !== undefined && <> · {t('integrations.events', { n: c.summary.events })}</>}
                    {' · '}
                    {t('integrations.every', { when: intervalLabel(t, c.interval_minutes) })}
                    {c.source && <> · {c.source}</>}
                  </p>
                  {c.last_error && <p role="alert" className="text-xs text-red-600 mt-1">{c.last_error}</p>}
                  {rowError[c.id] && <p role="alert" className="text-xs text-red-600 mt-1">{rowError[c.id]}</p>}
                </div>
                <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 shrink-0 text-xs">
                  <button disabled={busyId === c.id || c.paused} onClick={() => act(c, () => api.integrations.sync(c.id))} className="text-brand-700 hover:underline disabled:opacity-50 disabled:no-underline">
                    {busyId === c.id ? t('integrations.syncing') : t('integrations.sync_now')}
                  </button>
                  <button disabled={busyId === c.id} onClick={() => act(c, () => api.integrations.update(c.id, { paused: !c.paused }))} className="text-brand-700 hover:underline disabled:opacity-50">
                    {c.paused ? t('integrations.resume') : t('integrations.pause')}
                  </button>
                  <button disabled={busyId === c.id} onClick={() => remove(c)} className="text-red-600 hover:underline disabled:opacity-50">{t('integrations.remove')}</button>
                </div>
              </div>
            </li>
          );
        })}
        {data && calendars.length === 0 && <li className="py-2 text-gray-400">{t('integrations.none')}</li>}
      </ul>

      {added && (
        <p role="status" className="mb-3 rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">
          {t('integrations.added', { name: added.name, n: added.summary?.events ?? 0 })}
        </p>
      )}

      <form onSubmit={add} className="grid gap-2 sm:grid-cols-[1fr_2fr] text-sm">
        <div>
          <label className={label} htmlFor="cal-name">{t('integrations.name')}</label>
          <input id="cal-name" className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('integrations.name_placeholder')} maxLength={120} />
        </div>
        <div>
          <label className={label} htmlFor="cal-url">{t('integrations.address')}</label>
          <input id="cal-url" className={input} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…/basic.ics" required autoComplete="off" spellCheck={false} />
        </div>
        <div>
          <label className={label} htmlFor="cal-interval">{t('integrations.refresh')}</label>
          <select id="cal-interval" className={input} value={form.interval_minutes} onChange={(e) => setForm({ ...form, interval_minutes: e.target.value })}>
            {INTERVALS.map((m) => (
              <option key={m} value={m}>{intervalLabel(t, m)}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button className={btnPrimary} disabled={state.busy || !form.url.trim()}>{state.busy ? t('integrations.checking') : t('integrations.add_calendar')}</button>
        </div>
      </form>
      {state.error && <p role="alert" className="text-sm text-red-600 mt-2">{state.error}</p>}

      <details className="mt-4 text-xs text-gray-500">
        <summary className="cursor-pointer text-brand-700">{t('integrations.help_title')}</summary>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li>{t('integrations.help_google')}</li>
          <li>{t('integrations.help_apple')}</li>
          <li>{t('integrations.help_outlook')}</li>
        </ul>
        <p className="mt-2">{t('integrations.help_secret')}</p>
      </details>
    </section>
  );
}
