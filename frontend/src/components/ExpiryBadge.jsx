import { useTranslation } from 'react-i18next';
import { expiryStatus, relativeDays } from '../utils/dates.js';

const styles = {
  expired: 'bg-red-100 text-red-700',
  soon: 'bg-amber-100 text-amber-800',
  ok: 'bg-emerald-50 text-emerald-700',
};

// Small pill showing whether a date (document expiry, warranty end) is past,
// close, or comfortably away. Renders nothing when there is no date.
export default function ExpiryBadge({ date, soonDays = 30, showOk = false }) {
  const { t, i18n } = useTranslation();
  const status = expiryStatus(date, soonDays);
  if (!status || (status === 'ok' && !showOk)) return null;
  return (
    <span className={`inline-block text-[11px] leading-none px-1.5 py-1 rounded-full whitespace-nowrap ${styles[status]}`}>
      {t(`status.${status}`)} · {relativeDays(date, i18n.language)}
    </span>
  );
}
