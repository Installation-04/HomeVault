import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { formatDate } from '../../utils/dates.js';
import { formatMoney } from '../../utils/format.js';
import { btnPrimary, btnSecondary, card, input, label } from '../ui.js';

const DATE_ORDERS = ['auto', 'dmy', 'mdy', 'ymd'];
const NONE = '';

const colName = (t, columns, i) => (columns?.[i]?.header ? `${columns[i].header} (${t('bank.col_n', { n: i + 1 })})` : t('bank.col_n', { n: i + 1 }));

// Step 1 of the bank import: pick a file, see what was detected and what would happen, fix anything
// that looks wrong, then add the new transactions to the review inbox. Nothing here touches Expenses.
export default function StatementImport({ propertyId, onImported }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const fileInput = useRef(null);
  const [file, setFile] = useState(null);
  const [options, setOptions] = useState({ date_format: 'auto', invert: false, currency: '', mapping: null });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const formFor = (f, o) => {
    const form = new FormData();
    form.append('file', f);
    form.append('date_format', o.date_format);
    if (o.invert) form.append('invert', '1');
    if (o.currency) form.append('currency', o.currency);
    if (o.mapping) form.append('mapping', JSON.stringify(o.mapping));
    return form;
  };

  const run = async (f, o) => {
    setBusy(true);
    setError('');
    try {
      const p = await api.bank.preview(propertyId, formFor(f, o));
      setPreview(p);
      // Remember what was detected so a later tweak changes one thing, not everything.
      setOptions((cur) => ({ ...cur, currency: cur.currency || p.currency }));
    } catch (err) {
      setPreview(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const choose = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setResult(null);
    const fresh = { date_format: 'auto', invert: false, currency: '', mapping: null };
    setOptions(fresh);
    run(f, fresh);
  };

  const change = (patch) => {
    const next = { ...options, ...patch };
    setOptions(next);
    if (file) run(file, next);
  };

  const mapping = preview?.detected?.mapping;
  const columns = preview?.detected?.columns;
  const columnChoices = Array.from({ length: Math.max(preview?.detected?.width ?? 3, 3) }, (_, i) => i);
  const setMapping = (patch) => change({ mapping: { ...mapping, ...patch } });
  const colSelect = (id, value, onPick, optional = false) => (
    <select id={id} className={input} value={value ?? NONE} onChange={(e) => onPick(e.target.value === NONE ? null : Number(e.target.value))}>
      {optional && <option value={NONE}>—</option>}
      {columnChoices.map((i) => (
        <option key={i} value={i}>{colName(t, columns, i)}</option>
      ))}
    </select>
  );

  const doImport = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.bank.import(propertyId, formFor(file, options));
      setResult(r);
      setPreview(null);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      onImported?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    const r = await api.bank.undo(propertyId, result.batch);
    setResult({ ...result, undone: r.removed });
    onImported?.();
  };

  const pickers = mapping && (
    <div className="grid gap-2 sm:grid-cols-3 mt-2">
                <div>
                  <label className={label} htmlFor="map-date">{t('bank.col_date')}</label>
                  {colSelect('map-date', mapping.date, (v) => setMapping({ date: v }))}
                </div>
                <div>
                  <label className={label} htmlFor="map-desc">{t('bank.col_description')}</label>
                  {colSelect('map-desc', mapping.description?.[0], (v) => setMapping({ description: v === null ? [] : [v] }))}
                </div>
                <div>
                  <label className={label} htmlFor="map-amount">{t('bank.col_amount')}</label>
                  {colSelect('map-amount', mapping.amount?.[0], (v) => setMapping({ amount: v === null ? [] : [v], debit: null, credit: null }), true)}
                </div>
                <div>
                  <label className={label} htmlFor="map-debit">{t('bank.col_debit')}</label>
                  {colSelect('map-debit', mapping.debit, (v) => setMapping({ debit: v, amount: v === null ? mapping.amount : [] }), true)}
                </div>
                <div>
                  <label className={label} htmlFor="map-credit">{t('bank.col_credit')}</label>
                  {colSelect('map-credit', mapping.credit, (v) => setMapping({ credit: v, amount: v === null ? mapping.amount : [] }), true)}
                </div>
              </div>
  );

  const w = preview?.warnings ?? [];
  const assumed = w.find((x) => x.code === 'date_order_assumed');
  const skipped = w.find((x) => x.code === 'rows_skipped');
  const allPositive = w.some((x) => x.code === 'all_positive');

  return (
    <section className={card}>
      <h2 className="font-semibold">{t('bank.import_title')}</h2>
      <p className="text-xs text-gray-500 mb-3">{t('bank.intro')}</p>

      <label className={label} htmlFor="bank-file">{t('bank.choose_file')}</label>
      <input ref={fileInput} id="bank-file" type="file" accept=".csv,.ofx,.qfx,.qif,.txt,text/csv,text/plain" onChange={choose} className="block w-full text-sm file:mr-3 file:rounded file:border file:bg-surface file:px-3 file:py-2 file:text-sm" />

      {busy && <p className="text-sm text-gray-500 mt-3" role="status">{t('bank.reading')}</p>}
      {error && <p role="alert" className="text-sm text-red-600 mt-3">{error}</p>}

      {result && (
        <div role="status" className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          {result.undone !== undefined ? (
            <p>{t('bank.undone', { n: result.undone })}</p>
          ) : (
            <>
              <p>{t('bank.imported', { added: result.added, dup: result.duplicates, rule: result.ignored_by_rule })}</p>
              {result.added > 0 && (
                <button type="button" onClick={undo} className="mt-1 text-xs underline">{t('bank.undo')}</button>
              )}
            </>
          )}
        </div>
      )}

      {preview?.needs_mapping && (
        <div className="mt-4 space-y-3 text-sm">
          <p role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            {preview.code === 'no_date_column' ? t('bank.needs_date') : t('bank.needs_amount')}
          </p>
          <div className="overflow-x-auto">
            <table className="text-xs border">
              <tbody>
                {preview.detected.sample_rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className="border px-2 py-1 whitespace-nowrap">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pickers}
        </div>
      )}

      {preview && !preview.needs_mapping && (
        <div className="mt-4 space-y-3 text-sm">
          <p>
            {t('bank.summary', {
              n: preview.count,
              from: formatDate(preview.date_from, locale),
              to: formatDate(preview.date_to, locale),
              fresh: preview.new_count,
              dup: preview.duplicate_count,
              out: formatMoney(preview.money_out, preview.currency, locale),
              inn: formatMoney(preview.money_in, preview.currency, locale),
            })}
          </p>

          {assumed && <p role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{t('bank.warn_date_order', { order: t(`bank.date_${assumed.order}`) })}</p>}
          {allPositive && <p role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{t('bank.warn_all_positive')}</p>}
          {skipped && <p className="text-xs text-gray-500">{t('bank.warn_skipped', { n: skipped.count })}</p>}

          <div className="grid gap-3 sm:grid-cols-3">
            {preview.format === 'csv' || preview.format === 'qif' ? (
              <div>
                <label className={label} htmlFor="bank-date-order">{t('bank.opt_date_format')}</label>
                <select id="bank-date-order" className={input} value={options.date_format} onChange={(e) => change({ date_format: e.target.value })}>
                  {DATE_ORDERS.map((o) => (
                    <option key={o} value={o}>{o === 'auto' ? t('bank.opt_auto') : t(`bank.date_${o}`)}</option>
                  ))}
                </select>
              </div>
            ) : null}
            <div>
              <label className={label} htmlFor="bank-currency">{t('bank.opt_currency')}</label>
              <input id="bank-currency" className={input} value={options.currency} maxLength={3} onChange={(e) => setOptions({ ...options, currency: e.target.value.toUpperCase() })} onBlur={() => /^[A-Z]{3}$/.test(options.currency) && file && run(file, options)} />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-xs">
              <input type="checkbox" checked={options.invert} onChange={(e) => change({ invert: e.target.checked })} />
              {t('bank.opt_invert')}
            </label>
          </div>

          {preview.format === 'csv' && mapping && (
            <details className="text-xs">
              <summary className="cursor-pointer text-brand-700">{t('bank.opt_columns')}</summary>
              {pickers}
            </details>
          )}

          <div>
            <p className={label}>{t('bank.sample')}</p>
            <ul className="divide-y rounded border text-xs">
              {preview.sample.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1.5">
                  <span className="shrink-0 text-gray-500 w-24">{formatDate(r.posted_date, locale)}</span>
                  <span className="min-w-0 flex-1 basis-28 truncate">{r.description}</span>
                  {r.duplicate && <span className="shrink-0 rounded bg-gray-100 px-1.5 text-gray-600">{t('bank.dup_badge')}</span>}
                  <span className={`shrink-0 tabular-nums ${r.amount > 0 ? 'text-emerald-700' : ''}`}>{formatMoney(r.amount, r.currency, locale)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-3">
            <button className={btnPrimary} disabled={busy || preview.new_count === 0} onClick={doImport}>
              {preview.new_count === 0 ? t('bank.nothing_new_button') : t('bank.import_button', { n: preview.new_count })}
            </button>
            <button type="button" className={btnSecondary} onClick={() => { setPreview(null); setFile(null); if (fileInput.current) fileInput.current.value = ''; }}>{t('common.cancel')}</button>
          </div>
          {preview.new_count === 0 && <p className="text-xs text-gray-500">{t('bank.nothing_new')}</p>}
        </div>
      )}
    </section>
  );
}
