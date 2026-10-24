import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { formatDateTime } from '../../utils/dates.js';
import { describeUserAgent } from '../../utils/userAgent.js';
import ErrorBox from '../ErrorBox.jsx';
import { btnSecondary, card } from '../ui.js';
import { FAILURE_ACTIONS } from './ActivitySection.jsx';

const FILTERS = ['', 'login_failed', 'login_success', 'password_changed', 'mfa_enabled', 'mfa_disabled', 'user_created', 'user_disabled', 'user_password_reset', 'property_shared', 'property_deleted', 'bundle_exported', 'backup_downloaded', 'update_requested', 'update_finished'];

function Detail({ value }) {
  if (!value) return null;
  try {
    const obj = JSON.parse(value);
    return <span className="text-gray-400"> ({Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ')})</span>;
  } catch {
    return null;
  }
}

// Everything that happened on this instance: who, what, when, from where.
export default function AuditSection() {
  const { t, i18n } = useTranslation();
  const [action, setAction] = useState('');
  const [events, setEvents] = useState([]);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async (before) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.admin.audit({ action, before, limit: 25 });
      setEvents((prev) => (before ? [...prev, ...res.events] : res.events));
      setNext(res.next_before);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  return (
    <section className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{t('audit_log.title')}</h2>
          <p className="text-xs text-gray-500">{t('audit_log.summary')}</p>
        </div>
        <select aria-label={t('audit_log.filter')} className="border rounded px-2 py-1 text-sm" value={action} onChange={(e) => setAction(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f} value={f}>{f ? t(`audit.${f}`) : t('audit_log.all_events')}</option>
          ))}
        </select>
      </div>
      <ErrorBox error={error} onRetry={() => load()} />
      <div className="overflow-x-auto mt-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b">
              <th className="py-1 pr-3 font-normal">{t('audit_log.when')}</th>
              <th className="py-1 pr-3 font-normal">{t('audit_log.who')}</th>
              <th className="py-1 pr-3 font-normal">{t('audit_log.what')}</th>
              <th className="py-1 font-normal">{t('audit_log.from')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {events.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="py-1.5 pr-3 whitespace-nowrap text-xs text-gray-600">{formatDateTime(e.at, i18n.language)}</td>
                <td className="py-1.5 pr-3 break-all">{e.actor || '—'}</td>
                <td className={`py-1.5 pr-3 ${FAILURE_ACTIONS.has(e.action) ? 'text-red-700' : ''}`}>
                  {t(`audit.${e.action}`, { defaultValue: e.action })}
                  {e.target && <span className="text-gray-500"> · {e.target}</span>}
                  <Detail value={e.detail} />
                </td>
                <td className="py-1.5 text-xs text-gray-500">
                  {e.ip || '—'}
                  {describeUserAgent(e.user_agent) && <div>{describeUserAgent(e.user_agent)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && events.length === 0 && <p className="py-3 text-sm text-gray-400">{t('activity.none')}</p>}
      </div>
      {next && (
        <div className="mt-3">
          <button className={btnSecondary} disabled={loading} onClick={() => load(next)}>{t('common.load_more')}</button>
        </div>
      )}
    </section>
  );
}
