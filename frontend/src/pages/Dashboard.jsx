import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';

export default function Dashboard() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api.dashboard().then(setSummary);
  }, []);

  if (!summary) return <p>{t('common.loading')}</p>;
  if (summary.length === 0) return <p className="text-gray-500">{t('dashboard.no_properties')}</p>;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {summary.map((p) => (
        <div key={p.id} className="bg-white rounded-lg shadow p-4">
          <h2 className="font-semibold text-brand-700">{p.name}</h2>
          <p className="text-xs text-gray-500 mb-2">{p.address}</p>

          <h3 className="text-sm font-medium mt-2">{t('dashboard.upcoming_reminders')}</h3>
          {p.upcoming_reminders.length === 0 ? (
            <p className="text-xs text-gray-400">—</p>
          ) : (
            <ul className="text-sm space-y-1">
              {p.upcoming_reminders.map((r) => (
                <li key={r.id} className="flex justify-between">
                  <span>{r.title}</span>
                  <span className="text-gray-500">{r.due_date}</span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="text-sm font-medium mt-3">{t('dashboard.expiring_documents')}</h3>
          {p.expiring_documents.length === 0 ? (
            <p className="text-xs text-gray-400">—</p>
          ) : (
            <ul className="text-sm space-y-1">
              {p.expiring_documents.map((d) => (
                <li key={d.id} className="flex justify-between">
                  <span>{d.title}</span>
                  <span className="text-gray-500">{d.expiry_date}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
