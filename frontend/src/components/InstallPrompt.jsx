import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const DISMISS_KEY = 'installPromptDismissed';

function isIos() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// Surfaces a lightweight "install this app" banner. Android/desktop Chrome
// fires `beforeinstallprompt` and lets us trigger the native install flow
// directly; iOS Safari has no such API, so we instead show the manual
// Share -> Add to Home Screen instructions.
export default function InstallPrompt() {
  const { t } = useTranslation();
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  useEffect(() => {
    if (isStandalone() || dismissed) return;

    const onBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    if (isIos()) setShowIosHint(true);

    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, [dismissed]);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  const install = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    dismiss();
  };

  if (dismissed || (!deferredPrompt && !showIosHint)) return null;

  return (
    <div className="bg-brand-50 border-b border-brand-100 text-sm text-brand-900 px-4 py-2 flex items-center justify-between gap-3">
      <span>{deferredPrompt ? t('install.prompt') : t('install.ios_hint')}</span>
      <div className="flex items-center gap-3 shrink-0">
        {deferredPrompt && (
          <button onClick={install} className="font-medium text-brand-700 hover:underline">
            {t('install.action')}
          </button>
        )}
        <button onClick={dismiss} className="text-brand-400 hover:text-brand-700" aria-label={t('common.cancel')}>
          ✕
        </button>
      </div>
    </div>
  );
}
