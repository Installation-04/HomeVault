import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useProperties } from '../../property/PropertyContext.jsx';
import { timeAgo } from '../../utils/dates.js';
import { useConfirm } from '../ConfirmDialog.jsx';
import ErrorBox from '../ErrorBox.jsx';
import { btnPrimary, card, input, label } from '../ui.js';
import { CopyButton, Feedback, useAction } from './shared.jsx';

// Subscribe your phone's calendar to HomeVault: reminders, tasks, expiring
// documents and warranty ends appear (with alerts) next to everything else.
export default function CalendarLinksSection() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { properties } = useProperties();
  const { data: feeds, error, reload } = useAsync(() => api.calendar.feeds.list(), []);
  const [form, setForm] = useState({ label: '', property_id: '' });
  const [created, setCreated] = useState(null); // shown once
  const [state, run] = useAction();

  const create = async (e) => {
    e.preventDefault();
    const ok = await run(async () => {
      const res = await api.calendar.feeds.create({ label: form.label, property_id: form.property_id || null });
      setCreated(`${window.location.origin}${res.path}`);
      setForm({ label: '', property_id: '' });
      reload();
    });
    if (!ok) setCreated(null);
  };

  const revoke = async (feed) => {
    if (!(await confirm({ message: t('feeds.revoke_confirm', { label: feed.label }), danger: true, confirmLabel: t('feeds.revoke') }))) return;
    await api.calendar.feeds.remove(feed.id);
    reload();
  };

  const webcal = created?.replace(/^https?:/, 'webcal:');

  return (
    <section className={card}>
      <h2 className="font-semibold">{t('feeds.title')}</h2>
      <p className="text-xs text-gray-500 mb-3">{t('feeds.summary')}</p>
      <ErrorBox error={error} onRetry={reload} />

      {created && (
        <div role="status" className="mb-4 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm space-y-2">
          <p className="font-medium text-emerald-900">{t('feeds.created')}</p>
          <p className="font-mono text-xs break-all select-all bg-surface rounded border p-2">{created}</p>
          <div className="flex flex-wrap gap-2 items-center">
            <CopyButton text={created} />
            <a href={webcal} className="text-xs px-2 py-1 rounded border bg-surface hover:bg-gray-50">{t('feeds.open_in_calendar')}</a>
            <button type="button" className="text-xs text-gray-500 hover:underline ml-auto" onClick={() => setCreated(null)}>{t('common.done')}</button>
          </div>
          <p className="text-xs text-emerald-900">{t('feeds.once_warning')}</p>
          {window.location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(window.location.hostname) && (
            <p className="text-xs text-amber-800">{t('feeds.http_warning')}</p>
          )}
        </div>
      )}

      <ul className="divide-y text-sm mb-4">
        {(feeds || []).map((f) => (
          <li key={f.id} className="py-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium truncate">{f.label}</p>
              <p className="text-xs text-gray-500 truncate">
                {f.property_name || t('feeds.all_properties')} · {f.last_used_at ? t('feeds.last_used', { when: timeAgo(f.last_used_at, i18n.language) }) : t('feeds.never_used')}
              </p>
            </div>
            <button onClick={() => revoke(f)} className="text-red-600 hover:underline text-xs shrink-0">{t('feeds.revoke')}</button>
          </li>
        ))}
        {feeds && feeds.length === 0 && <li className="py-2 text-gray-400">{t('feeds.none')}</li>}
      </ul>

      <form onSubmit={create} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-end text-sm">
        <div>
          <label className={label} htmlFor="feed-label">{t('feeds.label')}</label>
          <input id="feed-label" className={input} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={t('feeds.label_placeholder')} maxLength={60} required />
        </div>
        <div>
          <label className={label} htmlFor="feed-property">{t('feeds.include')}</label>
          <select id="feed-property" className={input} value={form.property_id} onChange={(e) => setForm({ ...form, property_id: e.target.value })}>
            <option value="">{t('feeds.all_properties')}</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <button className={btnPrimary} disabled={state.busy}>{t('feeds.create')}</button>
      </form>
      <div className="mt-2"><Feedback state={{ ...state, saved: false }} /></div>
      <p className="text-xs text-gray-400 mt-2">{t('feeds.privacy')}</p>
    </section>
  );
}
