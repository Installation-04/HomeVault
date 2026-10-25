import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';

const MM_PER_IN = 25.4;

// Common thermal label sizes (Dymo/Brother/Rollo-style label printers,
// which register as ordinary OS printers — there's no special "thermal
// mode", just matching the paper size). "Standard" leaves @page alone and
// prints on whatever default page size the browser/printer uses.
const PRESETS = [
  { id: 'standard', wMm: null, hMm: null },
  { id: '25x25', wMm: 25, hMm: 25 },
  { id: '51x25', wMm: 51, hMm: 25 },
  { id: '102x152', wMm: 102, hMm: 152 },
  { id: 'custom', wMm: null, hMm: null },
];

function toMm(value, unit) {
  const n = Number(value) || 0;
  return unit === 'in' ? n * MM_PER_IN : n;
}

// Generated entirely client-side (no third-party API call) — fits the
// "no third-party analytics or telemetry, all data stays local" goal.
// `code` is a short identifier (e.g. "EQ-12") and `meta` extra label lines
// (brand/model, category, ...) shown alongside the QR — handy once this is
// printed and stuck on a physical item rather than viewed on screen.
export default function QrModal({ value, title, subtitle, code, meta = [], onClose }) {
  const { t } = useTranslation();
  const [sizeId, setSizeId] = useState(() => localStorage.getItem('qrLabelSize') || 'standard');
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  const [customUnit, setCustomUnit] = useState('mm');

  const selectSize = (id) => {
    setSizeId(id);
    localStorage.setItem('qrLabelSize', id);
  };

  let sizeMm = null;
  if (sizeId === 'custom') {
    if (customW && customH) sizeMm = { w: toMm(customW, customUnit), h: toMm(customH, customUnit) };
  } else {
    const preset = PRESETS.find((p) => p.id === sizeId);
    if (preset?.wMm) sizeMm = { w: preset.wMm, h: preset.hMm };
  }

  const qrSizePx = sizeMm ? Math.round(Math.min(sizeMm.w, sizeMm.h) * 3.2) : 192;

  return (
    <div className="qr-modal fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 print:bg-white" onClick={onClose}>
      <div
        className="bg-surface rounded-lg shadow-lg p-6 max-w-sm w-full text-center print:shadow-none print:p-0 print:rounded-none print:max-w-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-brand-700 mb-3 print:hidden">{title}</h3>

        {sizeMm && (
          <style>{`@media print { @page { size: ${sizeMm.w}mm ${sizeMm.h}mm; margin: 0; } }`}</style>
        )}

        {/* Label preview — sized in mm so it's a true-to-scale preview on
            screen too (browsers render physical units at ~96dpi), and
            matches the printed @page exactly. */}
        <div
          className={`force-light bg-white text-gray-900 mx-auto flex flex-col items-center justify-center gap-1 ${sizeMm ? '' : 'py-2'}`}
          style={sizeMm ? { width: `${sizeMm.w}mm`, height: `${sizeMm.h}mm`, padding: '1.5mm', boxSizing: 'border-box' } : undefined}
        >
          <QRCodeSVG value={value} size={qrSizePx} marginSize={1} />
          {(subtitle || code) && (
            <div className={sizeMm ? 'leading-tight' : 'mt-1'} style={sizeMm ? { fontSize: `${Math.max(Math.min(sizeMm.w, sizeMm.h) * 0.09, 1.8)}mm` } : undefined}>
              {subtitle && <p className="font-medium truncate max-w-full">{subtitle}</p>}
              {code && <p className="text-gray-500">{code}</p>}
              {meta
                .filter(Boolean)
                .map((line, i) => (
                  <p key={i} className="text-gray-500 truncate max-w-full">
                    {line}
                  </p>
                ))}
            </div>
          )}
        </div>

        <div className="print:hidden mt-4 space-y-3">
          <div className="text-left">
            <label className="block text-xs text-gray-500 mb-1">{t('qr.label_size')}</label>
            <select
              className="w-full border rounded px-2 py-1.5 text-sm"
              value={sizeId}
              onChange={(e) => selectSize(e.target.value)}
            >
              <option value="standard">{t('qr.size_standard')}</option>
              <option value="25x25">25 × 25 mm</option>
              <option value="51x25">51 × 25 mm (2 × 1 in)</option>
              <option value="102x152">102 × 152 mm (4 × 6 in)</option>
              <option value="custom">{t('qr.size_custom')}</option>
            </select>
            {sizeId === 'custom' && (
              <div className="flex gap-2 mt-2 items-center">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="border rounded px-2 py-1 text-sm w-16"
                  placeholder="W"
                  value={customW}
                  onChange={(e) => setCustomW(e.target.value)}
                />
                <span className="text-gray-400 text-sm">×</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="border rounded px-2 py-1 text-sm w-16"
                  placeholder="H"
                  value={customH}
                  onChange={(e) => setCustomH(e.target.value)}
                />
                <select
                  className="border rounded px-2 py-1 text-sm"
                  value={customUnit}
                  onChange={(e) => setCustomUnit(e.target.value)}
                >
                  <option value="mm">mm</option>
                  <option value="in">in</option>
                </select>
              </div>
            )}
            {sizeMm && <p className="text-xs text-gray-400 mt-1">{t('qr.thermal_hint')}</p>}
          </div>
          <div className="flex gap-2 justify-center">
            <button onClick={() => window.print()} className="text-sm px-3 py-1.5 rounded border hover:bg-gray-50">
              {t('qr.print')}
            </button>
            <button onClick={onClose} className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-hover">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
