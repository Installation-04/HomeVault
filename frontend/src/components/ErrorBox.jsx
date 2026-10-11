import { useTranslation } from 'react-i18next';

// Friendly inline error with an optional retry.
export default function ErrorBox({ error, onRetry }) {
  const { t } = useTranslation();
  if (!error) return null;
  const message = error.code === 'network' ? t('error.network') : error.message || t('error.generic');
  return (
    <div role="alert" className="rounded border border-red-200 bg-red-50 text-red-700 text-sm px-3 py-2 flex items-center justify-between gap-3">
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="underline shrink-0">
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}
