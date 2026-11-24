import { api } from './apiClient';

// The student is identified by the session cookie; these endpoints take no student ID.
export const getDashboard = () => api.get('/student/dashboard');
// The signed-in student's own approved internships, each with its progress timeline. Read-only.
export const listMyInternships = () => api.get('/student/internships').then((r) => r.internships);

// ---- Stage 05C ----
export const listDocuments = () => api.get('/student/documents').then((r) => r.documents);
export const fetchDocumentFile = (id, { download = false } = {}) => api.blob(`/student/documents/${encodeURIComponent(id)}/file${download ? '?download=1' : ''}`);
export const listNotifications = ({ page = 1, pageSize = 10, unread = false } = {}) =>
  api.get(`/student/notifications?page=${page}&pageSize=${pageSize}${unread ? '&unread=true' : ''}`);
export const getUnreadCount = () => api.get('/student/notifications/unread-count').then((r) => r.unreadCount);
export const markNotificationRead = (id) => api.patch(`/student/notifications/${encodeURIComponent(id)}/read`, {});
export const markAllNotificationsRead = () => api.patch('/student/notifications/read-all', {});
export const getStudentProfile = () => api.get('/student/profile').then((r) => r.profile);
export const patchStudentProfile = (payload) => api.patch('/student/profile', payload).then((r) => r.profile);
export const changePassword = (payload) => api.patch('/student/change-password', payload);

// ---- Stage 09B: assigned tasks and their full instructions (read-only) ----
export const listMyTasks = () => api.get('/student/tasks');
export const getMyTask = (id) => api.get(`/student/tasks/${encodeURIComponent(id)}`);

// ---- Stage 09B Part 2A: start a task and submit its work. The server reads the student from the session; no student ID is ever sent. ----
export const startMyTask = (id) => api.post(`/student/tasks/${encodeURIComponent(id)}/start`);
export const submitMyTask = (id, body) => api.post(`/student/tasks/${encodeURIComponent(id)}/submissions`, body);

// ---- Stage 09C Part 1: GitHub connection. The server holds every token; the browser only ever sees status, a login name and a redirect URL. ----
export const getGithubStatus = () => api.get('/student/github/status');
export const startGithubConnect = () => api.post('/student/github/connect', {}).then((r) => r.authorizeUrl);
export const disconnectGithub = () => api.del('/student/github');

// ---- Stage 09C Part 2A: the repository of one task, and GitHub project submission (server verifies everything) ----
const tid = (id) => encodeURIComponent(id);
export const getTaskRepository = (id) => api.get(`/student/github/tasks/${tid(id)}/repository`);
export const createTaskRepository = (id) => api.post(`/student/github/tasks/${tid(id)}/repository`, {});
export const linkTaskRepository = (id, repositoryUrl) => api.post(`/student/github/tasks/${tid(id)}/repository/link`, { repositoryUrl });
export const unlinkTaskRepository = (id) => api.del(`/student/github/tasks/${tid(id)}/repository/link`);
export const verifyTaskRepository = (id) => api.post(`/student/github/tasks/${tid(id)}/repository/verify-ownership`, {});
export const refreshTaskEvidence = (id) => api.post(`/student/github/tasks/${tid(id)}/repository/inspect`, {});
export const submitGithubProject = (id, body) => api.post(`/student/github/tasks/${tid(id)}/submissions`, body);
export const getSubmissionHistory = (id) => api.get(`/student/github/tasks/${tid(id)}/submissions`);
