import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { formatDate } from '../../utils/dates.js';
import ErrorBox from '../ErrorBox.jsx';
import Modal from '../Modal.jsx';
import ReauthDialog from './ReauthDialog.jsx';
import { btnDanger, btnPrimary, btnSecondary, card, input, label } from '../ui.js';
import { Badge, CopyButton } from './shared.jsx';

const groupSecret = (secret) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

function RecoveryCodes({ codes, onDone }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`HomeVault recovery codes\n(each works once)\n\n${text}\n`], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'homevault-recovery-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-gray-700">{t('twofactor.recovery_intro')}</p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-base bg-gray-50 rounded p-3 select-all">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <CopyButton text={text} />
        <button type="button" onClick={download} className="text-xs px-2 py-1 rounded border bg-white hover:bg-gray-50">
          {t('twofactor.download')}
        </button>
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {t('twofactor.saved_confirm')}
      </label>
      <div className="flex justify-end">
        <button className={btnPrimary} disabled={!saved} onClick={onDone}>
          {t('common.done')}
        </button>
      </div>
    </div>
  );
}

// Step-by-step: confirm password -> scan QR -> enter a code -> keep recovery codes.
function EnableFlow({ onClose, onEnabled }) {
  const { t } = useTranslation();
  const [step, setStep] = useState('password');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const attempt = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.code === 'mfa_invalid' ? t('twofactor.code_invalid') : err.code === 'bad_current_password' ? t('settings.current_password_wrong') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('twofactor.enable_title')} onClose={codes ? () => {} : onClose}>
      {step === 'password' && (
        <form
          className="space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            attempt(async () => {
              setSetup(await api.twoFactor.setup({ current_password: password }));
              setPassword('');
              setStep('scan');
            });
          }}
        >
          <p className="text-gray-700">{t('twofactor.intro')}</p>
          <div>
            <label className={label} htmlFor="tf-pw">{t('settings.current_password')}</label>
            <input id="tf-pw" type="password" autoComplete="current-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p role="alert" className="text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnSecondary} onClick={onClose}>{t('common.cancel')}</button>
            <button className={btnPrimary} disabled={busy}>{t('common.continue')}</button>
          </div>
        </form>
      )}

      {step === 'scan' && setup && (
        <form
          className="space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            attempt(async () => {
              const res = await api.twoFactor.enable({ code });
              setCodes(res.recovery_codes);
              setStep('codes');
            });
          }}
        >
          <p className="text-gray-700">{t('twofactor.scan')}</p>
          <div className="flex justify-center bg-white p-3 border rounded">
            {/* Generated in the browser: the secret is never sent to a QR-code service. */}
            <QRCodeSVG value={setup.otpauth_url} size={176} level="M" role="img" aria-label={t('twofactor.qr_label')} />
          </div>
          <details className="text-xs text-gray-600">
            <summary className="cursor-pointer">{t('twofactor.cant_scan')}</summary>
            <p className="mt-2">{t('twofactor.manual_key')}</p>
            <p className="font-mono text-sm select-all break-all my-1">{groupSecret(setup.secret)}</p>
            <CopyButton text={setup.secret} />
          </details>
          <div>
            <label className={label} htmlFor="tf-code">{t('twofactor.enter_code')}</label>
            <input id="tf-code" className={`${input} tracking-widest text-center text-lg`} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </div>
          {error && <p role="alert" className="text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnSecondary} onClick={onClose}>{t('common.cancel')}</button>
            <button className={btnPrimary} disabled={busy}>{t('twofactor.turn_on')}</button>
          </div>
        </form>
      )}

      {step === 'codes' && codes && (
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            onEnabled();
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

// `onChanged` lets the page refresh the device list and activity: turning 2FA on or off signs out other devices.
export default function TwoFactorSection({ onChanged }) {
  const { t, i18n } = useTranslation();
  const { data: status, error, reload } = useAsync(() => api.twoFactor.status(), []);
  const [dialog, setDialog] = useState(null); // 'enable' | 'disable' | 'regenerate'
  const [newCodes, setNewCodes] = useState(null);

  const close = () => setDialog(null);
  const changed = () => {
    reload();
    onChanged?.();
  };
  const low = status?.enabled && status.recovery_codes_remaining <= 3;

  return (
    <section className={card}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            {t('twofactor.title')} {status && <Badge tone={status.enabled ? 'green' : 'gray'}>{status.enabled ? t('twofactor.on') : t('twofactor.off')}</Badge>}
          </h2>
          <p className="text-xs text-gray-500 mt-1">{t('twofactor.summary')}</p>
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />

      {status && !status.enabled && (
        <div className="mt-3">
          <button className={btnPrimary} onClick={() => setDialog('enable')}>{t('twofactor.enable')}</button>
        </div>
      )}

      {status?.enabled && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-gray-600">{t('twofactor.since', { date: formatDate((status.enabled_at || '').slice(0, 10), i18n.language) })}</p>
          <p className={low ? 'text-amber-700' : 'text-gray-600'}>
            {low && '⚠ '}
            {t('twofactor.codes_left', { count: status.recovery_codes_remaining })}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button className={btnSecondary} onClick={() => setDialog('regenerate')}>{t('twofactor.regenerate')}</button>
            <button className={btnDanger} onClick={() => setDialog('disable')}>{t('twofactor.disable')}</button>
          </div>
        </div>
      )}

      {dialog === 'enable' && <EnableFlow onClose={close} onEnabled={changed} />}
      {dialog === 'disable' && (
        <ReauthDialog
          title={t('twofactor.disable')}
          confirmLabel={t('twofactor.disable')}
          danger
          onClose={close}
          onSubmit={async (data) => {
            await api.twoFactor.disable(data);
            close();
            changed();
          }}
        />
      )}
      {dialog === 'regenerate' && (
        <ReauthDialog
          title={t('twofactor.regenerate')}
          confirmLabel={t('twofactor.regenerate')}
          onClose={close}
          onSubmit={async (data) => {
            const res = await api.twoFactor.recoveryCodes(data);
            close();
            setNewCodes(res.recovery_codes);
            onChanged?.();
          }}
        />
      )}
      {newCodes && (
        <Modal title={t('twofactor.new_codes_title')} onClose={() => {}}>
          <RecoveryCodes
            codes={newCodes}
            onDone={() => {
              setNewCodes(null);
              reload();
            }}
          />
        </Modal>
      )}
    </section>
  );
}
