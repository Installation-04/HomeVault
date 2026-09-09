import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import QrModal from '../components/QrModal.jsx';

const CATEGORIES = ['appliance', 'hvac', 'plumbing', 'electrical', 'tool', 'electronics', 'vehicle', 'other'];

// Pre-built search links — no API key, nothing fetched server-side. The
// user picks the right result themselves and attaches it as a document.
function searchLinks(brand, model) {
  const q = [brand, model].filter(Boolean).join(' ');
  if (!q.trim()) return null;
  return [
    { label: 'Google', url: `https://www.google.com/search?q=${encodeURIComponent(q + ' manual pdf')}` },
    { label: 'Images', url: `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=isch` },
    { label: 'Manufacturer site', url: `https://www.google.com/search?q=${encodeURIComponent(brand + ' official site support ' + model)}` },
  ];
}

export default function EquipmentDetail() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [showQr, setShowQr] = useState(false);
  const [logForm, setLogForm] = useState({ log_date: '', description: '', cost: '', performed_by: '' });

  const load = () => {
    api.equipment
      .get(id)
      .then((data) => {
        setItem(data);
        setForm({
          name: data.name,
          category: data.category,
          brand: data.brand || '',
          model_number: data.model_number || '',
          serial_number: data.serial_number || '',
          location: data.location || '',
          purchase_date: data.purchase_date || '',
          warranty_expiry: data.warranty_expiry || '',
          notes: data.notes || '',
        });
      })
      .catch((err) => setError(err.message));
  };

  useEffect(load, [id]);

  const saveInfo = async (e) => {
    e.preventDefault();
    await api.equipment.update(id, form);
    load();
  };

  const uploadPhoto = async (e) => {
    e.preventDefault();
    if (!photoFile) return;
    const fd = new FormData();
    fd.append('file', photoFile);
    await api.equipment.uploadPhoto(id, fd);
    setPhotoFile(null);
    load();
  };

  const removePhoto = async (photoId) => {
    await api.equipment.removePhoto(id, photoId);
    load();
  };

  const addLog = async (e) => {
    e.preventDefault();
    if (!logForm.log_date || !logForm.description) return;
    await api.equipment.addMaintenance(id, { ...logForm, cost: logForm.cost ? Number(logForm.cost) : null });
    setLogForm({ log_date: '', description: '', cost: '', performed_by: '' });
    load();
  };

  const removeLog = async (logId) => {
    await api.equipment.removeMaintenance(id, logId);
    load();
  };

  if (error) return <p className="text-red-600 text-sm">{error}</p>;
  if (!item || !form) return <p>{t('common.loading')}</p>;

  const links = searchLinks(form.brand, form.model_number);

  return (
    <div className="max-w-2xl">
      <button onClick={() => navigate('/equipment')} className="text-sm text-brand-700 hover:underline mb-3">
        ← {t('nav.equipment')}
      </button>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Basic info */}
        <form onSubmit={saveInfo} className="bg-white rounded-lg shadow p-4 space-y-2 sm:col-span-2">
          <div className="flex items-center justify-between mb-1">
            <h1 className="font-semibold text-lg text-brand-700">{item.name}</h1>
            <button type="button" onClick={() => setShowQr(true)} className="text-sm px-3 py-1.5 rounded border hover:bg-gray-50">
              {t('documents.qr')}
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="border rounded px-3 py-2"
              placeholder={t('equipment.name')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
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
              className="border rounded px-3 py-2"
              placeholder={t('equipment.serial_number')}
              value={form.serial_number}
              onChange={(e) => setForm({ ...form, serial_number: e.target.value })}
            />
            <input
              className="border rounded px-3 py-2"
              placeholder={t('equipment.location')}
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('equipment.purchase_date')}</label>
              <input
                type="date"
                className="border rounded px-3 py-2 w-full"
                value={form.purchase_date}
                onChange={(e) => setForm({ ...form, purchase_date: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">{t('equipment.warranty_expiry')}</label>
              <input
                type="date"
                className="border rounded px-3 py-2 w-full"
                value={form.warranty_expiry}
                onChange={(e) => setForm({ ...form, warranty_expiry: e.target.value })}
              />
            </div>
          </div>
          <textarea
            className="border rounded px-3 py-2 w-full"
            placeholder={t('properties.notes')}
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
          <button type="submit" className="bg-brand-600 text-white px-3 py-2 rounded text-sm">
            {t('common.save')}
          </button>
        </form>

        {/* Find manual / pictures online */}
        {links && (
          <div className="bg-white rounded-lg shadow p-4 sm:col-span-2">
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

        {/* Photos */}
        <div className="bg-white rounded-lg shadow p-4 sm:col-span-2">
          <h2 className="font-medium text-sm mb-2">{t('equipment.photos')}</h2>
          <div className="flex flex-wrap gap-2 mb-3">
            {item.photos.map((p) => (
              <div key={p.id} className="relative">
                <img
                  src={api.equipment.photoUrl(item.id, p.id)}
                  alt={p.file_name}
                  className="w-24 h-24 rounded object-cover border"
                />
                <button
                  onClick={() => removePhoto(p.id)}
                  className="absolute -top-2 -right-2 bg-white border rounded-full w-6 h-6 text-xs text-red-600 shadow"
                  aria-label={t('common.delete')}
                >
                  ✕
                </button>
              </div>
            ))}
            {item.photos.length === 0 && <p className="text-sm text-gray-400">—</p>}
          </div>
          <form onSubmit={uploadPhoto} className="flex flex-wrap gap-2 items-center">
            <input type="file" accept="image/*" onChange={(e) => setPhotoFile(e.target.files[0])} className="text-sm" />
            <label className="border rounded px-3 py-1.5 text-sm cursor-pointer bg-gray-50 hover:bg-gray-100">
              📷 {t('documents.take_photo')}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => setPhotoFile(e.target.files[0])}
              />
            </label>
            <button type="submit" disabled={!photoFile} className="bg-brand-600 text-white px-3 py-1.5 rounded text-sm disabled:opacity-40">
              {t('equipment.upload_photo')}
            </button>
          </form>
        </div>

        {/* Maintenance log */}
        <div className="bg-white rounded-lg shadow p-4 sm:col-span-2">
          <h2 className="font-medium text-sm mb-2">{t('equipment.maintenance_log')}</h2>
          <form onSubmit={addLog} className="grid gap-2 sm:grid-cols-4 mb-3 text-sm">
            <input
              type="date"
              className="border rounded px-2 py-1.5"
              value={logForm.log_date}
              onChange={(e) => setLogForm({ ...logForm, log_date: e.target.value })}
            />
            <input
              className="border rounded px-2 py-1.5 sm:col-span-2"
              placeholder={t('equipment.log_description')}
              value={logForm.description}
              onChange={(e) => setLogForm({ ...logForm, description: e.target.value })}
            />
            <input
              className="border rounded px-2 py-1.5"
              placeholder={t('equipment.performed_by')}
              value={logForm.performed_by}
              onChange={(e) => setLogForm({ ...logForm, performed_by: e.target.value })}
            />
            <input
              type="number"
              step="0.01"
              className="border rounded px-2 py-1.5"
              placeholder={t('expenses.amount')}
              value={logForm.cost}
              onChange={(e) => setLogForm({ ...logForm, cost: e.target.value })}
            />
            <button type="submit" className="bg-brand-600 text-white rounded py-1.5 sm:col-span-3">
              {t('equipment.log_maintenance')}
            </button>
          </form>
          <div className="divide-y">
            {item.maintenance.map((m) => (
              <div key={m.id} className="py-2 flex justify-between items-center text-sm">
                <div>
                  <span className="font-medium">{m.description}</span>
                  <span className="text-gray-500 ml-2">{m.log_date}</span>
                  {m.performed_by && <span className="text-gray-400 ml-2">· {m.performed_by}</span>}
                </div>
                <div className="flex items-center gap-3">
                  {m.cost != null && <span>{Number(m.cost).toFixed(2)}</span>}
                  <button onClick={() => removeLog(m.id)} className="text-red-600 hover:underline">
                    {t('common.delete')}
                  </button>
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
          value={`${window.location.origin}/equipment/${item.id}`}
          onClose={() => setShowQr(false)}
        />
      )}
    </div>
  );
}
