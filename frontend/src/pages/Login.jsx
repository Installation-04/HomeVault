import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import QrModal from '../components/QrModal.jsx';
import { btnPrimary, input, label } from '../components/ui.js';

// Sign-in, first-run setup (only while the instance has no accounts) and the
// second step for accounts with two-factor authentication.
export default function Login() {
  const { t } = useTranslation();
  const { user, login, loginMfa, setup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [status, setStatus] = useState(null); // { needs_setup, setup_token_required }
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [mfaToken, setMfaToken] = useState(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showInstallQr, setShowInstallQr] = useState(false);

  useEffect(() => {
    api.authStatus().then(setStatus).catch(() => setStatus({ needs_setup: false, setup_token_required: false }));
  }, []);

  const destination = location.state?.from?.pathname || '/';
  if (user) return <Navigate to={destination} replace />;

  const explain = (err) => {
    if (err.code === 'rate_limited') {
      const minutes = Math.max(1, Math.ceil((err.retryAfter || 60) / 60));
      return t('login.rate_limited', { count: minutes });
    }
    if (err.code === 'invalid_credentials') return t('login.invalid_credentials');
    if (err.code === 'mfa_invalid') return t('login.mfa_invalid');
    if (err.code === 'mfa_expired') return t('login.mfa_expired');
    if (err.code === 'setup_token') return t('login.setup_token_wrong');
    if (err.code === 'network') return t('error.network');
    return err.message;
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mfaToken) {
        await loginMfa(mfaToken, useRecovery ? { recoveryCode: code } : { code });
        navigate(destination, { replace: true });
      } else if (status?.needs_setup) {
        await setup({ email, password, name, setup_token: setupToken || undefined });
        navigate(destination, { replace: true });
      } else {
        const result = await login(email, password);
        if (result.mfa) {
          setMfaToken(result.mfa);
          setPassword('');
        } else {
          navigate(destination, { replace: true });
        }
      }
    } catch (err) {
      setError(explain(err));
      if (err.code === 'mfa_expired') {
        setMfaToken(null);
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  const needsSetup = status?.needs_setup;
  const title = mfaToken ? t('login.mfa_title') : needsSetup ? t('login.setup_title') : t('login.title');

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-gray-50 px-4"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="w-full max-w-sm bg-surface p-6 rounded-lg shadow">
        <h1 className="text-xl font-bold text-brand-700 mb-1">HomeVault</h1>
        <p className="text-sm text-gray-500 mb-4">{title}</p>

        {!status ? (
          <p className="text-sm text-gray-400">{t('common.loading')}</p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {mfaToken ? (
              <div>
                <label htmlFor="login-code" className={label}>
                  {useRecovery ? t('login.recovery_code') : t('login.mfa_code')}
                </label>
                <input
                  id="login-code"
                  className={`${input} ${useRecovery ? '' : 'tracking-widest text-center text-lg'}`}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  maxLength={useRecovery ? 20 : 7}
                  placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'}
                  autoFocus
                  required
                />
                <p className="text-xs text-gray-400 mt-1">{useRecovery ? t('login.recovery_hint') : t('login.mfa_hint')}</p>
              </div>
            ) : (
              <>
                {needsSetup && (
                  <div>
                    <label htmlFor="login-name" className={label}>{t('login.name')}</label>
                    <input id="login-name" className={input} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
                  </div>
                )}
                <div>
                  <label htmlFor="login-email" className={label}>{t('login.email')}</label>
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    className={input}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <label htmlFor="login-password" className={label}>{t('login.password')}</label>
                  <input
                    id="login-password"
                    type="password"
                    autoComplete={needsSetup ? 'new-password' : 'current-password'}
                    minLength={needsSetup ? 10 : undefined}
                    className={input}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  {needsSetup && <p className="text-xs text-gray-400 mt-1">{t('settings.password_hint')}</p>}
                </div>
                {needsSetup && status.setup_token_required && (
                  <div>
                    <label htmlFor="login-setup-token" className={label}>{t('login.setup_token')}</label>
                    <input
                      id="login-setup-token"
                      className={input}
                      value={setupToken}
                      onChange={(e) => setSetupToken(e.target.value)}
                      autoComplete="off"
                      spellCheck="false"
                      required
                    />
                    <p className="text-xs text-gray-400 mt-1">{t('login.setup_token_hint')}</p>
                  </div>
                )}
              </>
            )}

            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className={`${btnPrimary} w-full py-2`}>
              {mfaToken ? t('login.verify') : needsSetup ? t('login.create_account') : t('login.submit')}
            </button>

            {mfaToken && (
              <div className="flex justify-between text-xs">
                <button
                  type="button"
                  className="text-brand-700 hover:underline"
                  onClick={() => {
                    setUseRecovery((v) => !v);
                    setCode('');
                    setError('');
                  }}
                >
                  {useRecovery ? t('login.use_app_code') : t('login.use_recovery')}
                </button>
                <button
                  type="button"
                  className="text-gray-500 hover:underline"
                  onClick={() => {
                    setMfaToken(null);
                    setCode('');
                    setError('');
                  }}
                >
                  {t('common.back')}
                </button>
              </div>
            )}
          </form>
        )}

        {/* Desktop users setting this up can scan this with a phone to open
            the app there and install it as a PWA. */}
        {!mfaToken && (
          <button type="button" onClick={() => setShowInstallQr(true)} className="w-full text-center text-xs text-brand-600 hover:underline mt-4">
            {t('qr.install_link')}
          </button>
        )}
      </div>

      {showInstallQr && (
        <QrModal title={t('qr.install_title')} value={window.location.origin} subtitle={window.location.origin} onClose={() => setShowInstallQr(false)} />
      )}
    </div>
  );
}
