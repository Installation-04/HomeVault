const BASE = '/api';

function getToken() {
  return localStorage.getItem('token');
}

async function request(path, { method = 'GET', body, isForm = false, raw = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  setup: (data) => request('/auth/setup', { method: 'POST', body: data }),
  login: (data) => request('/auth/login', { method: 'POST', body: data }),
  me: () => request('/auth/me'),

  dashboard: () => request('/dashboard'),

  properties: {
    list: () => request('/properties'),
    get: (id) => request(`/properties/${id}`),
    create: (data) => request('/properties', { method: 'POST', body: data }),
    update: (id, data) => request(`/properties/${id}`, { method: 'PUT', body: data }),
    remove: (id) => request(`/properties/${id}`, { method: 'DELETE' }),
    share: (id, data) => request(`/properties/${id}/share`, { method: 'POST', body: data }),
  },

  documents: {
    list: (propertyId, params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/documents/property/${propertyId}${qs ? `?${qs}` : ''}`);
    },
    upload: (formData) => request('/documents', { method: 'POST', body: formData, isForm: true }),
    update: (id, data) => request(`/documents/${id}`, { method: 'PUT', body: data }),
    remove: (id) => request(`/documents/${id}`, { method: 'DELETE' }),
    downloadUrl: (id) => `${BASE}/documents/${id}/download?token=${getToken()}`,
  },

  reminders: {
    list: (propertyId) => request(`/reminders/property/${propertyId}`),
    create: (data) => request('/reminders', { method: 'POST', body: data }),
    update: (id, data) => request(`/reminders/${id}`, { method: 'PUT', body: data }),
    complete: (id) => request(`/reminders/${id}/complete`, { method: 'POST' }),
    remove: (id) => request(`/reminders/${id}`, { method: 'DELETE' }),
  },

  tasks: {
    list: (propertyId) => request(`/tasks/property/${propertyId}`),
    create: (data) => request('/tasks', { method: 'POST', body: data }),
    update: (id, data) => request(`/tasks/${id}`, { method: 'PUT', body: data }),
    complete: (id) => request(`/tasks/${id}/complete`, { method: 'POST' }),
    remove: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
  },

  expenses: {
    list: (propertyId, params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/expenses/property/${propertyId}${qs ? `?${qs}` : ''}`);
    },
    create: (data) => request('/expenses', { method: 'POST', body: data }),
    update: (id, data) => request(`/expenses/${id}`, { method: 'PUT', body: data }),
    remove: (id) => request(`/expenses/${id}`, { method: 'DELETE' }),
    exportCsvUrl: (propertyId, year) => `${BASE}/expenses/property/${propertyId}/export.csv${year ? `?year=${year}` : ''}`,
  },

  calendar: {
    list: (propertyId, params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/calendar/property/${propertyId}${qs ? `?${qs}` : ''}`);
    },
  },

  exportBundleUrl: (propertyId) => `${BASE}/export/property/${propertyId}/bundle.zip?token=${getToken()}`,
};
