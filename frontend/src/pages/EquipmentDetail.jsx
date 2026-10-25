import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import ErrorBox from '../components/ErrorBox.jsx';
import ExpiryBadge from '../components/ExpiryBadge.jsx';
import QrModal from '../components/QrModal.jsx';
import { btnDanger, btnPrimary, card, input, label } from '../components/ui.js';
import { formatDate, relativeDays, todayStr } from '../utils/dates.js';
import { CURRENCIES, PRESETS, firstDueDate } from '../utils/presets.js';
import { formatNumber } from '../utils/format.js';
import { EQUIPMENT_CATEGORIES } from './Equipment.jsx';

// Pre-built search links — no API key, nothing fetched server-side. The
// user picks the right result themselves and attaches it as a document.
function searchLinks(brand, model) {
  const q = [brand, model].filter(Boolean).join(' ');
  if (!q.trim()) return null;
  return [
    { label: 'Google', url: `https://www.google.com/search?q=${encodeURIComponent(q + ' manual pdf')}` },
    { label: 'Images', url: `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=isch` },
    { label: 'Manufacturer site', url: `https://www.google.com/search?q=${encodeURIComponent(`${brand || ''} official site support ${model || ''}`.trim())}` },
  ];
}

const toForm = (data) => ({
  name: data.name,
  category: data.category,
  brand: data.brand || '',
  model_number: data.model_number || '',
  serial_number: data.serial_number || '',
  location: data.location || '',
  purchase_date: data.purchase_date || '',
  warranty_expiry: data.warranty_expiry || '',
  purchase_price: data.purchase_price ?? '',
  purchase_currency: data.purchase_currency || 'CAD',
  notes: data.notes || '',
});

const emptyLog = () => ({ log_date: todayStr(), description: '', cost: '', performed_by: '' });

