import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import ErrorBox from '../components/ErrorBox.jsx';
import ExpiryBadge from '../components/ExpiryBadge.jsx';
import { btnPrimary, btnSecondary, input, label } from '../components/ui.js';

export const EQUIPMENT_CATEGORIES = ['appliance', 'hvac', 'plumbing', 'electrical', 'tool', 'electronics', 'vehicle', 'other'];
const EMPTY = {
  name: '',
  category: 'appliance',
  brand: '',
  model_number: '',
  serial_number: '',
  location: '',
  purchase_date: '',
  warranty_expiry: '',
};

export default function Equipment() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { currentId, canEdit } = useProperties();
  const { data, error, loading, reload } = useAsync(() => api.equipment.list(currentId), [currentId]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [actionError, setActionError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data || []).filter((i) => {
      if (category && i.category !== category) return false;
      if (!needle) return true;
      return [i.name, i.brand, i.model_number, i.serial_number, i.location].some((v) => v && v.toLowerCase().includes(needle));
    });
  }, [data, search, category]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await api.equipment.create({ ...form, property_id: currentId });
      setForm(EMPTY);
      setShowForm(false);
      reload();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item) => {
    const ok = await confirm({ message: t('equipment.delete_confirm', { name: item.name }), danger: true });
    if (!ok) return;
    setActionError(null);
    try {
      await api.equipment.remove(item.id);
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h1 className="font-semibold text-lg">{t('nav.equipment')}</h1>
        {canEdit && (
          <button onClick={() => setShowForm((v) => !v)} className={btnPrimary}>
            {t('equipment.add')}
          </button>
        )}
      </div>

      {showForm && canEdit && (
        <form onSubmit={submit} className="bg-white rounded-lg shadow p-4 mb-4 grid gap-3 sm:grid-cols-2 text-sm">
          <div>
            <label className={label} htmlFor="q-name">{t('equipment.name')}</label>
            <input id="q-name" className={input} value={form.name} onChange={(e) => set({ name: e.target.value })} required autoFocus />
          </div>
          <div>
            <label className={label} htmlFor="q-cat">{t('documents.category')}</label>
            <select id="q-cat" className={input} value={form.category} onChange={(e) => set({ category: e.target.value })}>
              {EQUIPMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`equipment_category.${c}`)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="q-brand">{t('equipment.brand')}</label>
            <input id="q-brand" className={input} value={form.brand} onChange={(e) => set({ brand: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="q-model">{t('equipment.model_number')}</label>
            <input id="q-model" className={input} value={form.model_number} onChange={(e) => set({ model_number: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="q-serial">{t('equipment.serial_number')}</label>
            <input id="q-serial" className={input} value={form.serial_number} onChange={(e) => set({ serial_number: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="q-loc">{t('equipment.location')}</label>
            <input id="q-loc" className={input} value={form.location} onChange={(e) => set({ location: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="q-pdate">{t('equipment.purchase_date')}</label>
            <input id="q-pdate" type="date" className={input} value={form.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="q-war">{t('equipment.warranty_expiry')}</label>
            <input id="q-war" type="date" className={input} value={form.warranty_expiry} onChange={(e) => set({ warranty_expiry: e.target.value })} />
          </div>
          {formError && <p role="alert" className="text-red-600 sm:col-span-2">{formError}</p>}
          <div className="sm:col-span-2 flex gap-2">
            <button type="submit" disabled={busy} className={btnPrimary}>{t('common.save')}</button>
            <button type="button" onClick={() => setShowForm(false)} className={btnSecondary}>{t('common.cancel')}</button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap gap-2 mb-4 text-sm">
        <input
          type="search"
          className="border rounded px-3 py-2 flex-1 min-w-[180px]"
          placeholder={t('equipment.search')}
          aria-label={t('equipment.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label={t('common.filter_category')} className="border rounded px-2 py-2" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t('documents.all_categories')}</option>
          {EQUIPMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(`equipment_category.${c}`)}</option>
          ))}
        </select>
      </div>

      <ErrorBox error={error || actionError} onRetry={error ? reload : undefined} />

      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.id} className="bg-white rounded-lg shadow p-3 flex gap-3 items-center">
            {item.cover_photo_id ? (
              <img
                src={api.equipment.photoUrl(item.id, item.cover_photo_id)}
                alt=""
                loading="lazy"
                className="w-14 h-14 rounded object-cover shrink-0"
              />
            ) : (
              <div className="w-14 h-14 rounded bg-gray-100 shrink-0 flex items-center justify-center text-xl" aria-hidden="true">🔧</div>
            )}
            <Link to={`/equipment/${item.id}`} className="min-w-0 flex-1">
              <p className="font-medium text-sm hover:text-brand-700 truncate">{item.name}</p>
              <p className="text-xs text-gray-500 truncate">
                {[item.brand, item.model_number].filter(Boolean).join(' · ') || t(`equipment_category.${item.category}`)}
              </p>
              {item.location && <p className="text-xs text-gray-400 truncate">{item.location}</p>}
              {item.warranty_expiry && (
                <p className="mt-1">
                  <ExpiryBadge date={item.warranty_expiry} />
                </p>
              )}
            </Link>
            {canEdit && (
              <button onClick={() => remove(item)} className="text-red-600 hover:underline text-xs shrink-0">
                {t('common.delete')}
              </button>
            )}
          </div>
        ))}
        {!loading && items.length === 0 && (
          <p className="text-sm text-gray-400">{data && data.length > 0 ? t('equipment.no_match') : t('equipment.none')}</p>
        )}
      </div>
    </div>
  );
}
