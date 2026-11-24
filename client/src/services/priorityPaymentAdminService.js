import { api } from './apiClient';
import { env } from '../config/env';

// Stage 10B Part 1 — pricing and UPI configuration. The server enforces the permission on every call.
const B = '/admin/priority-payments';
export const getPermissions = () => api.get(`${B}/permissions`).then((r) => r.permissions);
export const getPricing = () => api.get(`${B}/pricing`);
export const previewPricing = (prices) => api.put(`${B}/pricing`, { prices, preview: true });
export const savePricing = (prices) => api.put(`${B}/pricing`, { prices, confirm: true });
export const getPricingHistory = () => api.get(`${B}/pricing/history`);
export const getConfig = () => api.get(`${B}/config`);
export const saveConfig = (body, confirm = false) => api.put(`${B}/config`, confirm ? { ...body, confirm: true } : body);

// Stage 10B Part 2A — verification. Decisions are made on the server (permission, acknowledgements, locking); nothing here decides a payment's status.
const q = (o) => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)); return p.toString() ? `?${p}` : ''; };
export const getQueue = (filters = {}) => api.get(`${B}/queue${q(filters)}`);
export const getPaymentDetail = (id) => api.get(`${B}/${encodeURIComponent(id)}`);
export const getPaymentHistory = (id) => api.get(`${B}/${encodeURIComponent(id)}/history`);
export const getDuplicates = (id) => api.get(`${B}/${encodeURIComponent(id)}/duplicates`);
export const confirmPayment = (id, submissionId, acknowledgements, note) => api.post(`${B}/${encodeURIComponent(id)}/confirm`, { submissionId, acknowledgements, note: note || undefined });
export const rejectPayment = (id, submissionId, reason, note) => api.post(`${B}/${encodeURIComponent(id)}/reject`, { submissionId, reason, note: note || undefined });

// Stage 10B Part 2B — refunds (permission 'payment.refund'), overdue report, QR image. The server enforces every rule; a refund record is not a refund until marked REFUNDED.
export const getOverdue = () => api.get(`${B}/overdue`);
export const getRefundSummary = (paymentId) => api.get(`${B}/${encodeURIComponent(paymentId)}/refunds`);
export const createRefund = (paymentId, body) => api.post(`${B}/${encodeURIComponent(paymentId)}/refunds`, body);
export const refundPending = (id, notes) => api.post(`${B}/refunds/${encodeURIComponent(id)}/pending`, { notes: notes || undefined });
export const refundComplete = (id, body) => api.post(`${B}/refunds/${encodeURIComponent(id)}/complete`, body);
export const refundReject = (id, reason) => api.post(`${B}/refunds/${encodeURIComponent(id)}/reject`, { reason });
export const uploadQr = async (file) => {
  const res = await fetch(`${env.apiUrl}${B}/config/qr?confirm=true`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': file.type }, body: file });
  const data = await res.json().catch(() => null); if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? 'Upload failed'), { data }); return data;
};

// Stage 10C Part 1 — financial reports and CSV export (permission 'payment.report'). Figures are administrators' own confirmations, not bank proof.
export const getFinancialSummary = (filters = {}) => api.get(`${B}/reports/summary${q(filters)}`);
export const getTransactions = (filters = {}) => api.get(`${B}/reports/transactions${q(filters)}`);
export const transactionsCsvUrl = (filters = {}) => `${env.apiUrl}${B}/reports/transactions.csv${q(filters)}`; // open in the browser; the session cookie authorises it
