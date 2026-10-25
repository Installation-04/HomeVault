const BASE = '/api';

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', retryAfter = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code; // machine-readable: 'network', 'session', 'rate_limited', 'mfa_invalid', ...
    this.retryAfter = retryAfter;
  }
}

// The session lives in an HttpOnly cookie the browser attaches by itself: there
// is no token in JavaScript, in localStorage or in any URL for a script (or a
// log file) to leak. AuthContext registers these so an expired session or a
// pending forced password change is handled by the router, not a page reload.
let handlers = {};
export function setAuthHandlers(next) {
  handlers = next || {};
}

async function request(path, { method = 'GET', body, isForm = false, raw = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Could not reach the server', { code: 'network' });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const code = err.code || '';
    // Only a *session* 401 means "signed out"; a 401 from the login form is just wrong credentials.
    if (res.status === 401 && code === 'unauthenticated') {
      handlers.onSessionExpired?.();
      throw new ApiError('Your session has expired', { status: 401, code: 'session' });
    }
    if (res.status === 403 && code === 'password_change_required') handlers.onPasswordChangeRequired?.();
    throw new ApiError(err.error || 'Request failed', {
      status: res.status,
      code,
      retryAfter: Number(res.headers.get('Retry-After')) || err.retry_after || 0,
    });
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

export const api = {
  authStatus: () => request('/auth/status'),
  setup: (data) => request('/auth/setup', { method: 'POST', body: data }),
  login: (data) => request('/auth/login', { method: 'POST', body: data }),
  loginMfa: (data) => request('/auth/login/mfa', { method: 'POST', body: data }),
  logout: () => request('/auth/logout', { method: 'POST', body: {} }),
  me: () => request('/auth/me'),
  updateMe: (data) => request('/auth/me', { method: 'PATCH', body: data }),
  changePassword: (data) => request('/auth/password', { method: 'POST', body: data }),
  sessions: {
    list: () => request('/auth/sessions'),
    revoke: (id) => request(`/auth/sessions/${id}`, { method: 'DELETE' }),
    revokeOthers: () => request('/auth/sessions', { method: 'DELETE' }),
  },
  activity: (limit = 30) => request(`/auth/activity${qs({ limit })}`),
  twoFactor: {
    status: () => request('/auth/2fa/status'),
    setup: (data) => request('/auth/2fa/setup', { method: 'POST', body: data }),
    enable: (data) => request('/auth/2fa/enable', { method: 'POST', body: data }),
    disable: (data) => request('/auth/2fa/disable', { method: 'POST', body: data }),
    recoveryCodes: (data) => request('/auth/2fa/recovery-codes', { method: 'POST', body: data }),
  },
  users: {
    list: () => request('/auth/users'),
    create: (data) => request('/auth/users', { method: 'POST', body: data }),
    update: (id, data) => request(`/auth/users/${id}`, { method: 'PATCH', body: data }),
    resetPassword: (id, data = {}) => request(`/auth/users/${id}/reset-password`, { method: 'POST', body: data }),
    resetTwoFactor: (id) => request(`/auth/users/${id}/reset-2fa`, { method: 'POST', body: {} }),
    remove: (id) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  },
  admin: {
    audit: (params) => request(`/admin/audit${qs(params)}`),
    backupUrl: () => `${BASE}/admin/backup`,
    update: ({ refresh = false } = {}) => request(`/admin/update${refresh ? '?refresh=1' : ''}`),
    applyUpdate: (data) => request('/admin/update/apply', { method: 'POST', body: data }),
  },
  about: () => request('/about'),

  dashboard: () => request('/dashboard'),
  search: (q) => request(`/search${qs({ q })}`),

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

  // Downloads and <img> sources are plain URLs: the browser sends the cookie.
  documents: {
    list: (propertyId, params) => request(`/documents/property/${propertyId}${qs(params)}`),
    get: (id) => request(`/documents/${id}`),
    upload: (formData) => request('/documents', { method: 'POST', body: formData, isForm: true }),
    update: (id, data) => request(`/documents/${id}`, { method: 'PUT', body: data }),
    remove: (id) => request(`/documents/${id}`, { method: 'DELETE' }),
    downloadUrl: (id) => `${BASE}/documents/${id}/download`,
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
    photoUrl: (equipmentId, photoId) => `${BASE}/equipment/${equipmentId}/photos/${photoId}`,
    addMaintenance: (equipmentId, data) => request(`/equipment/${equipmentId}/maintenance`, { method: 'POST', body: data }),
    removeMaintenance: (equipmentId, logId) =>
      request(`/equipment/${equipmentId}/maintenance/${logId}`, { method: 'DELETE' }),
    exportCsvUrl: (propertyId) => `${BASE}/equipment/property/${propertyId}/export.csv`,
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
    exportCsvUrl: (propertyId, year) => `${BASE}/expenses/property/${propertyId}/export.csv${qs({ year })}`,
  },

  integrations: {
    list: (propertyId) => request(`/integrations/property/${propertyId}`),
    create: (data) => request('/integrations', { method: 'POST', body: data }),
    sync: (id) => request(`/integrations/${id}/sync`, { method: 'POST', body: {} }),
    update: (id, data) => request(`/integrations/${id}`, { method: 'PATCH', body: data }),
    remove: (id) => request(`/integrations/${id}`, { method: 'DELETE' }),
  },

  calendar: {
    list: (propertyId, params) => request(`/calendar/property/${propertyId}${qs(params)}`),
    feeds: {
      list: () => request('/calendar/feeds'),
      create: (data) => request('/calendar/feeds', { method: 'POST', body: data }),
      remove: (id) => request(`/calendar/feeds/${id}`, { method: 'DELETE' }),
    },
  },

  exportBundleUrl: (propertyId) => `${BASE}/export/property/${propertyId}/bundle.zip`,
};
