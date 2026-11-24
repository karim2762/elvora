import { api } from './apiClient';

// The student is identified by the session cookie on the server. No student ID is ever sent from here.
export const submitApplication = (payload) => api.post('/applications', payload).then((r) => r.application);
export const getApplication = (id) => api.get(`/applications/${encodeURIComponent(id)}`).then((r) => r.application);
// Application plus its progress timeline (built on the server from backend records).
export const getApplicationDetails = (id) => api.get(`/applications/${encodeURIComponent(id)}`);

// Paged list: { applications, pagination: { page, pageSize, total, totalPages }, counts: { All, Submitted, ... } }.
// `status` is one of the five statuses or omitted/'All'. Both are validated again on the server.
export function listMyApplications({ status, page = 1, pageSize = 10 } = {}) {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (status && status !== 'All') q.set('status', status);
  return api.get(`/applications/my?${q}`);
}
