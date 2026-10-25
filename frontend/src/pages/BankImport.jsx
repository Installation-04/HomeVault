import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Inbox from '../components/bank/Inbox.jsx';
import Rules from '../components/bank/Rules.jsx';
import StatementImport from '../components/bank/StatementImport.jsx';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useProperties } from '../property/PropertyContext.jsx';
import { timeAgo } from '../utils/dates.js';

// Bank statements -> a review inbox -> Expenses. Owners only: the raw transaction list is more
// sensitive than the expense totals everyone with access to the property can see.
export default function BankImport() {
  const { t, i18n } = useTranslation();
  const { currentId, canEdit } = useProperties();
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  // Banks connected in Settings feed this same inbox; show when they last did.
  const { data: connections } = useAsync(() => (canEdit ? api.integrations.list(currentId) : Promise.resolve(null)), [currentId, canEdit, version]);
  const banks = (connections?.integrations ?? []).filter((i) => i.type === 'simplefin');

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <Link to="/expenses" className="text-sm text-brand-700 hover:underline">{t('bank.back')}</Link>
        <h1 className="font-semibold text-lg">{t('bank.title')}</h1>
      </div>
      {canEdit ? (
        <>
          <p className="text-xs text-gray-500">
            {banks.length > 0
              ? banks.map((b) => t('simplefin.connected_line', { name: b.name, when: b.last_sync_at ? timeAgo(b.last_sync_at, i18n.language) : t('integrations.never') })).join(' · ')
              : t('simplefin.not_connected')}{' '}
            <Link to="/settings?tab=integrations" className="text-brand-700 hover:underline">{t('simplefin.manage')}</Link>
          </p>
          <StatementImport propertyId={currentId} onImported={bump} />
          <Inbox propertyId={currentId} refreshKey={version} onChanged={bump} />
          <Rules propertyId={currentId} refreshKey={version} onChanged={bump} />
        </>
      ) : (
        <p className="text-gray-500">{t('bank.only_owners')}</p>
      )}
    </div>
  );
}
