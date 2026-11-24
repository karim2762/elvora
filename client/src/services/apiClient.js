import { env } from '../config/env';

// Thin fetch wrapper. All backend calls go through here, so swapping the
// API host, adding auth headers, or changing error handling is a one-file change.
let authToken = null;
export const setAuthToken = (token) => { authToken = token; };

async function request(path, { method = 'GET', body, headers } = {}) {
  let res;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
    method,
    credentials: 'include', // session cookie (httpOnly); needed when the API is on another origin
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Cannot reach the server. Check your connection and try again.'), { status: 0 });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || res.statusText), { status: res.status, data });
  return data;
}

// Authenticated binary download (documents). The session cookie is sent, so the server checks ownership; the blob
// is then shown or saved locally. Errors are shaped like request() errors.
async function blob(path) {
  let res;
  try { res = await fetch(`${env.apiUrl}${path}`, { credentials: 'include' }); }
  catch { throw Object.assign(new Error('Cannot reach the server. Check your connection and try again.'), { status: 0 }); }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw Object.assign(new Error(data?.error?.message || res.statusText), { status: res.status, data });
  }
  return res.blob();
}

export const api = {
  blob,
  patch: (p, body, o) => request(p, { ...o, method: 'PATCH', body }),
  get: (p, o) => request(p, o),
  post: (p, body, o) => request(p, { ...o, method: 'POST', body }),
  put: (p, body, o) => request(p, { ...o, method: 'PUT', body }),
  del: (p, o) => request(p, { ...o, method: 'DELETE' }),
};