export default function EquipmentDetail() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const locale = i18n.language;
  const { data: item, error, reload } = useAsync(() => api.equipment.get(id), [id]);
  const [form, setForm] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoKey, setPhotoKey] = useState(0);
  const [showQr, setShowQr] = useState(false);
  const [logForm, setLogForm] = useState(emptyLog);
  const [notice, setNotice] = useState({ kind: '', text: '' }); // kind: 'ok' | 'error'

  useEffect(() => {
    if (item) setForm(toForm(item));
  }, [item]);

  useEffect(() => {
    if (notice.kind !== 'ok') return undefined;
    const timer = setTimeout(() => setNotice({ kind: '', text: '' }), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!item || !form) return <p>{t('common.loading')}</p>;

  const canEdit = item.role === 'owner';
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Runs a mutation, then refreshes; failures are shown instead of swallowed.
  const attempt = async (fn, okText) => {
    setNotice({ kind: '', text: '' });
    try {
      await fn();
      await reload();
      if (okText) setNotice({ kind: 'ok', text: okText });
      return true;
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
      return false;
    }
  };

  const saveInfo = (e) => {
    e.preventDefault();
    attempt(() => api.equipment.update(id, { ...form, purchase_price: form.purchase_price === '' ? null : Number(form.purchase_price) }), t('common.saved'));
  };

  const uploadPhoto = async (e) => {
    e.preventDefault();
    if (!photoFile) return;
    const fd = new FormData();
    fd.append('file', photoFile);
    const ok = await attempt(() => api.equipment.uploadPhoto(id, fd));
    if (ok) {
      setPhotoFile(null);
      setPhotoKey((k) => k + 1);
    }
  };

  const removePhoto = async (photoId) => {
    if (await confirm({ message: t('equipment.delete_photo_confirm'), danger: true })) {
      attempt(() => api.equipment.removePhoto(id, photoId));
    }
  };

  const addLog = async (e) => {
    e.preventDefault();
    if (!logForm.log_date || !logForm.description) return;
    const ok = await attempt(() =>
      api.equipment.addMaintenance(id, { ...logForm, cost: logForm.cost === '' ? null : Number(logForm.cost) })
    );
    if (ok) setLogForm(emptyLog());
  };

  const removeLog = async (log) => {
    if (await confirm({ message: t('equipment.delete_log_confirm', { description: log.description }), danger: true })) {
      attempt(() => api.equipment.removeMaintenance(id, log.id));
    }
  };

  // One click turns a suggested schedule into a real, recurring reminder tied to this item.
  const addPreset = (preset) =>
    attempt(() =>
      api.reminders.create({
        property_id: item.property_id,
        equipment_id: item.id,
        title: `${t(`presets.${preset.key}`)} – ${item.name}`,
        due_date: firstDueDate(preset),
        recurrence: preset.recurrence,
        recurrence_interval_days: preset.interval,
        category: 'maintenance',
        lead_time_days: 7,
      })
    );

  const removeItem = async () => {
    if (!(await confirm({ message: t('equipment.delete_confirm', { name: item.name }), danger: true }))) return;
    try {
      await api.equipment.remove(id);
      navigate('/equipment');
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    }
  };

  const links = searchLinks(form.brand, form.model_number);

  return (
    <div className="max-w-2xl">
      <button onClick={() => navigate('/equipment')} className="text-sm text-brand-700 hover:underline mb-3">
        ← {t('nav.equipment')}
      </button>

      {notice.kind === 'error' && (
        <div className="mb-3">
          <ErrorBox error={{ message: notice.text }} />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Basic info */}
        <form onSubmit={saveInfo} className={`${card} space-y-2 sm:col-span-2`}>
          <div className="flex items-start justify-between gap-2 mb-1">
            <div className="min-w-0">
              <h1 className="font-semibold text-lg text-brand-700 break-words">{item.name}</h1>
              <ExpiryBadge date={item.warranty_expiry} showOk />
            </div>
            <button type="button" onClick={() => setShowQr(true)} className="text-sm px-3 py-1.5 rounded border hover:bg-gray-50 shrink-0">
              {t('documents.qr')}
            </button>
          </div>
          <fieldset disabled={!canEdit} className="grid gap-2 sm:grid-cols-2 text-sm">
            <div>
              <label className={label} htmlFor="eq-name">{t('equipment.name')}</label>
              <input id="eq-name" className={input} value={form.name} onChange={(e) => set({ name: e.target.value })} required />
            </div>
            <div>
              <label className={label} htmlFor="eq-cat">{t('documents.category')}</label>
              <select id="eq-cat" className={input} value={form.category} onChange={(e) => set({ category: e.target.value })}>
                {EQUIPMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{t(`equipment_category.${c}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="eq-brand">{t('equipment.brand')}</label>
              <input id="eq-brand" className={input} value={form.brand} onChange={(e) => set({ brand: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="eq-model">{t('equipment.model_number')}</label>
              <input id="eq-model" className={input} value={form.model_number} onChange={(e) => set({ model_number: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="eq-serial">{t('equipment.serial_number')}</label>
              <input id="eq-serial" className={input} value={form.serial_number} onChange={(e) => set({ serial_number: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="eq-loc">{t('equipment.location')}</label>
              <input id="eq-loc" className={input} value={form.location} onChange={(e) => set({ location: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="eq-pdate">{t('equipment.purchase_date')}</label>
              <input id="eq-pdate" type="date" className={input} value={form.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="eq-war">{t('equipment.warranty_expiry')}</label>
              <input id="eq-war" type="date" className={input} value={form.warranty_expiry} onChange={(e) => set({ warranty_expiry: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="eq-price">{t('equipment.purchase_price')}</label>
              <div className="flex gap-2">
                <input id="eq-price" type="number" min="0" step="0.01" inputMode="decimal" className={input} value={form.purchase_price} onChange={(e) => set({ purchase_price: e.target.value })} />
                <select aria-label={t('expenses.currency')} className="border rounded px-2 bg-surface" value={form.purchase_currency} onChange={(e) => set({ purchase_currency: e.target.value })}>
                  {[...new Set([...CURRENCIES, form.purchase_currency])].map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="sm:col-span-2">
              <label className={label} htmlFor="eq-notes">{t('properties.notes')}</label>
              <textarea id="eq-notes" className={input} rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
            </div>
          </fieldset>
          {canEdit && (
            <div className="flex items-center gap-3">
              <button type="submit" className={btnPrimary}>{t('common.save')}</button>
              {notice.kind === 'ok' && <span role="status" className="text-sm text-emerald-700">✓ {notice.text}</span>}
              <button type="button" onClick={removeItem} className={`${btnDanger} ml-auto`}>{t('common.delete')}</button>
            </div>
          )}
        </form>

        {/* Find manual / pictures online */}
        {links && (
          <div className={`${card} sm:col-span-2`}>
            <h2 className="font-medium text-sm mb-2">{t('equipment.find_online')}</h2>
            <div className="flex flex-wrap gap-2">
              {links.map((l) => (
                <a
                  key={l.label}
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm px-3 py-1.5 rounded border hover:bg-gray-50 text-brand-700"
                >
                  {l.label} ↗
                </a>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-2">{t('equipment.find_online_hint')}</p>
          </div>
        )}

        {/* Linked documents (manuals, receipts, warranty cards) */}
        <div className={`${card} sm:col-span-2`}>
          <h2 className="font-medium text-sm mb-2">{t('equipment.documents')}</h2>
          {item.documents.length === 0 ? (
            <p className="text-sm text-gray-400">{t('equipment.no_documents')}</p>
          ) : (
            <ul className="divide-y text-sm">
              {item.documents.map((d) => (
                <li key={d.id} className="py-1.5">
                  <Link to={`/documents/${d.id}`} className="flex justify-between gap-2 hover:text-brand-700">
                    <span className="truncate">{d.title}</span>
                    <span className="text-xs text-gray-400 shrink-0">{t(`category.${d.category}`)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {canEdit && <p className="text-xs text-gray-400 mt-2">{t('equipment.documents_hint')}</p>}
        </div>

        {/* Photos */}
        <div className={`${card} sm:col-span-2`}>
          <h2 className="font-medium text-sm mb-2">{t('equipment.photos')}</h2>
          <div className="flex flex-wrap gap-2 mb-3">
            {item.photos.map((p) => (
              <div key={p.id} className="relative">
                <img
                  src={api.equipment.photoUrl(item.id, p.id)}
                  alt={p.file_name}
                  loading="lazy"
                  className="w-24 h-24 rounded object-cover border"
                />
                {canEdit && (
                  <button
                    onClick={() => removePhoto(p.id)}
                    className="absolute -top-2 -right-2 bg-surface border rounded-full w-6 h-6 text-xs text-red-600 shadow"
                    aria-label={t('common.delete')}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {item.photos.length === 0 && <p className="text-sm text-gray-400">—</p>}
          </div>
          {canEdit && (
            <form onSubmit={uploadPhoto} className="flex flex-wrap gap-2 items-center">
              <input
                key={`p${photoKey}`}
                type="file"
                accept="image/*"
                aria-label={t('equipment.choose_photo')}
                onChange={(e) => setPhotoFile(e.target.files[0] || null)}
                className="text-sm"
              />
              <label className="border rounded px-3 py-1.5 text-sm cursor-pointer bg-gray-50 hover:bg-gray-100">
                📷 {t('documents.take_photo')}
                <input
                  key={`c${photoKey}`}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => setPhotoFile(e.target.files[0] || null)}
                />
              </label>
              <button type="submit" disabled={!photoFile} className="bg-brand-600 text-white px-3 py-1.5 rounded text-sm disabled:opacity-40">
                {t('equipment.upload_photo')}
              </button>
              {photoFile && <span className="text-xs text-gray-500 truncate max-w-[10rem]">{photoFile.name}</span>}
            </form>
          )}
        </div>

        {/* Recurring maintenance for this item */}
        <div className={`${card} sm:col-span-2`}>
          <h2 className="font-medium text-sm mb-2">{t('equipment.reminders')}</h2>
          {item.reminders.length === 0 ? (
            <p className="text-sm text-gray-400">{t('equipment.no_reminders')}</p>
          ) : (
            <ul className="divide-y text-sm">
              {item.reminders.map((r) => (
                <li key={r.id} className="py-1.5 flex justify-between gap-3">
                  <Link to="/calendar" className={`truncate hover:text-brand-700 ${r.completed_at ? 'line-through text-gray-400' : ''}`}>
                    {r.title}
                  </Link>
                  <span className="text-xs text-gray-500 shrink-0">
                    {r.recurrence !== 'none' && `↻ ${t(`recurrence.${r.recurrence}`)} · `}
                    {formatDate(r.due_date, locale)}
                    {!r.completed_at && ` · ${relativeDays(r.due_date, locale)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div className="mt-3 pt-3 border-t">
              <p className="text-xs text-gray-500 mb-2">{t('equipment.suggested')}</p>
              <div className="flex flex-wrap gap-2">
                {(PRESETS[item.category] || PRESETS.other).map((preset) => {
                  const title = `${t(`presets.${preset.key}`)} – ${item.name}`;
                  const exists = item.reminders.some((r) => r.title === title && !r.completed_at);
                  return (
                    <button
                      key={preset.key}
                      type="button"
                      disabled={exists}
                      onClick={() => addPreset(preset)}
                      title={exists ? t('equipment.already_scheduled') : ''}
                      className="text-sm px-3 py-1.5 rounded border bg-surface hover:bg-brand-50 disabled:opacity-50 disabled:hover:bg-surface"
                    >
                      {exists ? '✓' : '+'} {t(`presets.${preset.key}`)}
                      <span className="text-xs text-gray-400"> · {preset.recurrence === 'yearly' ? t('recurrence.yearly') : t('presets.every_days', { count: preset.interval })}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Maintenance log */}
        <div className={`${card} sm:col-span-2`}>
          <h2 className="font-medium text-sm mb-2">{t('equipment.maintenance_log')}</h2>
          <form onSubmit={addLog} className="grid gap-2 sm:grid-cols-4 mb-3 text-sm">
            <input
              type="date"
              aria-label={t('documents.date')}
              className="border rounded px-2 py-1.5"
              value={logForm.log_date}
              onChange={(e) => setLogForm({ ...logForm, log_date: e.target.value })}
              required
            />
            <input
              className="border rounded px-2 py-1.5 sm:col-span-2"
              placeholder={t('equipment.log_description')}
              aria-label={t('equipment.log_description')}
              value={logForm.description}
              onChange={(e) => setLogForm({ ...logForm, description: e.target.value })}
              required
            />
            <input
              className="border rounded px-2 py-1.5"
              placeholder={t('equipment.performed_by')}
              aria-label={t('equipment.performed_by')}
              value={logForm.performed_by}
              onChange={(e) => setLogForm({ ...logForm, performed_by: e.target.value })}
            />
            <input
              type="number"
              step="0.01"
              className="border rounded px-2 py-1.5"
              placeholder={t('expenses.amount')}
              aria-label={t('expenses.amount')}
              value={logForm.cost}
              onChange={(e) => setLogForm({ ...logForm, cost: e.target.value })}
            />
            <button type="submit" className="bg-brand-600 text-white rounded py-1.5 sm:col-span-3">
              {t('equipment.log_maintenance')}
            </button>
          </form>
          <div className="divide-y">
            {item.maintenance.map((m) => (
              <div key={m.id} className="py-2 flex justify-between items-center gap-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{m.description}</span>
                  <span className="text-gray-500 ml-2">{formatDate(m.log_date, locale)}</span>
                  {m.performed_by && <span className="text-gray-400 ml-2">· {m.performed_by}</span>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {m.cost != null && <span>{formatNumber(m.cost, locale)}</span>}
                  {canEdit && (
                    <button onClick={() => removeLog(m)} className="text-red-600 hover:underline">
                      {t('common.delete')}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {item.maintenance.length === 0 && <p className="text-sm text-gray-400">—</p>}
          </div>
        </div>
      </div>

      {showQr && (
        <QrModal
          title={t('qr.equipment_title')}
          subtitle={item.name}
          code={`EQ-${item.id}`}
          meta={[[form.brand, form.model_number].filter(Boolean).join(' · '), form.location]}
          value={`${window.location.origin}/equipment/${item.id}`}
          onClose={() => setShowQr(false)}
        />
      )}
    </div>
  );
}
