import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import { api } from '../api/client.js';

export default function PropertySwitcher() {
  const { t } = useTranslation();
  const { properties, currentId, selectProperty, refresh } = useProperties();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    const p = await api.properties.create({ name });
    setName('');
    setAdding(false);
    await refresh();
    selectProperty(p.id);
  };

  return (
    <div className="flex items-center gap-2">
      <select
        className="text-sm border rounded px-2 py-1"
        value={currentId || ''}
        onChange={(e) => selectProperty(e.target.value)}
      >
        {properties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {adding ? (
        <form onSubmit={submit} className="flex gap-1">
          <input
            autoFocus
            className="text-sm border rounded px-2 py-1 w-32"
            placeholder={t('properties.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="text-sm px-2 py-1 bg-brand-600 text-white rounded">
            {t('common.save')}
          </button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)} className="text-sm text-brand-700 hover:underline">
          + {t('properties.add')}
        </button>
      )}
    </div>
  );
}
