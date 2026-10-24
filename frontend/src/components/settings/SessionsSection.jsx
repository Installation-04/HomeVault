import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { timeAgo } from '../../utils/dates.js';
import { describeUserAgent } from '../../utils/userAgent.js';
import { useConfirm } from '../ConfirmDialog.jsx';
import ErrorBox from '../ErrorBox.jsx';
import { btnSecondary, card } from '../ui.js';
import { Badge } from './shared.jsx';

// Every browser/device that is currently signed in, with a button to end it.
export default function SessionsSection() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { data: sessions, error, reload } = useAsync(() => api.sessions.list(), []);
  const [actionError, setActionError] = useState('');

  const revoke = async (s) => {
    setActionError('');
    try {
      await api.sessions.revoke(s.id);
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  };

  const revokeOthers = async () => {
    if (!(await confirm({ message: t('sessions.revoke_others_confirm'), danger: true, confirmLabel: t('sessions.revoke_others') }))) return;
    setActionError('');
    try {
      await api.sessions.revokeOthers();
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  };

  const others = (sessions || []).filter((s) => !s.current).length;

  return (
    <section className={card}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t('sessions.title')}</h2>
          <p className="text-xs text-gray-500 mt-1">{t('sessions.summary')}</p>
        </div>
        {others > 0 && (
          <button className={`${btnSecondary} shrink-0`} onClick={revokeOthers}>
            {t('sessions.revoke_others')}
          </button>
        )}
      </div>
      <ErrorBox error={error || (actionError && { message: actionError })} onRetry={error ? reload : undefined} />
      <ul className="divide-y text-sm mt-3">
        {(sessions || []).map((s) => (
          <li key={s.id} className="py-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium flex items-center gap-2 flex-wrap">
                {describeUserAgent(s.user_agent) || t('sessions.unknown_device')}
                {s.current && <Badge tone="green">{t('sessions.this_device')}</Badge>}
                {s.used_mfa && <Badge tone="brand">2FA</Badge>}
              </p>
              <p className="text-xs text-gray-500 truncate">
                {s.ip || '—'} · {t('sessions.last_active', { when: timeAgo(s.last_seen_at, i18n.language) })}
              </p>
            </div>
            {!s.current && (
              <button onClick={() => revoke(s)} className="text-red-600 hover:underline text-xs shrink-0">
                {t('sessions.sign_out')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
