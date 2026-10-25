import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { formatDate } from '../../utils/dates.js';
import { formatMoney } from '../../utils/format.js';
import ErrorBox from '../ErrorBox.jsx';
import Modal from '../Modal.jsx';
import { btnPrimary, btnSecondary, card, input, label } from '../ui.js';

export const CATEGORIES = ['maintenance', 'insurance', 'tax', 'utility', 'improvement', 'other'];

// "HOME DEPOT #1234 MONTREAL" -> "HOME DEPOT": a store number or trailing digits would make a rule too narrow.
const patternFrom = (description) =>
  description.split(' · ')[0].replace(/[#*]?\s*\d[\d\s-]*$/, '').replace(/\s+/g, ' ').trim().slice(0, 40);

function RuleDialog({ propertyId, row, onClose, onSaved }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ pattern: patternFrom(row.description), action: 'categorize', category: row.suggested_category || 'maintenance', is_home_office: false, apply_existing: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.bank.rules.create(propertyId, form);
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={t('bank.rule_dialog_title')} onClose={onClose}>
      <form onSubmit={save} className="space-y-3 text-sm">
        <div>
          <label className={label} htmlFor="rule-pattern">{t('bank.rule_pattern')}</label>
          <input id="rule-pattern" className={input} value={form.pattern} onChange={(e) => set({ pattern: e.target.value })} minLength={2} maxLength={80} required />
        </div>
        <fieldset className="space-y-1">
          <legend className={label}>{t('bank.rule_do')}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="rule-action" checked={form.action === 'categorize'} onChange={() => set({ action: 'categorize' })} />
            {t('bank.rule_suggest')}
            <select aria-label={t('bank.choose_category')} className="border rounded px-2 py-1 bg-surface" disabled={form.action !== 'categorize'} value={form.category} onChange={(e) => set({ category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`expense_category.${c}`)}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="rule-action" checked={form.action === 'ignore'} onChange={() => set({ action: 'ignore' })} />
            {t('bank.rule_skip')}
          </label>
        </fieldset>
        {form.action === 'categorize' && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.is_home_office} onChange={(e) => set({ is_home_office: e.target.checked })} />
            {t('bank.home_office')}
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.apply_existing} onChange={(e) => set({ apply_existing: e.target.checked })} />
          {t('bank.rule_apply_existing')}
        </label>
        {error && <p role="alert" className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnSecondary} onClick={onClose}>{t('common.cancel')}</button>
          <button className={btnPrimary} disabled={busy}>{t('bank.rule_save')}</button>
        </div>
      </form>
    </Modal>
  );
}

// Step 2: decide what each imported transaction is. Nothing reaches Expenses until it is accepted here.
export default function Inbox({ propertyId, refreshKey, onChanged }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [status, setStatus] = useState('new');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [moneyOutOnly, setMoneyOutOnly] = useState(true);
  const [limit, setLimit] = useState(200);
  const [choices, setChoices] = useState({}); // id -> { category, is_home_office }
  const [selected, setSelected] = useState(() => new Set());
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ruleFor, setRuleFor] = useState(null);

  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const { data, error: loadError, reload } = useAsync(() => api.bank.transactions(propertyId, { status, q, limit }), [propertyId, status, q, limit, refreshKey]);
  const rows = useMemo(() => (data?.items ?? []).filter((r) => !(moneyOutOnly && status === 'new' && r.amount > 0)), [data, moneyOutOnly, status]);
  const counts = data?.counts ?? { new: 0, imported: 0, ignored: 0 };

  const categoryOf = (r) => choices[r.id]?.category ?? r.suggested_category ?? '';
  const homeOfficeOf = (r) => choices[r.id]?.is_home_office ?? Boolean(r.suggested_home_office);
  const setChoice = (r, patch) => setChoices((c) => ({ ...c, [r.id]: { category: categoryOf(r), is_home_office: homeOfficeOf(r), ...c[r.id], ...patch } }));

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const chosenRows = rows.filter((r) => selected.has(r.id));

  const act = async (fn, okMessage) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await fn();
      setSelected(new Set());
      if (okMessage) setMessage(okMessage(r));
      reload();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    const missing = chosenRows.filter((r) => !categoryOf(r));
    if (missing.length) {
      setError(t('bank.need_category'));
      return;
    }
    act(() => api.bank.accept(propertyId, chosenRows.map((r) => ({ id: r.id, category: categoryOf(r), is_home_office: homeOfficeOf(r) }))), (r) => t('bank.added_ok', { n: r.created }));
  };
  const setBulkCategory = (category) => {
    if (!category) return;
    setChoices((c) => ({ ...c, ...Object.fromEntries(chosenRows.map((r) => [r.id, { category, is_home_office: homeOfficeOf(r) }])) }));
  };

  const tab = (id) => (
    <button
      key={id}
      role="tab"
      aria-selected={status === id}
      onClick={() => { setStatus(id); setSelected(new Set()); setLimit(200); setMessage(''); setError(''); }}
      className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${status === id ? 'border-brand-600 text-brand-700 font-medium' : 'border-transparent text-gray-600 hover:text-gray-900'}`}
    >
      {t(`bank.tab_${id}`)} <span className="text-gray-400">({counts[id]})</span>
    </button>
  );

  return (
    <section className={card}>
      <h2 className="font-semibold mb-2">{t('bank.inbox')}</h2>
      <div role="tablist" aria-label={t('bank.inbox')} className="flex gap-1 overflow-x-auto border-b mb-3">
        {['new', 'imported', 'ignored'].map(tab)}
      </div>
      <ErrorBox error={loadError} onRetry={reload} />

      <div className="flex flex-wrap items-center gap-3 text-sm mb-2">
        <input aria-label={t('bank.search')} placeholder={t('bank.search')} className="border rounded px-3 py-1.5 bg-surface w-full sm:w-64" value={search} onChange={(e) => setSearch(e.target.value)} />
        {status === 'new' && (
          <label className="flex items-center gap-1 text-gray-600">
            <input type="checkbox" checked={moneyOutOnly} onChange={(e) => setMoneyOutOnly(e.target.checked)} />
            {t('bank.money_out_only')}
          </label>
        )}
        {status === 'new' && rows.length > 0 && (
          <label className="flex items-center gap-1 text-gray-600 ml-auto">
            <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
            {t('bank.select_all')}
          </label>
        )}
      </div>

      {status === 'new' && selected.size > 0 && (
        <div className="sticky top-14 z-[5] mb-2 flex flex-wrap items-center gap-2 rounded border bg-surface p-2 text-sm shadow">
          <span className="font-medium">{t('bank.selected', { n: selected.size })}</span>
          <select aria-label={t('bank.bulk_category')} className="border rounded px-2 py-1 bg-surface" value="" onChange={(e) => setBulkCategory(e.target.value)}>
            <option value="">{t('bank.bulk_category')}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{t(`expense_category.${c}`)}</option>
            ))}
          </select>
          <button className={btnPrimary} disabled={busy} onClick={accept}>{t('bank.add_selected')}</button>
          <button className={btnSecondary} disabled={busy} onClick={() => act(() => api.bank.ignore(propertyId, chosenRows.map((r) => r.id)))}>{t('bank.ignore_selected')}</button>
        </div>
      )}

      {message && <p role="status" className="text-sm text-emerald-700 mb-2">{message}</p>}
      {error && <p role="alert" className="text-sm text-red-600 mb-2">{error}</p>}

      <ul className="divide-y text-sm">
        {rows.map((r) => (
          <li key={r.id} className="py-2.5">
            <div className="flex items-start gap-3">
              {status === 'new' && <input type="checkbox" className="mt-1" aria-label={r.description} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />}
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate" title={r.description}>{r.description}</p>
                <p className="text-xs text-gray-500">
                  {formatDate(r.posted_date, locale)}
                  {r.account ? ` · ${r.account}` : ''}
                  {r.amount > 0 && status === 'new' ? ` · ${t('bank.money_in')}` : ''}
                </p>
              </div>
              <span className={`shrink-0 tabular-nums font-medium ${r.amount > 0 ? 'text-emerald-700' : ''}`}>{formatMoney(r.amount, r.currency, locale)}</span>
            </div>
            {status === 'new' && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 pl-7 text-xs">
                <select
                  aria-label={`${t('bank.choose_category')}: ${r.description}`}
                  className={`border rounded px-2 py-1 bg-surface ${selected.has(r.id) && !categoryOf(r) ? 'border-red-500' : ''}`}
                  value={categoryOf(r)}
                  onChange={(e) => setChoice(r, { category: e.target.value })}
                >
                  <option value="">{t('bank.choose_category')}</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{t(`expense_category.${c}`)}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-gray-600">
                  <input type="checkbox" checked={homeOfficeOf(r)} onChange={(e) => setChoice(r, { is_home_office: e.target.checked })} />
                  {t('bank.home_office')}
                </label>
                <button className="text-brand-700 hover:underline" disabled={busy} onClick={() => act(() => api.bank.ignore(propertyId, [r.id]))}>{t('bank.skip')}</button>
                <button className="text-brand-700 hover:underline" onClick={() => setRuleFor(r)}>{t('bank.rule_make')}</button>
              </div>
            )}
            {status === 'ignored' && (
              <div className="pl-7 mt-1 text-xs">
                <button className="text-brand-700 hover:underline" disabled={busy} onClick={() => act(() => api.bank.restore(propertyId, [r.id]))}>{t('bank.restore')}</button>
              </div>
            )}
            {status === 'imported' && !r.expense_id && (
              <div className="pl-7 mt-1 text-xs">
                <button className="text-brand-700 hover:underline" disabled={busy} onClick={() => act(() => api.bank.restore(propertyId, [r.id]))}>{t('bank.restore')}</button>
              </div>
            )}
          </li>
        ))}
        {data && rows.length === 0 && <li className="py-3 text-gray-400">{status === 'new' ? t('bank.empty_new') : t('bank.empty_other')}</li>}
      </ul>

      {data && data.items.length < data.total && (
        <button className={`${btnSecondary} mt-3`} onClick={() => setLimit((n) => n + 200)}>{t('bank.more')}</button>
      )}

      {ruleFor && (
        <RuleDialog
          propertyId={propertyId}
          row={ruleFor}
          onClose={() => setRuleFor(null)}
          onSaved={() => { setRuleFor(null); setMessage(t('bank.rule_saved')); reload(); onChanged?.(); }}
        />
      )}
    </section>
  );
}
