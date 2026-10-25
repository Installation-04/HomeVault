import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { card } from '../ui.js';

export default function BackupSection() {
  const { t } = useTranslation();
  return (
    <section className={card}>
      <h2 className="font-semibold">{t('backup.title')}</h2>
      <p className="text-xs text-gray-500 mt-1">{t('backup.summary')}</p>
      <a href={api.admin.backupUrl()} className="inline-block mt-3 px-3 py-2 rounded text-sm border bg-surface hover:bg-gray-50">
        {t('backup.download')}
      </a>
      <p className="text-xs text-amber-800 mt-3">⚠ {t('backup.sensitive')}</p>
    </section>
  );
}
