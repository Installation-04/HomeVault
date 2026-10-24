import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setAuthHandlers } from '../api/client.js';
import i18n from '../i18n/index.js';

const AuthContext = createContext(null);

// A saved choice in this browser wins; otherwise follow the account's language.
function applyAccountLocale(user) {
  try {
    if (user?.locale && !localStorage.getItem('locale') && user.locale !== i18n.language) {
      i18n.changeLanguage(user.locale);
    }
  } catch {
    /* storage unavailable */
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // True after an explicit "Log out": signing back in then starts from the dashboard instead of the last page.
  const [signedOut, setSignedOut] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me);
      applyAccountLocale(me);
      return me;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  // When any request says the session is gone, drop the user; <Private> then
  // sends them to /login and remembers where they were. A pending forced
  // password change is picked up the same way.
  useEffect(() => {
    setAuthHandlers({
      onSessionExpired: () => setUser(null),
      onPasswordChangeRequired: () => refresh(),
    });
    return () => setAuthHandlers(null);
  }, [refresh]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    // Sessions used to be a token in localStorage; remove any left over from an older version.
    try {
      localStorage.removeItem('token');
    } catch {
      /* storage unavailable */
    }
  }, [refresh]);

  const value = useMemo(
    () => ({
      user,
      loading,
      signedOut,
      refresh,
      // Resolves to { user } when signed in, or { mfa: token } when a second step is required.
      async login(email, password) {
        const res = await api.login({ email, password });
        if (res.mfa_required) return { mfa: res.mfa_token };
        setSignedOut(false);
        setUser(res.user);
        applyAccountLocale(res.user);
        return { user: res.user };
      },
      async loginMfa(mfaToken, { code, recoveryCode }) {
        const res = await api.loginMfa({ mfa_token: mfaToken, code, recovery_code: recoveryCode });
        setSignedOut(false);
        setUser(res.user);
        applyAccountLocale(res.user);
        return res;
      },
      async setup(data) {
        const res = await api.setup(data);
        setUser(res.user);
        return res.user;
      },
      async logout() {
        try {
          await api.logout();
        } finally {
          setSignedOut(true);
          setUser(null);
        }
      },
      async updateProfile(changes) {
        const updated = await api.updateMe(changes);
        setUser(updated);
        return updated;
      },
    }),
    [user, loading, signedOut, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
