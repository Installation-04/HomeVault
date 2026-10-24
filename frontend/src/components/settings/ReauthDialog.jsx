import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal.jsx';
import { btnDanger, btnPrimary, btnSecondary, input, label } from '../ui.js';

// Asks for the password again (and a current two-factor code unless `requireCode` is false),
// then calls onSubmit with the fields the API expects. Used for sensitive actions: turning
// two-factor authentication off, new recovery codes, installing a software update.
export default function ReauthDialog({ title, intro, confirmLabel, danger, requireCode = true, onSubmit, onClose }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit({ current_password: password, ...(requireCode ? (useRecovery ? { recovery_code: code } : { code }) : {}) });
    } catch (err) {
      setError(err.code === 'mfa_invalid' ? t('twofactor.code_invalid') : err.code === 'bad_current_password' ? t('settings.current_password_wrong') : err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 text-sm">
        {intro && <p className="text-gray-600">{intro}</p>}
        <div>
          <label className={label} htmlFor="ra-pw">{t('settings.current_password')}</label>
          <input id="ra-pw" type="password" autoComplete="current-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </div>
        {requireCode && (
          <div>
            <label className={label} htmlFor="ra-code">{useRecovery ? t('login.recovery_code') : t('login.mfa_code')}</label>
            <input id="ra-code" className={input} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            <button type="button" className="text-xs text-brand-700 hover:underline mt-1" onClick={() => { setUseRecovery((v) => !v); setCode(''); }}>
              {useRecovery ? t('login.use_app_code') : t('login.use_recovery')}
            </button>
          </div>
        )}
        {error && <p role="alert" className="text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnSecondary} onClick={onClose}>{t('common.cancel')}</button>
          <button className={danger ? btnDanger : btnPrimary} disabled={busy}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
