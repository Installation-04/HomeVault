import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import ErrorBox from './ErrorBox.jsx';

// Wraps pages that need a selected property: handles the loading, error and
// "no properties yet" states once so the pages themselves can assume a valid
// currentId.
export default function PropertyGate({ children }) {
  const { t } = useTranslation();
  const { loading, error, refresh, currentId } = useProperties();
  if (loading) return <p>{t('common.loading')}</p>;
  if (error) return <ErrorBox error={error} onRetry={refresh} />;
  if (!currentId) return <p className="text-gray-500">{t('dashboard.no_properties')}</p>;
  return children;
}
