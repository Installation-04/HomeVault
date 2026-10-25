import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { formatDate } from '../../utils/dates.js';
import ErrorBox from '../ErrorBox.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { btnPrimary, btnSecondary, card } from '../ui.js';
import ReauthDialog from './ReauthDialog.jsx';
import { Badge, CopyButton } from './shared.jsx';

const POLL_MS = 3000;
const FINISHED = new Set(['success', 'failed', 'rolled_back']);

// Software updates: shows what is installed and what is newest, and with the updater
// container running installs the newest release after the admin confirms with their password.
export default function UpdateSection() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [dialog, setDialog] = useState(false);
  // The update this page asked for, from "Update" being confirmed until its result is in.
  const [pending, setPending] = useState(null); // { id, to, from }
  const [outcome, setOutcome] = useState(null); // the updater's final report for that update
  const [offline, setOffline] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async ({ refresh = false } = {}) => {
    try {
      const next = await api.admin.update({ refresh });
      setInfo(next);
      setError(null);
      setOffline(false);
      return next;
    } catch (err) {
      // While the app restarts for an update the API is briefly unreachable: that is expected.
      if (err.code === 'network' || err.status >= 500) setOffline(true);
      else setError(err);
      return null;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while an update is being installed; stop once its result is in (and, after a
  // successful update, reload the page: the new version also ships new web files).
  const waiting = (Boolean(pending) && !outcome) || Boolean(info?.in_progress && !outcome);
  useEffect(() => {
    if (!waiting) return undefined;
    timer.current = setInterval(async () => {
      const next = await load();
      const status = next?.status;
      if (pending && status && status.request_id === pending.id && FINISHED.has(status.state)) {
        setOutcome(status);
        if (status.state === 'success') setTimeout(() => window.location.reload(), 3000);
      }
    }, POLL_MS);
    return () => clearInterval(timer.current);
  }, [waiting, pending, load]);

  const check = async () => {
    setChecking(true);
    await load({ refresh: true });
    setChecking(false);
  };

  const apply = async (credentials) => {
    const res = await api.admin.applyUpdate(credentials);
    setDialog(false);
    setOutcome(null);
    setPending({ id: res.id, from: res.from, to: res.to });
    await load();
  };

  if (!info) {
    return (
      <section className={card}>
        <h2 className="font-semibold">{t('update.title')}</h2>
        {error ? <ErrorBox error={error} onRetry={load} /> : <p className="text-sm text-gray-500 mt-2">{offline ? t('update.reconnecting') : t('common.loading')}</p>}
      </section>
    );
  }

  const { current, latest, status } = info;
  const mine = status && pending && status.request_id === pending.id ? status : null;
  // A failed or rolled-back result from an earlier visit (or another admin) is shown too, until the next update.
  const lastResult = !pending && status && FINISHED.has(status.state) && status.state !== 'success' ? status : null;
  const installing = waiting;
  const justUpdated = outcome?.state === 'success';
  const failedOutcome = outcome && outcome.state !== 'success' ? outcome : null;
  const command = './deploy.sh update';

  return (
    <section className={card}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            {t('update.title')} {info.update_available && !installing && <Badge tone="amber">{t('update.available_badge')}</Badge>}
          </h2>
          <p className="text-xs text-gray-500 mt-1">{t('update.summary')}</p>
        </div>
        {info.enabled && (
          <button type="button" className={btnSecondary} onClick={check} disabled={checking || installing}>
            {checking ? t('update.checking') : t('update.check_now')}
          </button>
        )}
      </div>

      <dl className="mt-3 text-sm grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-gray-500">{t('update.installed')}</dt>
        <dd className="font-medium">{current === 'dev' ? t('update.dev_build') : `v${current}`}</dd>
        {info.enabled && (
          <>
            <dt className="text-gray-500">{t('update.latest')}</dt>
            <dd className="font-medium">
              {latest ? `v${latest.version}` : '—'}
              {latest?.published_at && <span className="text-gray-400 font-normal"> · {formatDate(latest.published_at.slice(0, 10), i18n.language)}</span>}
            </dd>
          </>
        )}
      </dl>

      {!info.enabled && <p className="text-sm text-gray-600 mt-3">{t('update.disabled')}</p>}
      {info.enabled && info.check_error && !latest && <p className="text-sm text-amber-700 mt-3">{t('update.check_failed', { reason: info.check_error })}</p>}
      {info.enabled && current === 'dev' && <p className="text-sm text-gray-600 mt-3">{t('update.dev_hint')}</p>}
      {info.enabled && current !== 'dev' && latest && !info.update_available && !installing && !outcome && (
        <p className="text-sm text-emerald-700 mt-3">✓ {t('update.up_to_date')}</p>
      )}

      {info.update_available && !installing && !justUpdated && (
        <div className="mt-3 space-y-3">
          {latest.notes && (
            <details className="text-sm">
              <summary className="cursor-pointer text-brand-700">{t('update.whats_new')}</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs bg-gray-50 border rounded p-3 max-h-64 overflow-y-auto font-sans">{latest.notes}</pre>
            </details>
          )}
          {latest.url && (
            <a className="text-sm text-brand-700 hover:underline" href={latest.url} target="_blank" rel="noreferrer noopener">
              {t('update.release_page')} ↗
            </a>
          )}
          {info.updater.available ? (
            <div>
              <button type="button" className={btnPrimary} onClick={() => setDialog(true)}>
                {t('update.install', { version: latest.version })}
              </button>
              <p className="text-xs text-gray-500 mt-2">{t('update.install_note')}</p>
            </div>
          ) : (
            <div className="text-sm bg-amber-50 border border-amber-200 rounded p-3 space-y-2">
              <p>{t('update.no_updater')}</p>
              <p className="flex items-center gap-2">
                <code className="bg-surface border rounded px-2 py-1 text-xs">{command}</code>
                <CopyButton text={command} />
              </p>
            </div>
          )}
        </div>
      )}

      {installing && (
        <div role="status" className="mt-3 text-sm bg-brand-50 border border-brand-100 rounded p-3 space-y-1">
          <p className="font-medium">⟳ {t('update.installing', { version: pending?.to || info.status?.to || '' })}</p>
          <p className="text-gray-600">{offline ? t('update.reconnecting') : (mine?.step || info.status?.step || t('update.waiting_for_updater'))}</p>
          <p className="text-xs text-gray-500">{t('update.keep_open')}</p>
        </div>
      )}

      {justUpdated && (
        <p role="status" className="mt-3 text-sm text-emerald-700">✓ {t('update.done', { version: outcome.to || info.current })}</p>
      )}

      {(failedOutcome || lastResult) && <FailedResult status={failedOutcome || lastResult} />}

      <ErrorBox error={error} onRetry={load} />

      {dialog && (
        <ReauthDialog
          title={t('update.confirm_title', { version: latest.version })}
          intro={t('update.confirm_intro', { version: latest.version })}
          confirmLabel={t('update.install', { version: latest.version })}
          requireCode={Boolean(user?.totp_enabled)}
          onSubmit={apply}
          onClose={() => setDialog(false)}
        />
      )}
    </section>
  );
}

function FailedResult({ status }) {
  const { t } = useTranslation();
  const rolledBack = status.state === 'rolled_back';
  return (
    <div role="alert" className={`mt-3 text-sm rounded p-3 border ${rolledBack ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
      <p className="font-medium">{rolledBack ? t('update.rolled_back', { version: status.to }) : t('update.failed', { version: status.to })}</p>
      {status.message && <p className="mt-1">{status.message}</p>}
      {status.log?.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs">{t('update.log')}</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] bg-surface border rounded p-2 max-h-48 overflow-y-auto">{status.log.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}
