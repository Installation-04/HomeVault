import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Inbox from '../components/bank/Inbox.jsx';
import Rules from '../components/bank/Rules.jsx';
import StatementImport from '../components/bank/StatementImport.jsx';
import { useProperties } from '../property/PropertyContext.jsx';

// Bank statements -> a review inbox -> Expenses. Owners only: the raw transaction list is more
// sensitive than the expense totals everyone with access to the property can see.
export default function BankImport() {
  const { t } = useTranslation();
  const { currentId, canEdit } = useProperties();
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <Link to="/expenses" className="text-sm text-brand-700 hover:underline">{t('bank.back')}</Link>
        <h1 className="font-semibold text-lg">{t('bank.title')}</h1>
      </div>
      {canEdit ? (
        <>
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
