import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import { api } from '../api/client.js';

const CATEGORIES = ['invoice', 'warranty', 'insurance', 'contract', 'photo', 'maintenance', 'tax', 'other'];

export default function Documents() {
  const { t } = useTranslation();
  const { currentId } = useProperties();
  const [documents, setDocuments] = useState([]);
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', category: 'other', document_date: '', expiry_date: '', tags: '' });
  const [file, setFile] = useState(null);

  const load = () => {
    if (!currentId) return;
    api.documents.list(currentId, query ? { q: query } : {}).then(setDocuments);
  };

  useEffect(load, [currentId, query]);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return;
    const fd = new FormData();
    fd.append('property_id', currentId);
    fd.append('file', file);
    Object.entries(form).forEach(([k, v]) => fd.append(k, v));
    await api.documents.upload(fd);
    setShowForm(false);
    setForm({ title: '', category: 'other', document_date: '', expiry_date: '', tags: '' });
    setFile(null);
    load();
  };

  const remove = async (id) => {
    await api.documents.remove(id);
    load();
  };

  if (!currentId) return <p className="text-gray-500">{t('dashboard.no_properties')}</p>;

  return (
    <div>
      <div className="flex flex-wrap gap-2 items-center justify-between mb-4">
        <input
          className="border rounded px-3 py-2 text-sm flex-1 min-w-[200px]"
          placeholder={t('documents.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex gap-2">
          <a href={api.exportBundleUrl(currentId)} className="text-sm text-brand-700 hover:underline">
            {t('documents.export_bundle')}
          </a>
          <button onClick={() => setShowForm((v) => !v)} className="bg-brand-600 text-white text-sm px-3 py-2 rounded">
            {t('documents.upload')}
          </button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-white rounded-lg shadow p-4 mb-4 grid gap-3 sm:grid-cols-2">
          <input
            className="border rounded px-3 py-2"
            placeholder={t('documents.title')}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
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
            type="date"
            className="border rounded px-3 py-2"
            value={form.document_date}
            onChange={(e) => setForm({ ...form, document_date: e.target.value })}
          />
          <input
            type="date"
            className="border rounded px-3 py-2"
            placeholder={t('documents.expiry')}
            value={form.expiry_date}
            onChange={(e) => setForm({ ...form, expiry_date: e.target.value })}
          />
          <input
            className="border rounded px-3 py-2"
            placeholder={t('documents.tags')}
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
          />
          <div className="flex flex-wrap gap-2 items-center sm:col-span-2">
            <input
              type="file"
              className="border rounded px-3 py-2 w-full sm:w-auto sm:flex-1 min-w-0"
              onChange={(e) => setFile(e.target.files[0])}
            />
            {/* `capture` opens the camera directly on iOS/Android instead of
                the file picker — the fastest path for a receipt or warranty
                label photo. Desktop browsers just ignore the attribute. */}
            <label className="border rounded px-3 py-2 text-sm cursor-pointer whitespace-nowrap bg-gray-50 hover:bg-gray-100">
              📷 {t('documents.take_photo')}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => setFile(e.target.files[0])}
              />
            </label>
          </div>
          {file && <p className="text-xs text-gray-500 -mt-2">{file.name}</p>}
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

      <div className="bg-white rounded-lg shadow divide-y">
        {documents.map((d) => (
          <div key={d.id} className="p-3 flex items-center justify-between gap-2">
            <div>
              <p className="font-medium text-sm">{d.title}</p>
              <p className="text-xs text-gray-500">
                {d.category} · {d.document_date || '—'} {d.expiry_date ? `· exp ${d.expiry_date}` : ''}
              </p>
            </div>
            <div className="flex gap-3 text-sm">
              <a href={api.documents.downloadUrl(d.id)} className="text-brand-700 hover:underline">
                {t('documents.download')}
              </a>
              <button onClick={() => remove(d.id)} className="text-red-600 hover:underline">
                {t('common.delete')}
              </button>
            </div>
          </div>
        ))}
        {documents.length === 0 && <p className="p-4 text-sm text-gray-400">—</p>}
      </div>
    </div>
  );
}
