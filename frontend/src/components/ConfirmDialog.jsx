import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal.jsx';
import { btnDanger, btnPrimary, btnSecondary } from './ui.js';

const ConfirmContext = createContext(null);

// const confirm = useConfirm();  if (await confirm({ message, danger: true })) { ... }
export function ConfirmProvider({ children }) {
  const { t } = useTranslation();
  const [request, setRequest] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback(
    (options) =>
      new Promise((resolve) => {
        resolver.current = resolve;
        setRequest(options);
      }),
    []
  );

  const settle = (answer) => {
    resolver.current?.(answer);
    resolver.current = null;
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <Modal title={request.title || t('common.confirm')} onClose={() => settle(false)}>
          <p className="text-sm text-gray-700 whitespace-pre-line mb-4">{request.message}</p>
          <div className="flex justify-end gap-2">
            <button className={btnSecondary} onClick={() => settle(false)}>
              {t('common.cancel')}
            </button>
            <button className={request.danger ? btnDanger : btnPrimary} onClick={() => settle(true)}>
              {request.confirmLabel || (request.danger ? t('common.delete') : t('common.confirm'))}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmContext);
}
