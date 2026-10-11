import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useDebounced } from '../hooks/useDebounced.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import ErrorBox from '../components/ErrorBox.jsx';
import ExpiryBadge from '../components/ExpiryBadge.jsx';
import QrModal from '../components/QrModal.jsx';
import { btnPrimary, btnSecondary, input, label } from '../components/ui.js';
import { expiryStatus, formatDate } from '../utils/dates.js';

export const DOCUMENT_CATEGORIES = ['invoice', 'warranty', 'insurance', 'contract', 'photo', 'maintenance', 'tax', 'other'];
const EMPTY_FORM = { title: '', category: 'other', document_date: '', expiry_date: '', tags: '', equipment_id: '', notes: '' };

function UploadForm({ propertyId, onDone, onCancel }) {
  const { t } = useTranslation();
  const { data: equipment } = useAsync(() => api.equipment.list(propertyId), [propertyId]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // remounts the file inputs to clear them
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const pick = (f) => {
    setFile(f || null);
    // Default the title to the file name so a quick upload needs no typing.
    if (f && !form.title) set({ title: f.name.replace(/\.[^.]+$/, '') });
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file) {
      setError(t('documents.choose_file'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      // property_id must come first: the server reads fields in stream order.
      const fd = new FormData();
      fd.append('property_id', propertyId);
      Object.entries(form).forEach(([k, v]) => v !== '' && fd.append(k, v));
      fd.append('file', file);
      await api.documents.upload(fd);
      setForm(EMPTY_FORM);
      setFile(null);
      setFileKey((k) => k + 1);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-white rounded-lg shadow p-4 mb-4 grid gap-3 sm:grid-cols-2 text-sm">
      <div className="flex flex-wrap gap-2 items-center sm:col-span-2">
        <input
          key={`f${fileKey}`}
          type="file"
          aria-label={t('documents.choose_file')}
          className="border rounded px-3 py-2 w-full sm:w-auto sm:flex-1 min-w-0"
          onChange={(e) => pick(e.target.files[0])}
        />
        {/* `capture` opens the camera directly on iOS/Android instead of the
            file picker -- the fastest path for a receipt or warranty label
            photo. Desktop browsers just ignore the attribute. */}
        <label className="border rounded px-3 py-2 cursor-pointer whitespace-nowrap bg-gray-50 hover:bg-gray-100">
          📷 {t('documents.take_photo')}
          <input key={`c${fileKey}`} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => pick(e.target.files[0])} />
        </label>
      </div>
      {file && <p className="text-xs text-gray-500 -mt-2 sm:col-span-2">{file.name}</p>}

      <div>
        <label className={label} htmlFor="d-title">{t('documents.title')}</label>
        <input id="d-title" className={input} value={form.title} onChange={(e) => set({ title: e.target.value })} />
      </div>
      <div>
        <label className={label} htmlFor="d-cat">{t('documents.category')}</label>
        <select id="d-cat" className={input} value={form.category} onChange={(e) => set({ category: e.target.value })}>
          {DOCUMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(`category.${c}`)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className={label} htmlFor="d-date">{t('documents.date')}</label>
        <input id="d-date" type="date" className={input} value={form.document_date} onChange={(e) => set({ document_date: e.target.value })} />
      </div>
      <div>
        <label className={label} htmlFor="d-exp">{t('documents.expiry')}</label>
        <input id="d-exp" type="date" className={input} value={form.expiry_date} onChange={(e) => set({ expiry_date: e.target.value })} />
      </div>
      <div>
        <label className={label} htmlFor="d-tags">{t('documents.tags')}</label>
        <input id="d-tags" className={input} value={form.tags} onChange={(e) => set({ tags: e.target.value })} />
      </div>
      <div>
        <label className={label} htmlFor="d-eq">{t('documents.linked_equipment')}</label>
        <select id="d-eq" className={input} value={form.equipment_id} onChange={(e) => set({ equipment_id: e.target.value })}>
          <option value="">—</option>
          {(equipment || []).map((eq) => (
            <option key={eq.id} value={eq.id}>{eq.name}</option>
          ))}
        </select>
      </div>

      {error && <p role="alert" className="text-red-600 sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" disabled={busy} className={btnPrimary}>
          {busy ? t('common.uploading') : t('common.save')}
        </button>
        <button type="button" onClick={onCancel} className={btnSecondary}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

export default function Documents() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { currentId, canEdit } = useProperties();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [qrDoc, setQrDoc] = useState(null);
  const [actionError, setActionError] = useState(null);
  const q = useDebounced(query);

  const { data, error, loading, reload } = useAsync(
    () => api.documents.list(currentId, { q, category }),
    [currentId, q, category]
  );

  const documents = (data || []).filter((d) => !expiringOnly || ['expired', 'soon'].includes(expiryStatus(d.expiry_date)));

  const remove = async (doc) => {
    const ok = await confirm({ message: t('documents.delete_confirm', { title: doc.title }), danger: true });
    if (!ok) return;
    setActionError(null);
    try {
      await api.documents.remove(doc.id);
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 items-center justify-between mb-3">
        <input
          type="search"
          className="border rounded px-3 py-2 text-sm flex-1 min-w-[200px]"
          placeholder={t('documents.search')}
          aria-label={t('documents.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex gap-3 items-center">
          <a href={api.exportBundleUrl(currentId)} className="text-sm text-brand-700 hover:underline">
            {t('documents.export_bundle')}
          </a>
          {canEdit && (
            <button onClick={() => setShowForm((v) => !v)} className={btnPrimary}>
              {t('documents.upload')}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-center mb-4 text-sm">
        <select aria-label={t('common.filter_category')} className="border rounded px-2 py-1" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t('documents.all_categories')}</option>
          {DOCUMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(`category.${c}`)}</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-gray-600">
          <input type="checkbox" checked={expiringOnly} onChange={(e) => setExpiringOnly(e.target.checked)} />
          {t('documents.expiring_only')}
        </label>
        {data && <span className="text-xs text-gray-400 ml-auto">{t('documents.count', { count: documents.length })}</span>}
      </div>

      {showForm && canEdit && (
        <UploadForm
          propertyId={currentId}
          onCancel={() => setShowForm(false)}
          onDone={() => {
            setShowForm(false);
            reload();
          }}
        />
      )}

      <ErrorBox error={error || actionError} onRetry={error ? reload : undefined} />

      <div className="bg-white rounded-lg shadow divide-y">
        {documents.map((d) => (
          <div key={d.id} className="p-3 flex items-center justify-between gap-2">
            <Link to={`/documents/${d.id}`} className="min-w-0">
              <p className="font-medium text-sm hover:text-brand-700 truncate">{d.title}</p>
              <p className="text-xs text-gray-500 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{t(`category.${d.category}`)}</span>
                <span>{formatDate(d.document_date, i18n.language)}</span>
                {d.expiry_date && <span>{t('documents.expires_on', { date: formatDate(d.expiry_date, i18n.language) })}</span>}
                <ExpiryBadge date={d.expiry_date} />
                {d.equipment_name && <span className="px-1.5 rounded bg-gray-100">🔧 {d.equipment_name}</span>}
              </p>
            </Link>
            <div className="flex gap-3 text-sm shrink-0">
              <button onClick={() => setQrDoc(d)} className="text-brand-700 hover:underline">{t('documents.qr')}</button>
              <a href={api.documents.downloadUrl(d.id)} className="text-brand-700 hover:underline">{t('documents.download')}</a>
              {canEdit && (
                <button onClick={() => remove(d)} className="text-red-600 hover:underline">{t('common.delete')}</button>
              )}
            </div>
          </div>
        ))}
        {!loading && documents.length === 0 && <p className="p-4 text-sm text-gray-400">{t('documents.none')}</p>}
        {loading && !data && <p className="p-4 text-sm text-gray-400">{t('common.loading')}</p>}
      </div>

      {qrDoc && (
        <QrModal
          title={t('qr.document_title')}
          subtitle={qrDoc.title}
          code={`DOC-${qrDoc.id}`}
          meta={[t(`category.${qrDoc.category}`)]}
          value={`${window.location.origin}/documents/${qrDoc.id}`}
          onClose={() => setQrDoc(null)}
        />
      )}
    </div>
  );
}
