import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';

// Generated entirely client-side (no third-party API call) — fits the
// "no third-party analytics or telemetry, all data stays local" goal.
export default function QrModal({ value, title, subtitle, onClose }) {
  const { t } = useTranslation();

  return (
    <div className="qr-modal fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 print:bg-white" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-lg p-6 max-w-xs w-full text-center print:shadow-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-brand-700 mb-1">{title}</h3>
        {subtitle && <p className="text-xs text-gray-500 mb-3 break-words">{subtitle}</p>}
        <div className="flex justify-center py-2">
          <QRCodeSVG value={value} size={192} marginSize={2} />
        </div>
        <div className="flex gap-2 justify-center mt-4 print:hidden">
          <button onClick={() => window.print()} className="text-sm px-3 py-1.5 rounded border hover:bg-gray-50">
            {t('qr.print')}
          </button>
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700">
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
