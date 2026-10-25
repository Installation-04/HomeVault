import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Runs an async action and tracks busy / error / "saved" state for a form.
export function useAction() {
  const [state, setState] = useState({ busy: false, error: '', saved: false });
  useEffect(() => {
    if (!state.saved) return undefined;
    const id = setTimeout(() => setState((s) => ({ ...s, saved: false })), 2500);
    return () => clearTimeout(id);
  }, [state.saved]);
  const run = async (fn) => {
    setState({ busy: true, error: '', saved: false });
    try {
      const result = await fn();
      setState({ busy: false, error: '', saved: true });
      return result === undefined ? true : result;
    } catch (err) {
      setState({ busy: false, error: err.message, saved: false });
      return false;
    }
  };
  return [state, run];
}

export function Feedback({ state }) {
  const { t } = useTranslation();
  if (state.error) return <p role="alert" className="text-sm text-red-600">{state.error}</p>;
  if (state.saved) return <p role="status" className="text-sm text-emerald-700">✓ {t('common.saved')}</p>;
  return null;
}

export function CopyButton({ text, label }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (plain http): the text is selectable on screen */
    }
  };
  return (
    <button type="button" onClick={copy} className="text-xs px-2 py-1 rounded border bg-surface hover:bg-gray-50">
      {copied ? `✓ ${t('common.copied')}` : label || t('common.copy')}
    </button>
  );
}

export const Badge = ({ children, tone = 'gray' }) => {
  const tones = {
    gray: 'bg-gray-100 text-gray-700',
    brand: 'bg-brand-100 text-brand-700',
    green: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
  };
  return <span className={`text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap ${tones[tone]}`}>{children}</span>;
};
