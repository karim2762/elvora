import { api } from './apiClient';
import { env } from '../config/env';

// Administrator access. Admins are not student accounts: they present the shared ADMIN_API_KEY in `X-Admin-Key`.
// The key is kept in sessionStorage only (gone when the tab closes) and is sent only to this app's own API.
const STORAGE = 'elvora.adminKey';
export const getAdminKey = () => { try { return sessionStorage.getItem(STORAGE) || ''; } catch { return ''; } };
export const setAdminKey = (key) => { try { if (key) sessionStorage.setItem(STORAGE, key); else sessionStorage.removeItem(STORAGE); } catch { /* storage blocked: the key just won't persist */ } };
const auth = (key = getAdminKey()) => ({ headers: { 'X-Admin-Key': key } });

export const verifyAdminKey = (key) => api.get('/admin/me', auth(key));
export function listApplications({ status = 'All', q = '', page = 1, pageSize = 10 } = {}) {
  const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status !== 'All') p.set('status', status);
  if (q) p.set('q', q);
  return api.get(`/admin/applications?${p}`, auth());
}
export const setApplicationStatus = (id, status) => api.patch(`/admin/applications/${encodeURIComponent(id)}/status`, { status }, auth());
export const listAdminInternships = () => api.get('/admin/internships', auth()).then((r) => r.internships);
export const createInternship = (applicationId, body) => api.post(`/admin/applications/${encodeURIComponent(applicationId)}/internship`, body, auth()).then((r) => r.internship);
export const setInternshipStatus = (id, body) => api.patch(`/admin/internships/${encodeURIComponent(id)}/status`, body, auth()).then((r) => r.internship);
export const sendAnnouncement = (body) => api.post('/admin/announcements', body, auth());

// The officially issued PDF is sent as the raw request body (see routes/admin.js).
export async function uploadDocument(internshipId, { type, title, file }) {
  const q = new URLSearchParams({ type });
  if (title) q.set('title', title);
  let res;
  try {
    res = await fetch(`${env.apiUrl}/admin/internships/${encodeURIComponent(internshipId)}/documents?${q}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/pdf', 'X-Admin-Key': getAdminKey() }, body: file,
    });
  } catch { throw Object.assign(new Error('Cannot reach the server. Check your connection and try again.'), { status: 0 }); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error?.fields?.file || data?.error?.message || res.statusText), { status: res.status, data });
  return data.document;
}

// Stage 07: certificate approvals + automation.
export const listCertificateApprovals = () => api.get('/admin/certificate-approvals', auth()).then((r) => r.internships);
export const decideCertificate = (id, body) => api.patch(`/admin/internships/${encodeURIComponent(id)}/certificate-decision`, body, auth()).then((r) => r.internship);
export const getAutomation = () => api.get('/admin/automation', auth()).then((r) => r.automation);
export const runAutomation = () => api.post('/admin/automation/run', {}, auth());

export const setInternshipProgress = (id, progressPercent) => api.patch(`/admin/internships/${encodeURIComponent(id)}/progress`, { progressPercent }, auth()).then((r) => r.internship);
