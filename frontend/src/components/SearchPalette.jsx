import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useProperties } from '../property/PropertyContext.jsx';
import { useDebounced } from '../hooks/useDebounced.js';
import { formatDate } from '../utils/dates.js';
import { formatMoney } from '../utils/format.js';

const GROUPS = ['documents', 'equipment', 'reminders', 'tasks', 'expenses'];
const ICONS = { documents: '📄', equipment: '🔧', reminders: '🔔', tasks: '✅', expenses: '💰' };

// "Find anything": one box that searches documents, equipment, reminders,
// tasks and expenses across every property you can see. Ctrl/Cmd+K opens it.
export default function SearchPalette({ onClose }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { properties, selectProperty } = useProperties();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef(null);
  const q = useDebounced(query.trim(), 200);
  const multiProperty = properties.length > 1;
  const locale = i18n.language;

  useEffect(() => {
    if (q.length < 2) {
      setResults(null);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    api
      .search(q)
      .then((data) => !cancelled && (setResults(data), setError(null), setActive(0)))
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [q]);

  // One flat, ordered list so arrow keys move through every group.
  const flat = useMemo(() => {
    if (!results) return [];
    return GROUPS.flatMap((group) =>
      results[group].map((row) => {
        switch (group) {
          case 'documents':
            return { group, row, key: `d${row.id}`, title: row.title, sub: [t(`category.${row.category}`), row.expiry_date && t('documents.expires_on', { date: formatDate(row.expiry_date, locale) })], to: `/documents/${row.id}` };
          case 'equipment':
            return { group, row, key: `e${row.id}`, title: row.name, sub: [[row.brand, row.model_number].filter(Boolean).join(' '), row.location], to: `/equipment/${row.id}` };
          case 'reminders':
            return { group, row, key: `r${row.id}`, title: row.title, sub: [formatDate(row.due_date, locale), row.completed_at && t('search.done')], to: '/calendar' };
          case 'tasks':
            return { group, row, key: `t${row.id}`, title: row.title, sub: [formatDate(row.event_date, locale), row.completed_at && t('search.done')], to: '/calendar' };
          default:
            return { group, row, key: `x${row.id}`, title: `${t(`expense_category.${row.category}`, { defaultValue: row.category })} · ${formatMoney(row.amount, row.currency, locale)}`, sub: [formatDate(row.expense_date, locale), row.description], to: '/expenses' };
        }
      })
    );
  }, [results, t, locale]);

  const choose = (item) => {
    selectProperty(item.row.property_id);
    onClose();
    navigate(item.to);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length === 0) return;
      const next = (active + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
      setActive(next);
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && flat[active]) {
      e.preventDefault();
      choose(flat[active]);
    }
  };

  let lastGroup = null;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 sm:pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={t('search.title')} className="bg-white w-full max-w-xl rounded-lg shadow-xl overflow-hidden self-start" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 px-3 border-b">
          <span aria-hidden="true">🔍</span>
          <input
            autoFocus
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="search-results"
            aria-activedescendant={flat[active] ? `search-item-${active}` : undefined}
            className="flex-1 py-3 outline-none text-base"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck="false"
          />
          <kbd className="hidden sm:inline text-[10px] text-gray-400 border rounded px-1">Esc</kbd>
        </div>

        <div id="search-results" ref={listRef} role="listbox" className="max-h-[60vh] overflow-y-auto">
          {error && <p className="p-4 text-sm text-red-600">{error.code === 'network' ? t('error.network') : error.message}</p>}
          {!error && q.length < 2 && <p className="p-4 text-sm text-gray-400">{t('search.hint')}</p>}
          {!error && q.length >= 2 && !loading && results && flat.length === 0 && <p className="p-4 text-sm text-gray-400">{t('search.none', { query: q })}</p>}
          {flat.map((item, index) => {
            const header = item.group !== lastGroup;
            lastGroup = item.group;
            const property = properties.find((p) => p.id === item.row.property_id)?.name;
            return (
              <div key={item.key}>
                {header && <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-gray-400">{t(`search.group_${item.group}`)}</div>}
                <div
                  id={`search-item-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(item)}
                  className={`px-3 py-2 flex items-center gap-3 cursor-pointer ${index === active ? 'bg-brand-50' : ''}`}
                >
                  <span aria-hidden="true">{ICONS[item.group]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium truncate">{item.title}</span>
                    <span className="block text-xs text-gray-500 truncate">{item.sub.filter(Boolean).join(' · ')}</span>
                  </span>
                  {multiProperty && property && <span className="text-[11px] text-gray-400 shrink-0 max-w-[7rem] truncate">{property}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
