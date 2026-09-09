import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

const PropertyContext = createContext(null);

export function PropertyProvider({ children }) {
  const { user } = useAuth();
  const [properties, setProperties] = useState([]);
  const [currentId, setCurrentId] = useState(localStorage.getItem('propertyId') || null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) return;
    const list = await api.properties.list();
    setProperties(list);
    if (!currentId && list.length) {
      setCurrentId(String(list[0].id));
    }
    setLoading(false);
  }, [user, currentId]);

  useEffect(() => {
    refresh();
  }, [user]);

  const selectProperty = (id) => {
    setCurrentId(String(id));
    localStorage.setItem('propertyId', String(id));
  };

  const current = properties.find((p) => String(p.id) === String(currentId)) || null;

  return (
    <PropertyContext.Provider value={{ properties, current, currentId, selectProperty, refresh, loading }}>
      {children}
    </PropertyContext.Provider>
  );
}

export function useProperties() {
  return useContext(PropertyContext);
}
