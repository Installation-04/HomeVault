import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { formatDateTime } from '../../utils/dates.js';
import ErrorBox from '../ErrorBox.jsx';
import { card } from '../ui.js';

export const FAILURE_ACTIONS = new Set(['login_failed', 'login_blocked', 'mfa_failed', 'mfa_blocked', 'mfa_enroll_failed', 'password_change_failed', 'reauth_failed', 'setup_failed']);

// "Was that me?" -- the person's own recent sign-ins and security changes.
export default function ActivitySection() {
  const { t, i18n } = useTranslation();
  const { data: events, error, reload } = useAsync(() => api.activity(15), []);

  return (
    <section className={card}>
      <h2 className="font-semibold">{t('activity.title')}</h2>
      <p className="text-xs text-gray-500 mb-3">{t('activity.summary')}</p>
      <ErrorBox error={error} onRetry={reload} />
      <ul className="divide-y text-sm">
        {(events || []).map((e) => (
          <li key={e.id} className="py-1.5 flex justify-between gap-3">
            <span className={FAILURE_ACTIONS.has(e.action) ? 'text-red-700' : ''}>{t(`audit.${e.action}`, { defaultValue: e.action })}</span>
            <span className="text-xs text-gray-500 text-right shrink-0">
              {formatDateTime(e.at, i18n.language)}
              {e.ip ? ` · ${e.ip}` : ''}
            </span>
          </li>
        ))}
        {events && events.length === 0 && <li className="py-2 text-gray-400">{t('activity.none')}</li>}
      </ul>
    </section>
  );
}
