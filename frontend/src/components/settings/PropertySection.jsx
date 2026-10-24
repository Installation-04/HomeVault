import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useProperties } from '../../property/PropertyContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { btnDanger, btnPrimary, card, input, label } from '../ui.js';
import { Feedback, useAction } from './shared.jsx';

const PROPERTY_TYPES = ['house', 'condo', 'rental', 'cottage', 'other'];

export default function PropertySection({ property, canEdit }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { refresh } = useProperties();
  const [form, setForm] = useState(null);
  const [state, run] = useAction();
  const [deleteState, runDelete] = useAction();

  useEffect(() => {
    setForm({
      name: property.name || '',
      address: property.address || '',
      type: property.type || '',
      purchase_date: property.purchase_date || '',
      notes: property.notes || '',
    });
  }, [property]);

  if (!form) return null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      await api.properties.update(property.id, form);
      await refresh();
    });
  };

  const remove = async () => {
    const ok = await confirm({ title: t('settings.delete_property'), message: t('settings.delete_property_confirm', { name: property.name }), danger: true });
    if (!ok) return;
    const done = await runDelete(async () => {
      await api.properties.remove(property.id);
      await refresh();
    });
    if (done) navigate('/');
  };

  return (
    <section className={card}>
      <h2 className="font-semibold mb-3">{t('settings.property')}</h2>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2 text-sm">
        <div>
          <label className={label} htmlFor="p-name">{t('properties.name')}</label>
          <input id="p-name" className={input} value={form.name} onChange={(e) => set({ name: e.target.value })} required disabled={!canEdit} />
        </div>
        <div>
          <label className={label} htmlFor="p-type">{t('properties.type')}</label>
          <select id="p-type" className={input} value={form.type} onChange={(e) => set({ type: e.target.value })} disabled={!canEdit}>
            <option value="">—</option>
            {PROPERTY_TYPES.map((p) => (
              <option key={p} value={p}>{t(`property_type.${p}`)}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="p-address">{t('properties.address')}</label>
          <input id="p-address" className={input} value={form.address} onChange={(e) => set({ address: e.target.value })} disabled={!canEdit} />
        </div>
        <div>
          <label className={label} htmlFor="p-date">{t('properties.purchase_date')}</label>
          <input id="p-date" type="date" className={input} value={form.purchase_date} onChange={(e) => set({ purchase_date: e.target.value })} disabled={!canEdit} />
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="p-notes">{t('properties.notes')}</label>
          <textarea id="p-notes" rows={2} className={input} value={form.notes} onChange={(e) => set({ notes: e.target.value })} disabled={!canEdit} />
        </div>
        {canEdit ? (
          <div className="sm:col-span-2 flex items-center gap-3">
            <button className={btnPrimary} disabled={state.busy}>{t('common.save')}</button>
            <Feedback state={state} />
          </div>
        ) : (
          <p className="sm:col-span-2 text-xs text-gray-500">{t('settings.viewer_note')}</p>
        )}
      </form>

      {canEdit && (
        <div className="mt-5 pt-4 border-t">
          <h3 className="text-sm font-medium text-red-700 mb-1">{t('settings.danger_zone')}</h3>
          <p className="text-xs text-gray-500 mb-2">{t('settings.delete_property_hint')}</p>
          <button className={btnDanger} onClick={remove} disabled={deleteState.busy}>{t('settings.delete_property')}</button>
          <Feedback state={deleteState} />
        </div>
      )}
    </section>
  );
}
