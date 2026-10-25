import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useProperties } from '../property/PropertyContext.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import ErrorBox from '../components/ErrorBox.jsx';
import Modal from '../components/Modal.jsx';
import { btnPrimary, btnSecondary, input, label } from '../components/ui.js';
import { addDays, formatDate, monthLabel, parseDate, relativeDays, toDateStr, todayStr, weekdayLabels } from '../utils/dates.js';
import { projectOccurrences } from '../utils/recurrence.js';

const REMINDER_CATEGORIES = ['maintenance', 'insurance_renewal', 'payment', 'other'];
const RECURRENCES = ['none', 'monthly', 'yearly', 'custom'];

// Reminders and tasks live in separate tables; the page treats them as one list.
function toItems(reminders, tasks) {
  return [
    ...reminders.map((r) => ({
      key: `reminder-${r.id}`,
      kind: 'reminder',
      id: r.id,
      title: r.title,
      date: r.due_date,
      recurrence: r.recurrence,
      interval: r.recurrence_interval_days,
      completed_at: r.completed_at,
      category: r.category,
      lead_time_days: r.lead_time_days,
      notify_email: r.notify_email,
      equipment_id: r.equipment_id,
      equipment_name: r.equipment_name,
      notes: r.notes,
    })),
    ...tasks.map((t) => ({
      key: `task-${t.id}`,
      kind: 'task',
      id: t.id,
      title: t.title,
      date: t.event_date,
      recurrence: t.recurrence,
      interval: t.recurrence_interval_days,
      completed_at: t.completed_at,
      notes: t.notes,
    })),
  ].sort((a, b) => (a.date === b.date ? a.title.localeCompare(b.title) : a.date < b.date ? -1 : 1));
}

const emptyForm = (kind, date) => ({
  kind,
  title: '',
  date: date || todayStr(),
  category: 'maintenance',
  lead_time_days: 7,
  notify_email: true,
  equipment_id: '',
  recurrence: 'none',
  interval: 30,
  notes: '',
});

const formFromItem = (item) => ({
  kind: item.kind,
  title: item.title,
  date: item.date,
  category: item.category || 'maintenance',
  lead_time_days: item.lead_time_days ?? 7,
  notify_email: item.notify_email !== 0,
  equipment_id: item.equipment_id ? String(item.equipment_id) : '',
  recurrence: item.recurrence,
  interval: item.interval || 30,
  notes: item.notes || '',
});

