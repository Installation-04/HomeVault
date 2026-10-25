import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import ErrorBox from '../components/ErrorBox.jsx';
import Modal from '../components/Modal.jsx';
import { btnPrimary, btnSecondary, card, input, label } from '../components/ui.js';
import { formatDate, todayStr } from '../utils/dates.js';
import { formatMoney } from '../utils/format.js';

const CATEGORIES = ['maintenance', 'insurance', 'tax', 'utility', 'improvement', 'other'];
const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP'];

const emptyForm = () => ({
  category: 'maintenance',
  amount: '',
  expense_date: todayStr(),
  currency: 'CAD',
  is_home_office: false,
  description: '',
  receipt_document_id: '',
});

const toForm = (e) => ({
  category: e.category,
  amount: String(e.amount),
  expense_date: e.expense_date,
  currency: e.currency,
  is_home_office: !!e.is_home_office,
  description: e.description || '',
  receipt_document_id: e.receipt_document_id ? String(e.receipt_document_id) : '',
});

function ExpenseForm({ initial, documents, onSave, onCancel }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave({ ...form, amount: Number(form.amount), receipt_document_id: form.receipt_document_id || null });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 text-sm">
      <div>
        <label className={label} htmlFor="x-cat">{t('expenses.category')}</label>
        <select id="x-cat" className={input} value={form.category} onChange={(e) => set({ category: e.target.value })}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(`expense_category.${c}`)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className={label} htmlFor="x-date">{t('expenses.date')}</label>
        <input id="x-date" type="date" className={input} value={form.expense_date} onChange={(e) => set({ expense_date: e.target.value })} required />
      </div>
      <div>
        <label className={label} htmlFor="x-amount">{t('expenses.amount')}</label>
        <input
          id="x-amount"
          type="number"
          step="0.01"
          inputMode="decimal"
          className={input}
          value={form.amount}
          onChange={(e) => set({ amount: e.target.value })}
          required
        />
      </div>
      <div>
        <label className={label} htmlFor="x-cur">{t('expenses.currency')}</label>
        <select id="x-cur" className={input} value={form.currency} onChange={(e) => set({ currency: e.target.value })}>
          {[...new Set([...CURRENCIES, form.currency])].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className={label} htmlFor="x-desc">{t('expenses.description')}</label>
        <input id="x-desc" className={input} value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </div>
      <div>
        <label className={label} htmlFor="x-receipt">{t('expenses.receipt')}</label>
        <select id="x-receipt" className={input} value={form.receipt_document_id} onChange={(e) => set({ receipt_document_id: e.target.value })}>
          <option value="">—</option>
          {(documents || []).map((d) => (
            <option key={d.id} value={d.id}>{d.title}</option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 self-end pb-2">
        <input type="checkbox" checked={form.is_home_office} onChange={(e) => set({ is_home_office: e.target.checked })} />
        {t('expenses.home_office')}
      </label>
      {error && <p role="alert" className="text-red-600 sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2 flex justify-end gap-2">
        <button type="button" className={btnSecondary} onClick={onCancel}>{t('common.cancel')}</button>
        <button className={btnPrimary} disabled={busy}>{t('common.save')}</button>
      </div>
    </form>
  );
}

// Totals per currency (a household can have a US vacation-home bill and a
// Canadian one; summing them as one number would be wrong).
function totalsByCurrency(list) {
  const totals = {};
  for (const e of list) totals[e.currency] = (totals[e.currency] || 0) + e.amount;
  return totals;
}

function Summary({ expenses, locale, t }) {
  const all = totalsByCurrency(expenses);
  const office = totalsByCurrency(expenses.filter((e) => e.is_home_office));
  const money = (totals) =>
    Object.keys(totals).length === 0
      ? '—'
      : Object.entries(totals)
          .map(([cur, amount]) => formatMoney(amount, cur, locale))
          .join(' · ');

  // Category breakdown, largest first (bars are relative within a currency).
  const byCategory = {};
  for (const e of expenses) {
    const key = `${e.category}|${e.currency}`;
    byCategory[key] = (byCategory[key] || 0) + e.amount;
  }
  const rows = Object.entries(byCategory)
    .map(([key, amount]) => {
      const [category, currency] = key.split('|');
      return { category, currency, amount };
    })
    .sort((a, b) => b.amount - a.amount);
  const maxByCurrency = {};
  rows.forEach((r) => {
    maxByCurrency[r.currency] = Math.max(maxByCurrency[r.currency] || 0, Math.abs(r.amount));
  });

  return (
    <div className="grid gap-3 sm:grid-cols-2 mb-4">
      <div className={card}>
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-xs text-gray-500">{t('expenses.total')}</dt>
            <dd className="text-lg font-semibold">{money(all)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">{t('expenses.home_office_total')}</dt>
            <dd className="text-lg font-semibold">{money(office)}</dd>
          </div>
        </dl>
      </div>
      {rows.length > 0 && (
        <div className={card}>
          <h3 className="text-xs text-gray-500 mb-2">{t('expenses.by_category')}</h3>
          <ul className="space-y-1.5 text-sm">
            {rows.map((r) => (
              <li key={`${r.category}-${r.currency}`}>
                <div className="flex justify-between">
                  <span>{t(`expense_category.${r.category}`)}</span>
                  <span className="text-gray-600">{formatMoney(r.amount, r.currency, locale)}</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded">
                  <div
                    className="h-1.5 bg-brand-500 rounded"
                    style={{ width: `${Math.max(2, (Math.abs(r.amount) / (maxByCurrency[r.currency] || 1)) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function Expenses() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { currentId, canEdit } = useProperties();
  const locale = i18n.language;
  const thisYear = String(new Date().getFullYear());
  const [year, setYear] = useState(thisYear);
  const [category, setCategory] = useState('');
  const [homeOfficeOnly, setHomeOfficeOnly] = useState(false);
  const [editor, setEditor] = useState(null); // { editing: expense | null, initial }
  const [actionError, setActionError] = useState(null);

  const { data: years, reload: reloadYears } = useAsync(() => api.expenses.years(currentId), [currentId]);
  const { data: documents } = useAsync(() => api.documents.list(currentId, {}), [currentId]);
  // Bank transactions waiting for review (owners only): a nudge beside the import link. Never blocks the page.
  const { data: waitingData } = useAsync(() => (canEdit ? api.bank.transactions(currentId, { status: 'new', limit: 1 }).catch(() => null) : null), [currentId, canEdit]);
  const waiting = waitingData?.counts?.new ?? 0;
  const { data, error, loading, reload } = useAsync(
    () => api.expenses.list(currentId, { year, category, home_office: homeOfficeOnly ? 'true' : '' }),
    [currentId, year, category, homeOfficeOnly]
  );

  // Years that have data, plus the current year so a first expense can be added.
  const yearOptions = useMemo(() => [...new Set([thisYear, ...(years || [])])].sort().reverse(), [years, thisYear]);
  const expenses = data || [];

  const save = async (values) => {
    const payload = { ...values, property_id: currentId };
    if (editor.editing) await api.expenses.update(editor.editing.id, payload);
    else await api.expenses.create(payload);
    setEditor(null);
    // A date in another year should still show up, so jump to that year.
    if (values.expense_date.slice(0, 4) !== year && year !== '') setYear(values.expense_date.slice(0, 4));
    reload();
    reloadYears();
  };

  const remove = async (e) => {
    const ok = await confirm({
      message: t('expenses.delete_confirm', { date: formatDate(e.expense_date, locale), amount: formatMoney(e.amount, e.currency, locale) }),
      danger: true,
    });
    if (!ok) return;
    setActionError(null);
    try {
      await api.expenses.remove(e.id);
      reload();
      reloadYears();
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
        <select aria-label={t('expenses.year')} className="border rounded px-2 py-1.5" value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="">{t('expenses.all_years')}</option>
          {yearOptions.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <select aria-label={t('common.filter_category')} className="border rounded px-2 py-1.5" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t('documents.all_categories')}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(`expense_category.${c}`)}</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-gray-600">
          <input type="checkbox" checked={homeOfficeOnly} onChange={(e) => setHomeOfficeOnly(e.target.checked)} />
          {t('expenses.home_office_only')}
        </label>
        <div className="ml-auto flex items-center gap-3">
          <a href={api.expenses.exportCsvUrl(currentId, year)} className="text-brand-700 hover:underline">
            {t('expenses.export_csv')}
          </a>
          {canEdit && (
            <Link to="/expenses/import" className="text-brand-700 hover:underline">
              {t('expenses.bank_import')}{waiting > 0 && <span className="ml-1 rounded-full bg-brand-100 px-1.5 text-xs">{waiting}</span>}
            </Link>
          )}
          {canEdit && (
            <button className={btnPrimary} onClick={() => setEditor({ editing: null, initial: { ...emptyForm(), currency: expenses[0]?.currency || 'CAD' } })}>
              + {t('expenses.add')}
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error || actionError} onRetry={error ? reload : undefined} />
      {data && <Summary expenses={expenses} locale={locale} t={t} />}

      <div className="bg-surface rounded-lg shadow divide-y">
        {expenses.map((e) => (
          <div key={e.id} className="p-3 flex justify-between items-center gap-2 text-sm">
            <div className="min-w-0">
              <p className="font-medium flex items-center gap-2">
                {t(`expense_category.${e.category}`)}
                {e.is_home_office ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-brand-100 text-brand-700">{t('expenses.home_office_short')}</span> : null}
              </p>
              <p className="text-xs text-gray-500 truncate">
                {formatDate(e.expense_date, locale)}
                {e.description ? ` · ${e.description}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className={`font-medium ${e.amount < 0 ? 'text-emerald-700' : ''}`}>{formatMoney(e.amount, e.currency, locale)}</span>
              {canEdit && (
                <>
                  <button onClick={() => setEditor({ editing: e, initial: toForm(e) })} className="text-brand-700 hover:underline text-xs">
                    {t('common.edit')}
                  </button>
                  <button onClick={() => remove(e)} className="text-red-600 hover:underline text-xs">
                    {t('common.delete')}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {!loading && expenses.length === 0 && <p className="p-4 text-sm text-gray-400">{t('expenses.none')}</p>}
      </div>

      {editor && (
        <Modal title={editor.editing ? t('expenses.edit') : t('expenses.add')} onClose={() => setEditor(null)}>
          <ExpenseForm initial={editor.initial} documents={documents} onSave={save} onCancel={() => setEditor(null)} />
        </Modal>
      )}
    </div>
  );
}
