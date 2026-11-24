import { api } from './apiClient';

// Stage 10A Part 2 — administrator priority requests and free corrections. The server enforces the role, every transition and every rule.
const qs = (o) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '' && v !== 'All') p.set(k, String(v)); }); const s = p.toString(); return s ? `?${s}` : ''; };
const B = '/admin/priority-certificates'; const enc = encodeURIComponent;
export const listRequests = (p) => api.get(`${B}/requests${qs(p)}`);
export const getRequest = (id) => api.get(`${B}/requests/${enc(id)}`);
export const reviewRequest = (id) => api.post(`${B}/requests/${enc(id)}/review`, {});
export const setStatus = (id, body) => api.post(`${B}/requests/${enc(id)}/status`, body);
export const addNote = (id, note) => api.post(`${B}/requests/${enc(id)}/notes`, { note });
export const issueRequest = (id) => api.post(`${B}/requests/${enc(id)}/issue`, {});
export const listCorrections = (p) => api.get(`${B}/corrections${qs(p)}`);
export const getCorrection = (id) => api.get(`${B}/corrections/${enc(id)}`).then((r) => r.correction);
export const studentCertificates = (sid) => api.get(`${B}/corrections/students/${enc(sid)}/certificates`);
export const createCorrection = (body) => api.post(`${B}/corrections`, body).then((r) => r.correction);
export const approveCorrection = (id) => api.post(`${B}/corrections/${enc(id)}/approve`, {}).then((r) => r.correction);
export const cancelCorrection = (id, reason) => api.post(`${B}/corrections/${enc(id)}/cancel`, { reason }).then((r) => r.correction);
