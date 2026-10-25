import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useConfirm } from '../ConfirmDialog.jsx';
import { card } from '../ui.js';

// What HomeVault has been taught: "if the description contains X, suggest Y (or skip it)".
// Rules are created from a transaction in the inbox ("Rule…").
export default function Rules({ propertyId, refreshKey, onChanged }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { data, reload } = useAsync(() => api.bank.rules.list(propertyId), [propertyId, refreshKey]);
  const rules = data ?? [];

  const remove = async (rule) => {
    if (!(await confirm({ message: t('bank.rule_delete_confirm', { pattern: rule.pattern }), danger: true, confirmLabel: t('common.delete') }))) return;
    await api.bank.rules.remove(rule.id);
    reload();
    onChanged?.();
  };

  return (
    <section className={card}>
      <details>
        <summary className="cursor-pointer font-semibold">{t('bank.rules_title')} <span className="text-gray-400 font-normal">({rules.length})</span></summary>
        <p className="text-xs text-gray-500 my-2">{t('bank.rules_hint')}</p>
        <ul className="divide-y text-sm">
          {rules.map((r) => (
            <li key={r.id} className="py-2 flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                <span className="font-medium">“{r.pattern}”</span> → {r.action === 'ignore' ? t('bank.rule_skip_short') : t(`expense_category.${r.category}`)}
              </span>
              <button className="text-red-600 hover:underline text-xs shrink-0" onClick={() => remove(r)}>{t('common.delete')}</button>
            </li>
          ))}
          {data && rules.length === 0 && <li className="py-2 text-gray-400">{t('bank.rule_none')}</li>}
        </ul>
      </details>
    </section>
  );
}
