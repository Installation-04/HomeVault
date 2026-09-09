import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext.jsx';

export default function Login() {
  const { t } = useTranslation();
  const { login, setup } = useAuth();
  const navigate = useNavigate();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (needsSetup) {
        await setup({ email, password, name });
      } else {
        await login(email, password);
      }
      navigate('/');
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
              <label className="block text-sm mb-1">{t('login.name')}</label>
              <input className="w-full border rounded px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          )}
          <div>
            <label className="block text-sm mb-1">{t('login.email')}</label>
            <input
              type="email"
              className="w-full border rounded px-3 py-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="block text-sm mb-1">{t('login.password')}</label>
            <input
              type="password"
              className="w-full border rounded px-3 py-2"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
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
      </div>
    </div>
  );
}
