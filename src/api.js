const useMockApi = import.meta.env.VITE_USE_MOCK_API === 'true' || import.meta.env.DEV;

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: options.body instanceof FormData ? options.headers : { 'content-type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

export const api = {
  isMock: useMockApi,
  session() {
    if (useMockApi) return Promise.resolve(JSON.parse(sessionStorage.getItem('medembed_mock_session') || 'null'));
    return request('/api/auth/session');
  },
  login(password) {
    if (useMockApi) {
      if (!password.trim()) return Promise.reject(new Error('กรุณากรอกรหัสผ่าน'));
      const session = { authenticated: true, user: { name: 'พญ. อุรารี' } };
      sessionStorage.setItem('medembed_mock_session', JSON.stringify(session));
      return Promise.resolve(session);
    }
    return request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
  },
  logout() {
    if (useMockApi) {
      sessionStorage.removeItem('medembed_mock_session');
      return Promise.resolve();
    }
    return request('/api/auth/logout', { method: 'POST' });
  },
  jobs() {
    return request('/api/jobs');
  },
  upload(files, collection, documentType, mode) {
    const body = new FormData();
    files.forEach(file => body.append('files', file));
    body.append('collection', collection);
    body.append('document_type', documentType);
    body.append('mode', mode);
    return request('/api/upload', { method: 'POST', body });
  },
  query(query, collection) {
    return request('/api/query', { method: 'POST', body: JSON.stringify({ query, collection, limit: 5 }) });
  },
  deletePoint(collection, id) {
    if (useMockApi) return Promise.resolve({ ok: true });
    return request(`/api/points/${collection}/${id}`, { method: 'DELETE' });
  },
};
