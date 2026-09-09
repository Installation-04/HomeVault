import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import { api } from '../api/client.js';

const CATEGORIES = ['appliance', 'hvac', 'plumbing', 'electrical', 'tool', 'electronics', 'vehicle', 'other'];

export default function Equipment() {
  const { t } = useTranslation();
  const { currentId } = useProperties();
  const [items, setItems] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'appliance', brand: '', model_number: '', location: '' });

  const load = () => {
    if (!currentId) return;
    api.equipment.list(currentId).then(setItems);
  };

  useEffect(load, [currentId]);

  const submit = async (e) => {
    e.preventDefault();
    await api.equipment.create({ ...form, property_id: currentId });
    setForm({ name: '', category: 'appliance', brand: '', model_number: '', location: '' });
    setShowForm(false);
    load();
  };

  const remove = async (id) => {
    await api.equipment.remove(id);
    load();
  };

  if (!currentId) return <p className="text-gray-500">{t('dashboard.no_properties')}</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-semibold text-lg">{t('nav.equipment')}</h1>
        <button onClick={() => setShowForm((v) => !v)} className="bg-brand-600 text-white text-sm px-3 py-2 rounded">
          {t('equipment.add')}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-white rounded-lg shadow p-4 mb-4 grid gap-3 sm:grid-cols-2">
          <input
            className="border rounded px-3 py-2"
            placeholder={t('equipment.name')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <select
            className="border rounded px-3 py-2"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            className="border rounded px-3 py-2"
            placeholder={t('equipment.brand')}
            value={form.brand}
            onChange={(e) => setForm({ ...form, brand: e.target.value })}
          />
          <input
            className="border rounded px-3 py-2"
            placeholder={t('equipment.model_number')}
            value={form.model_number}
            onChange={(e) => setForm({ ...form, model_number: e.target.value })}
          />
          <input
            className="border rounded px-3 py-2 sm:col-span-2"
            placeholder={t('equipment.location')}
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
          />
          <div className="sm:col-span-2 flex gap-2">
            <button type="submit" className="bg-brand-600 text-white px-3 py-2 rounded text-sm">
              {t('common.save')}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="px-3 py-2 rounded text-sm border">
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.id} className="bg-white rounded-lg shadow p-3 flex gap-3 items-center">
            {item.cover_photo_id ? (
              <img
                src={api.equipment.photoUrl(item.id, item.cover_photo_id)}
                alt=""
                className="w-14 h-14 rounded object-cover shrink-0"
              />
            ) : (
              <div className="w-14 h-14 rounded bg-gray-100 shrink-0 flex items-center justify-center text-xl">🔧</div>
            )}
            <Link to={`/equipment/${item.id}`} className="min-w-0 flex-1">
              <p className="font-medium text-sm hover:text-brand-700 truncate">{item.name}</p>
              <p className="text-xs text-gray-500 truncate">
                {[item.brand, item.model_number].filter(Boolean).join(' · ') || item.category}
              </p>
              {item.location && <p className="text-xs text-gray-400">{item.location}</p>}
            </Link>
            <button onClick={() => remove(item.id)} className="text-red-600 hover:underline text-xs shrink-0">
              {t('common.delete')}
            </button>
          </div>
        ))}
        {items.length === 0 && <p className="text-sm text-gray-400">—</p>}
      </div>
    </div>
  );
}