function ItemForm({ initial, editing, equipment, onSave, onCancel }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const isReminder = form.kind === 'reminder';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(form);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      {!editing && (
        <div className="inline-flex rounded border overflow-hidden" role="group">
          {['reminder', 'task'].map((k) => (
            <button
              type="button"
              key={k}
              onClick={() => set({ kind: k })}
              aria-pressed={form.kind === k}
              className={`px-3 py-1.5 ${form.kind === k ? 'bg-brand-600 text-white' : 'bg-surface hover:bg-gray-50'}`}
            >
              {t(`calendar.type_${k}`)}
            </button>
          ))}
        </div>
      )}

      <div>
        <label className={label} htmlFor="cal-title">{t('calendar.title_label')}</label>
        <input id="cal-title" className={input} value={form.title} onChange={(e) => set({ title: e.target.value })} required />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label} htmlFor="cal-date">{t('calendar.date')}</label>
          <input id="cal-date" type="date" className={input} value={form.date} onChange={(e) => set({ date: e.target.value })} required />
        </div>
        {isReminder && (
          <div>
            <label className={label} htmlFor="cal-cat">{t('calendar.category')}</label>
            <select id="cal-cat" className={input} value={form.category} onChange={(e) => set({ category: e.target.value })}>
              {REMINDER_CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`reminder_category.${c}`)}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label} htmlFor="cal-rec">{t('calendar.recurrence')}</label>
          <select id="cal-rec" className={input} value={form.recurrence} onChange={(e) => set({ recurrence: e.target.value })}>
            {RECURRENCES.map((r) => (
              <option key={r} value={r}>{t(`recurrence.${r}`)}</option>
            ))}
          </select>
        </div>
        {form.recurrence === 'custom' && (
          <div>
            <label className={label} htmlFor="cal-int">{t('calendar.interval_days')}</label>
            <input
              id="cal-int"
              type="number"
              min="1"
              step="1"
              className={input}
              value={form.interval}
              onChange={(e) => set({ interval: e.target.value })}
              required
            />
          </div>
        )}
      </div>

      {isReminder && (
        <div className="grid grid-cols-2 gap-3 items-end">
          <div>
            <label className={label} htmlFor="cal-lead">{t('calendar.lead_time')}</label>
            <input
              id="cal-lead"
              type="number"
              min="0"
              max="365"
              step="1"
              className={input}
              value={form.lead_time_days}
              onChange={(e) => set({ lead_time_days: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" checked={form.notify_email} onChange={(e) => set({ notify_email: e.target.checked })} />
            {t('calendar.notify_email')}
          </label>
        </div>
      )}

      {isReminder && equipment.length > 0 && (
        <div>
          <label className={label} htmlFor="cal-eq">{t('calendar.equipment')}</label>
          <select id="cal-eq" className={input} value={form.equipment_id} onChange={(e) => set({ equipment_id: e.target.value })}>
            <option value="">—</option>
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className={label} htmlFor="cal-notes">{t('calendar.notes')}</label>
        <textarea id="cal-notes" rows={2} className={input} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
      </div>

      {error && <p role="alert" className="text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnSecondary} onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className={btnPrimary} disabled={busy}>{t('common.save')}</button>
      </div>
    </form>
  );
}

function ItemRow({ item, today, canEdit, onComplete, onReopen, onEdit, onDelete }) {
  const { t, i18n } = useTranslation();
  const done = !!item.completed_at;
  const overdue = !done && item.date < today;
  return (
    <li className="p-3 flex items-center gap-3 text-sm">
      <button
        onClick={() => (done ? onReopen(item) : onComplete(item))}
        aria-label={done ? t('calendar.reopen') : t('calendar.mark_done')}
        title={done ? t('calendar.reopen') : t('calendar.mark_done')}
        className={`w-6 h-6 shrink-0 rounded-full border flex items-center justify-center text-xs ${
          done ? 'bg-brand-600 border-brand-600 text-white' : 'border-gray-400 text-transparent hover:text-brand-600 hover:border-brand-600'
        }`}
      >
        ✓
      </button>
      <div className="min-w-0 flex-1">
        <p className={`font-medium truncate ${done ? 'line-through text-gray-400' : ''}`}>{item.title}</p>
        <p className="text-xs text-gray-500 flex flex-wrap items-center gap-x-2">
          <span className={overdue ? 'text-red-600 font-medium' : ''}>
            {formatDate(item.date, i18n.language)} · {relativeDays(item.date, i18n.language)}
          </span>
          <span className="px-1.5 rounded bg-gray-100">{t(`calendar.type_${item.kind}`)}</span>
          {item.equipment_name && (
            <Link to={`/equipment/${item.equipment_id}`} className="px-1.5 rounded bg-gray-100 hover:text-brand-700">
              🔧 {item.equipment_name}
            </Link>
          )}
          {item.recurrence !== 'none' && (
            <span title={t('calendar.recurrence')}>
              ↻ {t(`recurrence.${item.recurrence}`)}
              {item.recurrence === 'custom' ? ` (${item.interval} ${t('calendar.days')})` : ''}
            </span>
          )}
        </p>
        {item.notes && <p className="text-xs text-gray-400 truncate">{item.notes}</p>}
      </div>
      {canEdit && (
        <div className="flex gap-3 shrink-0 text-xs">
          <button onClick={() => onEdit(item)} className="text-brand-700 hover:underline">{t('common.edit')}</button>
          <button onClick={() => onDelete(item)} className="text-red-600 hover:underline">{t('common.delete')}</button>
        </div>
      )}
    </li>
  );
}

function Group({ title, tone, items, ...rowProps }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-4">
      <h3 className={`text-sm font-semibold mb-1 ${tone === 'danger' ? 'text-red-700' : 'text-gray-700'}`}>
        {title} <span className="text-gray-400 font-normal">({items.length})</span>
      </h3>
      <ul className="bg-surface rounded-lg shadow divide-y">
        {items.map((item) => (
          <ItemRow key={item.key} item={item} {...rowProps} />
        ))}
      </ul>
    </section>
  );
}

function ListView({ items, showCompleted, ...rowProps }) {
  const { t } = useTranslation();
  const today = todayStr();
  const soon = addDays(today, 30);
  const open = items.filter((i) => !i.completed_at);
  const groups = [
    [t('calendar.overdue'), 'danger', open.filter((i) => i.date < today)],
    [t('calendar.next_30'), 'default', open.filter((i) => i.date >= today && i.date <= soon)],
    [t('calendar.later'), 'default', open.filter((i) => i.date > soon)],
  ];
  const completed = showCompleted ? items.filter((i) => i.completed_at).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 50) : [];
  const nothing = open.length === 0 && completed.length === 0;

  return (
    <div>
      {nothing && <p className="text-sm text-gray-400 bg-surface rounded-lg shadow p-4">{t('calendar.nothing')}</p>}
      {groups.map(([title, tone, list]) => (
        <Group key={title} title={title} tone={tone} items={list} today={today} {...rowProps} />
      ))}
      <Group title={t('calendar.completed')} items={completed} today={today} {...rowProps} />
    </div>
  );
}

function MonthView({ items, showCompleted, cursor, setCursor, selected, setSelected, canEdit, onAdd, ...rowProps }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const today = todayStr();
  const weekStart = locale.startsWith('fr') ? 1 : 0;

  // 6 weeks starting on the locale's first weekday, covering the whole month.
  const first = new Date(cursor.y, cursor.m, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const cells = Array.from({ length: 42 }, (_, i) => toDateStr(new Date(cursor.y, cursor.m, 1 - lead + i)));
  const rangeFrom = cells[0];
  const rangeTo = cells[41];

  const byDate = useMemo(() => {
    const map = new Map();
    const push = (date, entry) => map.set(date, [...(map.get(date) || []), entry]);
    for (const item of items) {
      if (item.completed_at && !showCompleted) continue;
      if (item.date >= rangeFrom && item.date <= rangeTo) push(item.date, { item, projected: false });
      if (!item.completed_at) {
        for (const d of projectOccurrences(item.date, item.recurrence, item.interval, rangeFrom, rangeTo)) {
          push(d, { item, projected: true });
        }
      }
    }
    return map;
  }, [items, showCompleted, rangeFrom, rangeTo]);

  const names = weekdayLabels(locale);
  const weekdays = [...names.slice(weekStart), ...names.slice(0, weekStart)];
  const move = (delta) => {
    const d = new Date(cursor.y, cursor.m + delta, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };
  const goToday = () => {
    const d = new Date();
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
    setSelected(today);
  };

  const chipClass = ({ item, projected }) => {
    if (item.completed_at) return 'bg-gray-100 text-gray-400 line-through';
    if (projected) return 'border border-dashed border-brand-500 text-brand-700 bg-surface';
    if (item.date < today) return 'bg-red-100 text-red-700';
    return item.kind === 'reminder' ? 'bg-brand-100 text-brand-700' : 'bg-sky-100 text-sky-800';
  };
  const dotClass = (entry) => chipClass(entry).split(' ').filter((c) => c.startsWith('bg-') || c.startsWith('border')).join(' ');

  const selectedEntries = selected ? byDate.get(selected) || [] : [];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          <button className={btnSecondary} onClick={() => move(-1)} aria-label={t('calendar.prev_month')}>‹</button>
          <button className={btnSecondary} onClick={() => move(1)} aria-label={t('calendar.next_month')}>›</button>
          <button className={btnSecondary} onClick={goToday}>{t('calendar.today')}</button>
        </div>
        <h2 className="font-semibold capitalize" aria-live="polite">{monthLabel(cursor.y, cursor.m, locale)}</h2>
      </div>

      <div className="grid grid-cols-7 text-center text-[11px] text-gray-500 mb-1">
        {weekdays.map((w) => (
          <div key={w} className="uppercase tracking-wide">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-gray-200 border border-gray-200 rounded-lg overflow-hidden">
        {cells.map((date) => {
          const entries = byDate.get(date) || [];
          const inMonth = parseDate(date).getMonth() === cursor.m;
          const isToday = date === today;
          const isSelected = date === selected;
          return (
            <button
              key={date}
              onClick={() => setSelected(date)}
              aria-label={`${formatDate(date, locale)}${entries.length ? `, ${entries.length}` : ''}`}
              aria-pressed={isSelected}
              className={`min-h-[3.25rem] sm:min-h-[5.5rem] p-1 text-left align-top flex flex-col gap-0.5 ${
                inMonth ? 'bg-surface' : 'bg-gray-50 text-gray-400'
              } ${isSelected ? 'ring-2 ring-inset ring-brand-500' : 'hover:bg-brand-50'}`}
            >
              <span className={`text-xs w-5 h-5 flex items-center justify-center rounded-full ${isToday ? 'bg-brand-600 text-white' : ''}`}>
                {parseDate(date).getDate()}
              </span>
              {/* Phones: colored dots. Larger screens: titled chips. */}
              <span className="flex gap-0.5 flex-wrap sm:hidden">
                {entries.slice(0, 4).map((e, i) => (
                  <span key={i} className={`w-1.5 h-1.5 rounded-full ${dotClass(e)}`} />
                ))}
              </span>
              <span className="hidden sm:flex flex-col gap-0.5 min-w-0">
                {entries.slice(0, 2).map((e, i) => (
                  <span key={i} className={`text-[11px] leading-tight px-1 py-0.5 rounded truncate ${chipClass(e)}`}>
                    {e.item.title}
                  </span>
                ))}
                {entries.length > 2 && <span className="text-[10px] text-gray-500">{t('calendar.more', { count: entries.length - 2 })}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <section className="mt-4">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold">{formatDate(selected, locale)}</h3>
            {canEdit && (
              <button className="text-sm text-brand-700 hover:underline" onClick={() => onAdd(selected)}>
                + {t('calendar.add_on_day')}
              </button>
            )}
          </div>
          {selectedEntries.length === 0 ? (
            <p className="text-sm text-gray-400 bg-surface rounded-lg shadow p-3">{t('calendar.no_events_day')}</p>
          ) : (
            <ul className="bg-surface rounded-lg shadow divide-y">
              {selectedEntries.map(({ item, projected }) =>
                projected ? (
                  <li key={`${item.key}-p`} className="p-3 text-sm text-gray-500">
                    ↻ {item.title} <span className="text-xs">({t('calendar.upcoming_repeat')})</span>
                  </li>
                ) : (
                  <ItemRow key={item.key} item={item} today={today} canEdit={canEdit} {...rowProps} />
                )
              )}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

export default function Calendar() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { currentId, canEdit } = useProperties();
  const { data, error, reload } = useAsync(
    () => Promise.all([api.reminders.list(currentId), api.tasks.list(currentId)]),
    [currentId]
  );

  const { data: equipment } = useAsync(() => api.equipment.list(currentId), [currentId]);

  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem('calendarView') || 'list';
    } catch {
      return 'list';
    }
  });
  const [showCompleted, setShowCompleted] = useState(false);
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [selected, setSelected] = useState(todayStr());
  const [editor, setEditor] = useState(null); // { editing: item | null, initial }
  const [actionError, setActionError] = useState(null);

  const items = useMemo(() => (data ? toItems(data[0], data[1]) : []), [data]);

  const chooseView = (v) => {
    setView(v);
    try {
      localStorage.setItem('calendarView', v);
    } catch {
      /* storage unavailable */
    }
  };

  const run = async (fn) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError(err);
    }
  };

  const api_for = (item) => (item.kind === 'reminder' ? api.reminders : api.tasks);

  const onComplete = (item) => run(() => api_for(item).complete(item.id));
  const onReopen = (item) => run(() => api_for(item).reopen(item.id));
  const onDelete = async (item) => {
    const ok = await confirm({ message: t('calendar.delete_confirm', { title: item.title }), danger: true });
    if (ok) run(() => api_for(item).remove(item.id));
  };
  const onEdit = (item) => setEditor({ editing: item, initial: formFromItem(item) });
  const onAdd = (date) => setEditor({ editing: null, initial: emptyForm('reminder', date) });

  const save = async (form) => {
    const common = {
      title: form.title,
      recurrence: form.recurrence,
      recurrence_interval_days: form.recurrence === 'custom' ? Number(form.interval) : null,
      notes: form.notes,
    };
    const payload =
      form.kind === 'reminder'
        ? { ...common, due_date: form.date, category: form.category, lead_time_days: Number(form.lead_time_days), notify_email: form.notify_email, equipment_id: form.equipment_id || null }
        : { ...common, event_date: form.date };
    const target = form.kind === 'reminder' ? api.reminders : api.tasks;
    if (editor.editing) await target.update(editor.editing.id, payload);
    else await target.create({ ...payload, property_id: currentId });
    setEditor(null);
    await reload();
  };

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <p>{t('common.loading')}</p>;

  const rowProps = { canEdit, onComplete, onReopen, onEdit, onDelete };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="inline-flex rounded border overflow-hidden text-sm" role="group" aria-label={t('calendar.view')}>
          {['list', 'month'].map((v) => (
            <button
              key={v}
              onClick={() => chooseView(v)}
              aria-pressed={view === v}
              className={`px-3 py-1.5 ${view === v ? 'bg-brand-600 text-white' : 'bg-surface hover:bg-gray-50'}`}
            >
              {t(`calendar.view_${v}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1 text-gray-600">
            <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
            {t('calendar.show_completed')}
          </label>
          {canEdit && (
            <button className={btnPrimary} onClick={() => onAdd(view === 'month' ? selected : todayStr())}>
              + {t('calendar.add')}
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="mb-3">
          <ErrorBox error={actionError} />
        </div>
      )}

      {view === 'list' ? (
        <ListView items={items} showCompleted={showCompleted} {...rowProps} />
      ) : (
        <MonthView
          items={items}
          showCompleted={showCompleted}
          cursor={cursor}
          setCursor={setCursor}
          selected={selected}
          setSelected={setSelected}
          onAdd={onAdd}
          {...rowProps}
        />
      )}

      {editor && (
        <Modal
          title={
            editor.editing
              ? t(editor.editing.kind === 'reminder' ? 'calendar.edit_reminder' : 'calendar.edit_task')
              : t('calendar.add')
          }
          onClose={() => setEditor(null)}
        >
          <ItemForm initial={editor.initial} editing={!!editor.editing} equipment={equipment || []} onSave={save} onCancel={() => setEditor(null)} />
        </Modal>
      )}
    </div>
  );
}
