import { api } from './apiClient';
import { env } from '../config/env';

// Stage 07B — administrator internship + application management. Uses the signed-in administrator session (httpOnly cookie);
// the server re-checks the role on every call, so nothing here is a security boundary.
const qs = (o) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '' && v !== 'All') p.set(k, String(v)); }); const s = p.toString(); return s ? `?${s}` : ''; };
const enc = encodeURIComponent;

export const getListingOptions = () => api.get('/admin/internship-listings/options');
export const listListings = (params) => api.get(`/admin/internship-listings${qs(params)}`);
export const createListing = (body) => api.post('/admin/internship-listings', body).then((r) => r.internship);
export const updateListing = (id, body) => api.patch(`/admin/internship-listings/${enc(id)}`, body).then((r) => r.internship);
export const listingAction = (id, action) => api.patch(`/admin/internship-listings/${enc(id)}/state`, { action }).then((r) => r.internship);
export const deleteListing = (id) => api.del(`/admin/internship-listings/${enc(id)}`);

export const listAdminApplications = (params) => api.get(`/admin/applications${qs(params)}`);
export const getAdminApplication = (id) => api.get(`/admin/applications/${enc(id)}`).then((r) => r.application);
export const changeApplicationStatus = (id, status, note) => api.patch(`/admin/applications/${enc(id)}/status`, { status, ...(note ? { note } : {}) });
export const addApplicationNote = (id, note) => api.post(`/admin/applications/${enc(id)}/notes`, { note }).then((r) => r.note);

// Stage 07B (part 2) — students and internship lifecycle. Administrator session only; the server enforces it.
export const listAdminStudents = (params) => api.get(`/admin/students${qs(params)}`);
export const getAdminStudent = (id) => api.get(`/admin/students/${enc(id)}`);
export const setStudentStatus = (id, status, reason) => api.patch(`/admin/students/${enc(id)}/status`, { status, ...(reason ? { reason } : {}) });
export const getLifecycle = (id) => api.get(`/admin/internships/${enc(id)}/lifecycle`);
// action: activate | progress | suspend | cancel | complete
export const lifecycleAction = (id, action, body) => api.patch(`/admin/internships/${enc(id)}/${action}`, body ?? {}).then((r) => r.internship);

// Set start/end date (max 90 days back) and the assigned project. Body: { startDate, expectedEndDate?, assignedProject? }
export const setSchedule = (id, body) => api.patch(`/admin/internships/${enc(id)}/schedule`, body);
export const assignTasks = (id) => api.post(`/admin/internships/${enc(id)}/tasks/assign`, {});

// Stage 07C (part 1) — documents. Issuing and revoking are enforced by the server (eligibility, mandatory reason, audit); nothing here is a security boundary.
export const listAdminDocuments = (params) => api.get(`/admin/documents${qs(params)}`);
export const getAdminDocument = (id) => api.get(`/admin/documents/${enc(id)}`).then((r) => r.document);
export const verifyAdminDocument = (id) => api.get(`/admin/documents/${enc(id)}/verify`).then((r) => r.verification);
export const getDocumentHistory = (id) => api.get(`/admin/documents/${enc(id)}/history`);
export const revokeAdminDocument = (id, reason) => api.patch(`/admin/documents/${enc(id)}/revoke`, { reason }).then((r) => r.document);
export const documentFileUrl = (id) => `${env.apiUrl}/admin/documents/${enc(id)}/file`;

// Stage 07C — announcements, audit log, settings. Administrator session only; the server enforces it.
export const listAnnouncements = (params) => api.get(`/admin/announcements${qs(params)}`);
export const previewAnnouncement = (body) => api.post('/admin/announcements/preview', body);
export const sendAnnouncement = (body) => api.post('/admin/announcements', body); // body includes confirm:true + confirmRecipientCount
export const withdrawAnnouncement = (id, reason) => api.patch(`/admin/announcements/${enc(id)}/withdraw`, { reason }).then((r) => r.announcement);
export const listAuditLogs = (params) => api.get(`/admin/audit-logs${qs(params)}`);
export const getSettings = () => api.get('/admin/settings').then((r) => r.settings);
export const updateSettings = (body) => api.patch('/admin/settings', body).then((r) => r.settings);
export const removeLogo = () => api.del('/admin/settings/logo').then((r) => r.settings);
export async function uploadLogo(file) {
  let res;
  try { res = await fetch(`${env.apiUrl}/admin/settings/logo`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': file.type }, body: file }); }
  catch { throw Object.assign(new Error('Cannot reach the server. Check your connection and try again.'), { status: 0 }); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || res.statusText), { status: res.status, data });
  return data.settings;
}

// Issue through the Stage 06 generator. The server checks eligibility (approved application / verified completion), blocks duplicates and audits it.
export const listInternshipsForIssue = () => api.get('/admin/internships').then((r) => r.internships);
export const issueAdminDocument = (type, internshipId) => api.post(`/admin/documents/${type === 'certificate' ? 'certificate' : 'offer-letter'}`, { internshipId }).then((r) => r.document);

// Approving a certificate is its own recorded decision on the server; the Documents page does it first when an administrator issues one by hand.
export const approveCertificate = (internshipId) => api.patch(`/admin/internships/${enc(internshipId)}/certificate-decision`, { decision: 'Approved', note: 'Approved when issued from Documents' });

// Stage 09B — task library (templates). Reads accept the console session; the state change needs a signed-in administrator, enforced by the server.
export const getTaskLibraryOptions = () => api.get('/admin/task-templates/options');
export const listTaskTemplates = (params) => api.get(`/admin/task-templates${qs(params)}`);
export const setTaskTemplateState = (id, action) => api.patch(`/admin/task-templates/${enc(id)}/state`, { action }).then((r) => r.template);

// Stage 09B Part 2B — project submissions and their evaluation. Administrator session only; the server enforces it and re-validates every score and decision.
export const getProjectOptions = () => api.get('/admin/projects/options');
export const listProjects = (params) => api.get(`/admin/projects${qs(params)}`);
export const getProject = (id) => api.get(`/admin/projects/${enc(id)}`);
export const startProjectReview = (id) => api.post(`/admin/projects/${enc(id)}/start-review`, {});
export const saveProjectDraft = (id, body) => api.put(`/admin/projects/${enc(id)}/evaluation`, body);
export const decideProject = (id, body) => api.post(`/admin/projects/${enc(id)}/decision`, { ...body, confirm: true });

// Stage 09C Part 2A — repository evidence and internal notes for one project. Refresh and notes need an administrator session (server-enforced).
export const getProjectEvidence = (id) => api.get(`/admin/projects/${enc(id)}/github`);
export const refreshProjectEvidence = (id) => api.post(`/admin/projects/${enc(id)}/github/refresh`, {});
export const addProjectNote = (id, note) => api.post(`/admin/projects/${enc(id)}/notes`, { note });
