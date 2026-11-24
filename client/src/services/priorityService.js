import { api } from './apiClient';
import { env } from '../config/env';

// Stage 10A Part 1 — private Priority Certificate Processing. The server decides access, eligibility and the fee; nothing sent from here is trusted for those.
const B = '/priority-certificate';
export const getAccess = () => api.get(`${B}/access`).then((r) => r.access);
export const redeemInvite = (token) => api.post(`${B}/access`, { token }).then((r) => r.access);
export const getPortal = () => api.get(`${B}/portal`);
export const getOptions = () => api.get(`${B}/options`);
// 1/2/3-month plans: the server returns the prices and creates the request; the certificate follows a verified payment.
export const getPlans = () => api.get(`${B}/plans`);
export const choosePlan = (months, confirmPersonal, confirmAcademic) => api.post(`${B}/plans`, { months, confirmPersonal, confirmAcademic });
export const checkEligibility = (applicationId) => api.post(`${B}/eligibility`, { applicationId });
export const saveDraft = (applicationId, confirmPersonal, confirmAcademic) => api.post(`${B}/requests`, { applicationId, confirmPersonal, confirmAcademic });
export const listRequests = () => api.get(`${B}/requests`).then((r) => r.requests);
export const listMyCorrections = () => api.get(`${B}/corrections`);

// Stage 10B Part 1 — manual UPI payments. The amount and payee are returned by the server; this client never sends or edits either.
export const getPaymentInfo = () => api.get(`${B}/payment-info`);
export const createPaymentOrder = (requestId) => api.post(`${B}/requests/${encodeURIComponent(requestId)}/payment-order`, {});
export const listPayments = () => api.get(`${B}/payments`).then((r) => r.payments);
export const getPayment = (id) => api.get(`${B}/payments/${encodeURIComponent(id)}`);
export const resubmitPayment = (id, body) => api.post(`${B}/payments/${encodeURIComponent(id)}/resubmit`, body);
export const submitPayment = (id, body) => api.post(`${B}/payments/${encodeURIComponent(id)}/submit`, body);
export async function uploadProof(id, file) {
  const res = await fetch(`${env.apiUrl}${B}/payments/${encodeURIComponent(id)}/proof`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': file.type }, body: file });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || 'Upload failed'), { status: res.status, data });
  return data;
}
