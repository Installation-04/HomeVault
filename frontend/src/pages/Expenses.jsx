import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import { api } from '../api/client.js';

const CATEGORIES = ['maintenance', 'insurance', 'tax', 'utility', 'improvement', 'other'];

export default function Expenses() {
  const { t } = useTranslation();
  const { currentId } = useProperties();
  const [expenses, setExpenses] = useState([]);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [form, setForm] = useState({ category: 'maintenance', amount: '', expense_date: '', is_home_office: false, description: '' });

  const load = () => {
    if (!currentId) return;
    api.expenses.list(currentId, { year }).then(setExpenses);
  };

  useEffect(load, [currentId, year]);

  const submit = async (e) => {
    e.preventDefault();
    await api.expenses.create({ ...form, property_id: currentId, amount: Number(form.amount) });
    setForm({ category: 'maintenance', amount: '', expense_date: '', is_home_office: false, description: '' });
    load();
  };

  const remove = async (id) => {
    await api.expenses.remove(id);
    load();
  };

  const total = expenses.reduce((sum, e) => sum + e.amount, 0);

  if (!currentId) return <p className="text-gray-500">{t('dashboard.no_properties')}</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <input
          className="border rounded px-2 py-1 text-sm w-24"
          value={year}
          onChange={(e) => setYear(e.target.value)}
        />
        <a href={api.expenses.exportCsvUrl(currentId, year)} className="text-sm text-brand-700 hover:underline">
          {t('expenses.export_csv')}
        </a>
      </div>

      <form onSubmit={submit} className="bg-white rounded-lg shadow p-4 mb-4 grid gap-2 sm:grid-cols-5 text-sm items-end">
        <select
          className="border rounded px-2 py-2"
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
          type="number"
          step="0.01"
          className="border rounded px-2 py-2"
          placeholder={t('expenses.amount')}
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          required
        />
        <input
          type="date"
          className="border rounded px-2 py-2"
          value={form.expense_date}
          onChange={(e) => setForm({ ...form, expense_date: e.target.value })}
          required
        />
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={form.is_home_office}
            onChange={(e) => setForm({ ...form, is_home_office: e.target.checked })}
          />
          {t('expenses.home_office')}
        </label>
        <button className="bg-brand-600 text-white rounded py-2">{t('expenses.add')}</button>
      </form>

      <div className="bg-white rounded-lg shadow divide-y">
        {expenses.map((e) => (
          <div key={e.id} className="p-3 flex justify-between items-center text-sm">
            <div>
              <span className="font-medium">{e.category}</span>
              <span className="text-gray-500 ml-2">{e.expense_date}</span>
              {e.is_home_office ? <span className="ml-2 text-xs text-brand-600">HO</span> : null}
            </div>
            <div className="flex items-center gap-3">
              <span>{e.amount.toFixed(2)} {e.currency}</span>
              <button onClick={() => remove(e.id)} className="text-red-600 hover:underline">
                {t('common.delete')}
              </button>
            </div>
          </div>
        ))}
        {expenses.length === 0 && <p className="p-4 text-sm text-gray-400">—</p>}
      </div>
      <p className="text-right text-sm font-medium mt-2">Total: {total.toFixed(2)}</p>
    </div>
  );
}
