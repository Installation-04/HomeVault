const BASE = '/api';

function getToken() {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code; // 'network' when the server could not be reached
  }
}

// AuthContext registers this so an expired/revoked session is handled by the
// router (keeping the page the user was on) instead of a hard page reload.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// Endpoints where a 401 means "wrong credentials", not "session expired".
const CREDENTIAL_ENDPOINTS = ['/auth/login', '/auth/setup'];

async function request(path, { method = 'GET', body, isForm = false, raw = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Could not reach the server', { code: 'network' });
  }

  if (res.status === 401 && token && !CREDENTIAL_ENDPOINTS.includes(path)) {
    try {
      localStorage.removeItem('token');
    } catch {
      /* storage unavailable */
    }
    if (onUnauthorized) onUnauthorized();
    else window.location.href = '/login';
    throw new ApiError('Your session has expired', { status: 401, code: 'session' });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(err.error || 'Request failed', { status: res.status });
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

const qs = (params = {}) => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null));
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

// <a href> / <img src> can't send an Authorization header, so the few file
// endpoints the server allows it on accept the token as a query parameter.
const withToken = (url) => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken() || '')}`;

export const api = {
  setup: (data) => request('/auth/setup', { method: 'POST', body: data }),
  login: (data) => request('/auth/login', { method: 'POST', body: data }),
  me: () => request('/auth/me'),
  updateMe: (data) => request('/auth/me', { method: 'PATCH', body: data }),
  changePassword: (data) => request('/auth/password', { method: 'POST', body: data }),
  users: {
    list: () => request('/auth/users'),
    create: (data) => request('/auth/users', { method: 'POST', body: data }),
  },

  dashboard: () => request('/dashboard'),

  properties: {
    list: () => request('/properties'),
    get: (id) => request(`/properties/${id}`),
    create: (data) => request('/properties', { method: 'POST', body: data }),
    update: (id, data) => request(`/properties/${id}`, { method: 'PUT', body: data }),
    remove: (id) => request(`/properties/${id}`, { method: 'DELETE' }),
    share: (id, data) => request(`/properties/${id}/share`, { method: 'POST', body: data }),
    members: (id) => request(`/properties/${id}/members`),
    removeMember: (id, userId) => request(`/properties/${id}/members/${userId}`, { method: 'DELETE' }),
  },

  documents: {
    list: (propertyId, params) => request(`/documents/property/${propertyId}${qs(params)}`),
    get: (id) => request(`/documents/${id}`),
    upload: (formData) => request('/documents', { method: 'POST', body: formData, isForm: true }),
    update: (id, data) => request(`/documents/${id}`, { method: 'PUT', body: data }),
    remove: (id) => request(`/documents/${id}`, { method: 'DELETE' }),
    downloadUrl: (id) => withToken(`${BASE}/documents/${id}/download`),
  },

  equipment: {
    list: (propertyId) => request(`/equipment/property/${propertyId}`),
    get: (id) => request(`/equipment/${id}`),
    create: (data) => request('/equipment', { method: 'POST', body: data }),
    update: (id, data) => request(`/equipment/${id}`, { method: 'PUT', body: data }),
    remove: (id) => request(`/equipment/${id}`, { method: 'DELETE' }),
    uploadPhoto: (equipmentId, formData) =>
      request(`/equipment/${equipmentId}/photos`, { method: 'POST', body: formData, isForm: true }),
    removePhoto: (equipmentId, photoId) => request(`/equipment/${equipmentId}/photos/${photoId}`, { method: 'DELETE' }),
    photoUrl: (equipmentId, photoId) => withToken(`${BASE}/equipment/${equipmentId}/photos/${photoId}`),
    addMaintenance: (equipmentId, data) => request(`/equipment/${equipmentId}/maintenance`, { method: 'POST', body: data }),
    removeMaintenance: (equipmentId, logId) =>
      request(`/equipment/${equipmentId}/maintenance/${logId}`, { method: 'DELETE' }),
  },

  reminders: {
    list: (propertyId) => request(`/reminders/property/${propertyId}`),
    create: (data) => request('/reminders', { method: 'POST', body: data }),
    update: (id, data) => request(`/reminders/${id}`, { method: 'PUT', body: data }),
    complete: (id) => request(`/reminders/${id}/complete`, { method: 'POST' }),
    reopen: (id) => request(`/reminders/${id}/reopen`, { method: 'POST' }),
    remove: (id) => request(`/reminders/${id}`, { method: 'DELETE' }),
  },

  tasks: {
    list: (propertyId) => request(`/tasks/property/${propertyId}`),
    create: (data) => request('/tasks', { method: 'POST', body: data }),
    update: (id, data) => request(`/tasks/${id}`, { method: 'PUT', body: data }),
    complete: (id) => request(`/tasks/${id}/complete`, { method: 'POST' }),
    reopen: (id) => request(`/tasks/${id}/reopen`, { method: 'POST' }),
    remove: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
  },

  expenses: {
    list: (propertyId, params) => request(`/expenses/property/${propertyId}${qs(params)}`),
    years: (propertyId) => request(`/expenses/property/${propertyId}/years`),
    create: (data) => request('/expenses', { method: 'POST', body: data }),
    update: (id, data) => request(`/expenses/${id}`, { method: 'PUT', body: data }),
    remove: (id) => request(`/expenses/${id}`, { method: 'DELETE' }),
    exportCsvUrl: (propertyId, year) => withToken(`${BASE}/expenses/property/${propertyId}/export.csv${qs({ year })}`),
  },

  calendar: {
    list: (propertyId, params) => request(`/calendar/property/${propertyId}${qs(params)}`),
  },

  exportBundleUrl: (propertyId) => withToken(`${BASE}/export/property/${propertyId}/bundle.zip`),
};
