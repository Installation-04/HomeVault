import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

const PropertyContext = createContext(null);

const readStoredId = () => {
  try {
    return localStorage.getItem('propertyId');
  } catch {
    return null;
  }
};

export function PropertyProvider({ children }) {
  const { user } = useAuth();
  const [properties, setProperties] = useState([]);
  const [currentId, setCurrentId] = useState(readStoredId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const selectProperty = useCallback((id) => {
    setCurrentId(String(id));
    try {
      localStorage.setItem('propertyId', String(id));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const list = await api.properties.list();
      setProperties(list);
      setError(null);
      // Self-heal: the remembered property may have been deleted or the
      // user's access revoked since last visit -- fall back to the first one.
      setCurrentId((prev) => {
        if (prev && list.some((p) => String(p.id) === String(prev))) return prev;
        return list.length ? String(list[0].id) : null;
      });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const current = properties.find((p) => String(p.id) === String(currentId)) || null;
  const canEdit = current?.role === 'owner';

  return (
    <PropertyContext.Provider value={{ properties, current, currentId: current ? String(current.id) : null, canEdit, selectProperty, refresh, loading, error }}>
      {children}
    </PropertyContext.Provider>
  );
}

export function useProperties() {
  return useContext(PropertyContext);
}
