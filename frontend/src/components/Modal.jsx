import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// Accessible-enough modal: Escape and backdrop click close it, focus moves
// into it on open and back to the opener on close.
export default function Modal({ title, onClose, children, wide = false }) {
  const { t } = useTranslation();
  const panel = useRef(null);

  // Callers pass a fresh inline function every render. Keep the latest one in
  // a ref so the effect below runs exactly once per open -- otherwise every
  // parent re-render would yank focus back to the first field mid-typing.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    const first = panel.current?.querySelector('input:not([type=hidden]), select, textarea, button:not([data-modal-close])');
    first?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-surface w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} rounded-t-xl sm:rounded-lg shadow-xl max-h-[90vh] overflow-y-auto`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b sticky top-0 bg-surface">
          <h2 className="font-semibold">{title}</h2>
          <button data-modal-close onClick={() => closeRef.current()} className="text-gray-500 hover:text-gray-800 text-xl leading-none" aria-label={t('common.close')}>
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
