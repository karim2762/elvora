import { api } from './apiClient';

// Role-based administrator session (Stage 07A). The role lives on the server; the client only asks who it is.
export const adminLogin = (payload) => api.post('/auth/admin/login', payload).then((r) => r.user);
export const getAdminDashboard = () => api.get('/admin/dashboard');
