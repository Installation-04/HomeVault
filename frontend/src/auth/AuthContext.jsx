import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from '../api/client.js';
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

  // When any request comes back 401 (token expired, account removed) drop the
  // user; <Private> then redirects to /login and remembers where they were.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((u) => {
        setUser(u);
        applyAccountLocale(u);
      })
      .catch(() => localStorage.removeItem('token'))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const res = await api.login({ email, password });
    localStorage.setItem('token', res.token);
    setUser(res.user);
    applyAccountLocale(res.user);
    return res.user;
  };

  const setup = async (data) => {
    const res = await api.setup(data);
    localStorage.setItem('token', res.token);
    setUser(res.user);
    return res.user;
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  const updateProfile = useCallback(async (changes) => {
    const updated = await api.updateMe(changes);
    setUser(updated);
    return updated;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, setup, logout, updateProfile }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
