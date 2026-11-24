import { api } from './apiClient';

// Thin wrappers over the REST API. The session lives in an httpOnly cookie, so nothing sensitive is kept in JS.
export const register = (payload) => api.post('/auth/register', payload).then((r) => r.user);
export const login = (payload) => api.post('/auth/login', payload).then((r) => r.user);
export const logout = () => api.post('/auth/logout');
export const currentUser = () => api.get('/auth/me').then((r) => r.user);
export const forgotPassword = (email) => api.post('/auth/forgot-password', { email });
export const resetPassword = (payload) => api.post('/auth/reset-password', payload);
export const getProfile = () => api.get('/students/me').then((r) => r.user);
export const updateProfile = (payload) => api.put('/students/me', payload).then((r) => r.user);
