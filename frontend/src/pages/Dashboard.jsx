import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useProperties } from '../property/PropertyContext.jsx';
import ErrorBox from '../components/ErrorBox.jsx';
import ExpiryBadge from '../components/ExpiryBadge.jsx';
import { formatDate, relativeDays } from '../utils/dates.js';
import { formatMoney } from '../utils/format.js';

function Section({ title, tone = 'default', children }) {
  const colors = tone === 'danger' ? 'text-red-700' : 'text-gray-700';
  return (
    <div className="mt-3">
      <h3 className={`text-sm font-medium mb-1 ${colors}`}>{title}</h3>
      <ul className="text-sm divide-y">{children}</ul>
    </div>
  );
}

function Row({ to, title, date, locale, badge = true, overdue = false }) {
  const content = (
    <>
      <span className="truncate">{title}</span>
      <span className="flex items-center gap-2 shrink-0">
        {badge ? <ExpiryBadge date={date} /> : <span className={`text-xs ${overdue ? 'text-red-600' : 'text-gray-500'}`}>{relativeDays(date, locale)}</span>}
        <span className="text-gray-500 text-xs hidden sm:inline">{formatDate(date, locale)}</span>
      </span>
    </>
  );
  return (
    <li>
      <Link to={to} className="flex items-center justify-between gap-2 py-1.5 hover:bg-gray-50 rounded px-1 -mx-1">
        {content}
      </Link>
    </li>
  );
}

function PropertyCard({ p }) {
  const { t, i18n } = useTranslation();
  const { selectProperty } = useProperties();
  const locale = i18n.language;
  const attention =
    p.overdue_reminders.length + p.upcoming_reminders.length + p.expiring_documents.length + p.expiring_equipment.length;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold text-brand-700 truncate">{p.name}</h2>
          {p.address && <p className="text-xs text-gray-500 truncate">{p.address}</p>}
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-2 mt-3 text-center">
        {[
          ['documents', '/documents', p.counts.documents],
          ['equipment', '/equipment', p.counts.equipment],
          ['calendar', '/calendar', p.counts.open_reminders],
        ].map(([key, to, count]) => (
          <Link
            key={key}
            to={to}
            onClick={() => selectProperty(p.id)}
            className="rounded bg-gray-50 hover:bg-brand-50 py-2"
          >
            <dd className="text-lg font-semibold leading-none">{count}</dd>
            <dt className="text-[11px] text-gray-500 mt-1">{t(`dashboard.count_${key}`)}</dt>
          </Link>
        ))}
      </dl>

      {p.expenses_ytd.length > 0 && (
        <p className="text-xs text-gray-500 mt-2">
          {t('dashboard.expenses_ytd')}:{' '}
          <Link to="/expenses" onClick={() => selectProperty(p.id)} className="text-brand-700 hover:underline">
            {p.expenses_ytd.map((e) => formatMoney(e.total, e.currency, locale)).join(' · ')}
          </Link>
        </p>
      )}

      {attention === 0 && <p className="text-sm text-emerald-700 mt-3">✓ {t('dashboard.all_clear')}</p>}

      {p.overdue_reminders.length > 0 && (
        <Section title={t('dashboard.overdue')} tone="danger">
          {p.overdue_reminders.map((r) => (
            <Row key={r.id} to="/calendar" title={r.title} date={r.due_date} locale={locale} badge={false} overdue />
          ))}
        </Section>
      )}

      {p.upcoming_reminders.length > 0 && (
        <Section title={t('dashboard.upcoming_reminders')}>
          {p.upcoming_reminders.map((r) => (
            <Row key={r.id} to="/calendar" title={r.title} date={r.due_date} locale={locale} badge={false} />
          ))}
        </Section>
      )}

      {p.expiring_documents.length > 0 && (
        <Section title={t('dashboard.expiring_documents')}>
          {p.expiring_documents.map((d) => (
            <Row key={d.id} to={`/documents/${d.id}`} title={d.title} date={d.expiry_date} locale={locale} />
          ))}
        </Section>
      )}

      {p.expiring_equipment.length > 0 && (
        <Section title={t('dashboard.expiring_warranties')}>
          {p.expiring_equipment.map((e) => (
            <Row key={e.id} to={`/equipment/${e.id}`} title={e.name} date={e.warranty_expiry} locale={locale} />
          ))}
        </Section>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const { properties, loading: propertiesLoading } = useProperties();
  const { data: summary, error, reload } = useAsync(() => api.dashboard(), [properties]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!summary || propertiesLoading) return <p>{t('common.loading')}</p>;
  if (summary.length === 0) return <p className="text-gray-500">{t('dashboard.no_properties')}</p>;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {summary.map((p) => (
        <PropertyCard key={p.id} p={p} />
      ))}
    </div>
  );
}
