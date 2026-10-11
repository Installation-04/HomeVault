import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import { api } from '../api/client.js';

export default function PropertySwitcher() {
  const { t } = useTranslation();
  const { properties, currentId, selectProperty, refresh } = useProperties();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const p = await api.properties.create({ name: name.trim() });
      setName('');
      setAdding(false);
      await refresh();
      selectProperty(p.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={t('properties.switcher')}
        className="text-sm border rounded px-2 py-1 max-w-[8.5rem] sm:max-w-[12rem]"
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
        <form onSubmit={submit} className="flex gap-1 items-center">
          <input
            autoFocus
            className="text-sm border rounded px-2 py-1 w-32"
            placeholder={t('properties.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
          />
          <button type="submit" disabled={busy} className="text-sm px-2 py-1 bg-brand-600 text-white rounded disabled:opacity-50">
            {t('common.save')}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </form>
      ) : (
        // Icon-only on phones so the header row doesn't overflow.
        <button
          onClick={() => setAdding(true)}
          aria-label={t('properties.add')}
          title={t('properties.add')}
          className="text-sm text-brand-700 hover:underline whitespace-nowrap px-1"
        >
          +<span className="hidden sm:inline"> {t('properties.add')}</span>
        </button>
      )}
    </div>
  );
}
