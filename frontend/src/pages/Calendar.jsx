import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProperties } from '../property/PropertyContext.jsx';
import { api } from '../api/client.js';

export default function Calendar() {
  const { t } = useTranslation();
  const { currentId } = useProperties();
  const [events, setEvents] = useState([]);
  const [newReminder, setNewReminder] = useState({ title: '', due_date: '', category: 'maintenance', recurrence: 'none' });
  const [newTask, setNewTask] = useState({ title: '', event_date: '', recurrence: 'none' });

  const load = () => {
    if (!currentId) return;
    api.calendar.list(currentId).then(setEvents);
  };

  useEffect(load, [currentId]);

  const addReminder = async (e) => {
    e.preventDefault();
    await api.reminders.create({ ...newReminder, property_id: currentId });
    setNewReminder({ title: '', due_date: '', category: 'maintenance', recurrence: 'none' });
    load();
  };

  const addTask = async (e) => {
    e.preventDefault();
    await api.tasks.create({ ...newTask, property_id: currentId });
    setNewTask({ title: '', event_date: '', recurrence: 'none' });
    load();
  };

  const complete = async (ev) => {
    if (ev.type === 'reminder') await api.reminders.complete(ev.id);
    else await api.tasks.complete(ev.id);
    load();
  };

  if (!currentId) return <p className="text-gray-500">{t('dashboard.no_properties')}</p>;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <h2 className="font-semibold mb-2">{t('calendar.reminders')}</h2>
        <form onSubmit={addReminder} className="bg-white rounded-lg shadow p-3 mb-3 grid grid-cols-2 gap-2 text-sm">
          <input
            className="border rounded px-2 py-1 col-span-2"
            placeholder={t('documents.title')}
            value={newReminder.title}
            onChange={(e) => setNewReminder({ ...newReminder, title: e.target.value })}
          />
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={newReminder.due_date}
            onChange={(e) => setNewReminder({ ...newReminder, due_date: e.target.value })}
          />
          <select
            className="border rounded px-2 py-1"
            value={newReminder.recurrence}
            onChange={(e) => setNewReminder({ ...newReminder, recurrence: e.target.value })}
          >
            <option value="none">none</option>
            <option value="monthly">monthly</option>
            <option value="yearly">yearly</option>
            <option value="custom">custom</option>
          </select>
          <button className="col-span-2 bg-brand-600 text-white rounded py-1">{t('common.save')}</button>
        </form>

        <h2 className="font-semibold mb-2">{t('calendar.tasks')}</h2>
        <form onSubmit={addTask} className="bg-white rounded-lg shadow p-3 grid grid-cols-2 gap-2 text-sm">
          <input
            className="border rounded px-2 py-1 col-span-2"
            placeholder={t('documents.title')}
            value={newTask.title}
            onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
          />
          <input
            type="date"
            className="border rounded px-2 py-1 col-span-2"
            value={newTask.event_date}
            onChange={(e) => setNewTask({ ...newTask, event_date: e.target.value })}
          />
          <button className="col-span-2 bg-brand-600 text-white rounded py-1">{t('common.save')}</button>
        </form>
      </div>

      <div>
        <h2 className="font-semibold mb-2">Upcoming</h2>
        <div className="bg-white rounded-lg shadow divide-y">
          {events
            .filter((e) => !e.completed_at)
            .map((ev) => (
              <div key={`${ev.type}-${ev.id}`} className="p-3 flex justify-between items-center text-sm">
                <div>
                  <span className="font-medium">{ev.title}</span>
                  <span className="text-gray-500 ml-2">{ev.date}</span>
                  <span className="ml-2 text-xs text-gray-400">[{ev.type}]</span>
                </div>
                <button onClick={() => complete(ev)} className="text-brand-700 hover:underline">
                  ✓
                </button>
              </div>
            ))}
          {events.length === 0 && <p className="p-4 text-sm text-gray-400">—</p>}
        </div>
      </div>
    </div>
  );
}
