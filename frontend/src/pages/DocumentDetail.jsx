import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useProperties } from '../property/PropertyContext.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import ErrorBox from '../components/ErrorBox.jsx';
import ExpiryBadge from '../components/ExpiryBadge.jsx';
import QrModal from '../components/QrModal.jsx';
import { btnDanger, btnPrimary, btnSecondary, card, input, label } from '../components/ui.js';
import { formatBytes } from '../utils/format.js';
import { formatDate } from '../utils/dates.js';
import { DOCUMENT_CATEGORIES } from './Documents.jsx';

const toForm = (doc) => ({
  title: doc.title,
  category: doc.category,
  document_date: doc.document_date || '',
  expiry_date: doc.expiry_date || '',
  tags: doc.tags || '',
  notes: doc.notes || '',
  equipment_id: doc.equipment_id ? String(doc.equipment_id) : '',
});

// Reached either from the Documents list or by scanning a QR code printed
// on a physical folder/appliance -- access control is still enforced
// server-side via requirePropertyAccess on GET /documents/:id.
export default function DocumentDetail() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { properties } = useProperties();
  const { data: doc, error, reload } = useAsync(() => api.documents.get(id), [id]);
  const { data: equipment } = useAsync(() => (doc ? api.equipment.list(doc.property_id) : Promise.resolve([])), [doc?.property_id]);
  const [showQr, setShowQr] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (doc) setForm(toForm(doc));
  }, [doc]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!doc || !form) return <p>{t('common.loading')}</p>;

  const canEdit = properties.find((p) => p.id === doc.property_id)?.role === 'owner';
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setSaveError('');
    try {
      await api.documents.update(doc.id, form);
      setEditing(false);
      await reload();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({ message: t('documents.delete_confirm', { title: doc.title }), danger: true });
    if (!ok) return;
    try {
      await api.documents.remove(doc.id);
      navigate('/documents');
    } catch (err) {
      setSaveError(err.message);
    }
  };

  return (
    <div className="max-w-xl">
      <button onClick={() => navigate('/documents')} className="text-sm text-brand-700 hover:underline mb-3">
        ← {t('nav.documents')}
      </button>

      <div className={card}>
        {!editing ? (
          <>
            <div className="flex items-start justify-between gap-2">
              <h1 className="font-semibold text-lg text-brand-700 break-words">{doc.title}</h1>
              <ExpiryBadge date={doc.expiry_date} />
            </div>
            <p className="text-sm text-gray-500 mb-3">
              {t(`category.${doc.category}`)} · {formatDate(doc.document_date, i18n.language)}
              {doc.expiry_date ? ` · ${t('documents.expires_on', { date: formatDate(doc.expiry_date, i18n.language) })}` : ''}
            </p>
            {doc.equipment_id && (
              <p className="text-sm mb-3">
                🔧 <Link to={`/equipment/${doc.equipment_id}`} className="text-brand-700 hover:underline">{doc.equipment_name}</Link>
              </p>
            )}
            {doc.tags && <p className="text-xs text-gray-500 mb-3">🏷 {doc.tags}</p>}
            {doc.notes && <p className="text-sm mb-3 whitespace-pre-wrap">{doc.notes}</p>}
            <p className="text-xs text-gray-400 mb-4">
              {doc.file_name} · {formatBytes(doc.file_size)}
            </p>
            <div className="flex flex-wrap gap-3 text-sm">
              <a href={api.documents.downloadUrl(doc.id)} className="px-3 py-2 rounded bg-brand-600 text-white hover:bg-brand-hover">
                {t('documents.download')}
              </a>
              <button onClick={() => setShowQr(true)} className={btnSecondary}>{t('documents.qr')}</button>
              {canEdit && (
                <>
                  <button onClick={() => setEditing(true)} className={btnSecondary}>{t('common.edit')}</button>
                  <button onClick={remove} className={`${btnDanger} ml-auto`}>{t('common.delete')}</button>
                </>
              )}
            </div>
            {saveError && <p role="alert" className="text-sm text-red-600 mt-3">{saveError}</p>}
          </>
        ) : (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2 text-sm">
            <div className="sm:col-span-2">
              <label className={label} htmlFor="e-title">{t('documents.title')}</label>
              <input id="e-title" className={input} value={form.title} onChange={(e) => set({ title: e.target.value })} required />
            </div>
            <div>
              <label className={label} htmlFor="e-cat">{t('documents.category')}</label>
              <select id="e-cat" className={input} value={form.category} onChange={(e) => set({ category: e.target.value })}>
                {DOCUMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{t(`category.${c}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="e-eq">{t('documents.linked_equipment')}</label>
              <select id="e-eq" className={input} value={form.equipment_id} onChange={(e) => set({ equipment_id: e.target.value })}>
                <option value="">—</option>
                {(equipment || []).map((eq) => (
                  <option key={eq.id} value={eq.id}>{eq.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="e-date">{t('documents.date')}</label>
              <input id="e-date" type="date" className={input} value={form.document_date} onChange={(e) => set({ document_date: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="e-exp">{t('documents.expiry')}</label>
              <input id="e-exp" type="date" className={input} value={form.expiry_date} onChange={(e) => set({ expiry_date: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className={label} htmlFor="e-tags">{t('documents.tags')}</label>
              <input id="e-tags" className={input} value={form.tags} onChange={(e) => set({ tags: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className={label} htmlFor="e-notes">{t('properties.notes')}</label>
              <textarea id="e-notes" rows={3} className={input} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
            </div>
            {saveError && <p role="alert" className="text-red-600 sm:col-span-2">{saveError}</p>}
            <div className="sm:col-span-2 flex gap-2">
              <button className={btnPrimary} disabled={busy}>{t('common.save')}</button>
              <button
                type="button"
                className={btnSecondary}
                onClick={() => {
                  setForm(toForm(doc));
                  setSaveError('');
                  setEditing(false);
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}
      </div>

      {showQr && (
        <QrModal
          title={t('qr.document_title')}
          subtitle={doc.title}
          code={`DOC-${doc.id}`}
          meta={[t(`category.${doc.category}`)]}
          value={`${window.location.origin}/documents/${doc.id}`}
          onClose={() => setShowQr(false)}
        />
      )}
    </div>
  );
}
