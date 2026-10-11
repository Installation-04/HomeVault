import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext.jsx';
import QrModal from '../components/QrModal.jsx';

export default function Login() {
  const { t } = useTranslation();
  const { login, setup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [showInstallQr, setShowInstallQr] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (needsSetup) {
        await setup({ email, password, name });
      } else {
        await login(email, password);
      }
      navigate(location.state?.from?.pathname || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-gray-50 px-4"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="w-full max-w-sm bg-white p-6 rounded-lg shadow">
        <h1 className="text-xl font-bold text-brand-700 mb-1">HomeVault</h1>
        <p className="text-sm text-gray-500 mb-4">{needsSetup ? t('login.setup_title') : t('login.title')}</p>
        <form onSubmit={submit} className="space-y-3">
          {needsSetup && (
            <div>
              <label htmlFor="login-name" className="block text-sm mb-1">{t('login.name')}</label>
              <input
                id="login-name"
                className="w-full border rounded px-3 py-2"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
          )}
          <div>
            <label htmlFor="login-email" className="block text-sm mb-1">{t('login.email')}</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              className="w-full border rounded px-3 py-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="login-password" className="block text-sm mb-1">{t('login.password')}</label>
            <input
              id="login-password"
              type="password"
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              minLength={needsSetup ? 8 : undefined}
              className="w-full border rounded px-3 py-2"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {needsSetup && <p className="text-xs text-gray-400 mt-1">{t('settings.password_hint')}</p>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <button type="submit" className="w-full bg-brand-600 text-white rounded py-2 font-medium hover:bg-brand-700">
            {t('login.submit')}
          </button>
          <button
            type="button"
            className="w-full text-xs text-gray-400 hover:text-gray-600"
            onClick={() => setNeedsSetup((v) => !v)}
          >
            {needsSetup ? t('login.title') : t('login.setup_title')}
          </button>
        </form>

        {/* Desktop users setting this up can scan this with a phone to open
            the app there and install it as a PWA. */}
        <button
          type="button"
          onClick={() => setShowInstallQr(true)}
          className="w-full text-center text-xs text-brand-600 hover:underline mt-4"
        >
          {t('qr.install_link')}
        </button>
      </div>

      {showInstallQr && (
        <QrModal
          title={t('qr.install_title')}
          value={window.location.origin}
          subtitle={window.location.origin}
          onClose={() => setShowInstallQr(false)}
        />
      )}
    </div>
  );
}
