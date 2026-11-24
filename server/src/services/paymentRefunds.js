import { db } from '../db/index.js';
import * as Pay from '../db/payments.js';
import { record as audit } from '../db/audit.js';
import { insert as notify } from '../db/notifications.js';
import { formatInr } from './priorityCertificate.js';
import { can, adminsWith, normalizeUtr, validUtr } from './payments.js';
import { HttpError, badRequest, notFound } from '../utils/errors.js';

// Stage 10B Part 2B — MANUAL refunds. A UPI transfer cannot be reversed by this software, and no payment gateway is used: an administrator sends the money
// from the real ELVORA bank/UPI account and then records it here. A refund record is only a record. REFUNDED is possible only after an administrator holding
// 'payment.refund' enters the real refund reference and confirms they checked the actual account statement; until then no message to the student says money was sent.
// The CONFIRMED payment (status, UTR, amount, reviewer) is never edited, and the request/certificate workflow is not touched by a refund.
const fail = (status, code, message, details) => new HttpError(status, message, { code, details });
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const VPA = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
export const REFUND_STATUSES = Object.freeze(['REFUND_REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_REJECTED']);
export const REFUND_NOTICE = 'A refund record is not a refund. Money has been returned only when the refund is marked REFUNDED, which requires the actual bank/UPI transaction reference checked against the ELVORA account statement.';
export const REFUND_ACKS = Object.freeze([
  ['accountChecked', 'I checked the actual ELVORA bank/UPI account transaction record for this refund.'],
  ['referenceMatches', 'The refund reference matches that transaction record.'],
  ['amountMatches', 'The refunded amount matches this refund.'],
]);
const rupeesToPaise = (v) => { const s = String(v ?? '').trim(); if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null; return Math.round(Number(s) * 100); };

function needRefundAdmin(admin) {
  if (admin?.via !== 'session' || !admin.id || !can(admin, 'payment.refund')) throw fail(403, 'PERMISSION_REQUIRED', 'You do not have permission to manage refunds.');
}
export const balance = (paymentId) => {
  const p = Pay.paymentById(paymentId); const reserved = Pay.refundReserved(paymentId); const completed = Pay.refundCompleted(paymentId);
  return { confirmedPaise: p.expectedPaise, confirmedDisplay: formatInr(p.expectedPaise), reservedPaise: reserved, completedPaise: completed, availablePaise: Math.max(0, p.expectedPaise - reserved), availableDisplay: formatInr(Math.max(0, p.expectedPaise - reserved)) };
};
const view = (r, { admin = true } = {}) => r && ({ id: r.id, paymentId: r.paymentId, status: r.status, amountPaise: r.amountPaise, amountDisplay: formatInr(r.amountPaise), requestedAt: r.requestedAt, updatedAt: r.updatedAt,
  ...(admin ? { reason: r.reason, destination: r.destination, notes: r.notes, refundUtr: r.refundUtr, refundDate: r.refundDate, rejectionReason: r.rejectionReason, requestedBy: r.requestedBy, requestedByName: r.requestedByName,
    pendingAt: r.pendingAt, completedBy: r.completedBy, completedByName: r.completedByName, completedAt: r.completedAt, rejectedBy: r.rejectedBy, rejectedByName: r.rejectedByName, rejectedAt: r.rejectedAt }
    // The student sees the outcome only. A reference is shown once the refund is REFUNDED; destination and internal notes stay private.
    : { reason: r.reason, completedAt: r.completedAt, refundReference: r.status === 'REFUNDED' ? r.refundUtr : null, rejectionReason: r.rejectionReason, rejectedAt: r.rejectedAt }) });
const stu = (r) => Pay.paymentById(r.paymentId);

export function summaryFor(paymentId) {
  const p = Pay.paymentById(paymentId); if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  return { notice: REFUND_NOTICE, balance: balance(paymentId), refunds: Pay.refundsFor(paymentId).map((r) => ({ ...view(r), events: Pay.refundEvents(r.id) })), canRequest: p.status === 'VERIFIED' && balance(paymentId).availablePaise > 0,
    acknowledgements: REFUND_ACKS.map(([key, text]) => ({ key, text })) };
}
export const historyFor = (refundId) => { const r = Pay.refundById(refundId); if (!r) throw notFound('Refund not found', 'REFUND_NOT_FOUND'); return { refund: view(r), events: Pay.refundEvents(r.id), balance: balance(r.paymentId) }; };
export const studentRefunds = (student, paymentId) => {
  if (!Pay.paymentOwned(paymentId, student.id)) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  return { refunds: Pay.refundsForStudentPayment(paymentId, student.id).map((r) => view(r, { admin: false })) };
};
export function listRefunds(query = {}) {
  const status = query.status && query.status !== 'All' ? String(query.status) : null;
  if (status && !REFUND_STATUSES.includes(status)) throw badRequest('Invalid filter', { status: `Use one of: ${REFUND_STATUSES.join(', ')}` });
  const rows = db.prepare(`SELECT r.*, p.internal_reference FROM payment_refunds r JOIN priority_payments p ON p.id = r.payment_id ${status ? 'WHERE r.status = ?' : ''} ORDER BY r.requested_at DESC, r.rowid DESC LIMIT 200`).all(...(status ? [status] : []));
  return { refunds: rows.map((r) => ({ ...view(Pay.refundById(r.id)), paymentReference: r.internal_reference, studentId: r.student_id })), counts: Pay.refundCounts() };
}

// ---------------- create ----------------
export function createRefund(admin, paymentId, body = {}) {
  needRefundAdmin(admin);
  const errors = {};
  const paise = rupeesToPaise(body.amountRupees); if (paise === null || paise < 100) errors.amountRupees = 'Enter the refund amount in rupees (at least ₹1, at most 2 decimals).';
  const reason = clean(body.reason, 300); if (reason.length < 10) errors.reason = 'Explain why the refund is being made (10–300 characters).';
  const destination = clean(body.destination, 121); // one character more than the limit, so an over-long value is refused instead of being silently cut short
  if (destination.length < 3 || destination.length > 120 || (destination.includes('@') && !VPA.test(destination))) errors.destination = 'Enter where the refund will be sent (a valid UPI ID such as name@bank, or “original payment account”).';
  const notes = body.notes ? clean(body.notes, 500) : null;
  if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', errors);
  return db.transaction(() => {
    const p = Pay.paymentById(paymentId); if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
    if (p.studentId === admin.id) throw fail(403, 'SELF_REVIEW', 'You cannot manage a refund on your own payment.');
    if (p.status !== 'VERIFIED') throw fail(409, 'PAYMENT_NOT_VERIFIED', 'A refund can only be requested for a verified payment.');
    const avail = p.expectedPaise - Pay.refundReserved(p.id);
    if (paise > p.expectedPaise) throw fail(400, 'REFUND_EXCEEDS_PAYMENT', `The refund cannot exceed the confirmed payment of ${formatInr(p.expectedPaise)}.`);
    if (paise > avail) throw fail(409, 'REFUND_EXCEEDS_BALANCE', `Only ${formatInr(Math.max(0, avail))} of this payment is still refundable.`, { availablePaise: Math.max(0, avail) });
    let id;
    try { id = Pay.insertRefund({ paymentId: p.id, studentId: p.studentId, amountPaise: paise, reason, destination, notes, adminId: admin.id, adminName: admin.fullName ?? 'Administrator' }); }
    catch (e) { if (Pay.isConstraint(e) || /refunds cannot exceed/.test(String(e?.message))) throw fail(409, 'REFUND_EXCEEDS_BALANCE', 'This refund would exceed the confirmed payment.'); throw e; }
    Pay.addRefundEvent(id, p.id, { event: 'requested', to: 'REFUND_REQUESTED', admin, note: `${formatInr(paise)}: ${reason}` });
    audit({ admin, action: 'refund.request', targetType: 'payment', targetId: p.id, reason: `${id}; ${paise} paise` });
    notify({ studentId: p.studentId, type: 'refund_requested', title: 'Refund request recorded', message: `ELVORA has recorded a refund request of ${formatInr(paise)} for your priority payment. This is not a confirmation that any money has been sent. You will be notified when the refund is processed or declined.`, applicationId: p.applicationId, enrollmentId: p.enrollmentId, dedupeKey: `refund:${id}:requested` });
    for (const adminId of adminsWith('payment.refund')) if (adminId !== admin.id) notify({ studentId: adminId, type: 'refund_requested_admin', title: 'Refund requested', message: `Refund ${id} (${formatInr(paise)}) was requested for payment ${p.internalReference ?? p.id}.`, dedupeKey: `refund:${id}:requested:admin` });
    return { refund: view(Pay.refundById(id)), ...summaryFor(p.id) };
  })();
}

function load(admin, id) {
  needRefundAdmin(admin);
  const r = Pay.refundById(id); if (!r) throw notFound('Refund not found', 'REFUND_NOT_FOUND');
  if (r.studentId === admin.id) throw fail(403, 'SELF_REVIEW', 'You cannot manage a refund on your own payment.');
  return r;
}
const stale = (r, expected) => fail(409, 'REFUND_STATE', `This refund is ${r.status.replace(/_/g, ' ').toLowerCase()}, so this action is not available.`, { status: r.status, expected });

// ---------------- REQUESTED -> PENDING ----------------
export function markPending(admin, id, body = {}) {
  const notes = body.notes ? clean(body.notes, 500) : null;
  return db.transaction(() => {
    const r = load(admin, id); const p = stu(r);
    if (r.status !== 'REFUND_REQUESTED') throw stale(r, 'REFUND_REQUESTED');
    if (!Pay.refundToPending(id, notes)) throw stale(Pay.refundById(id), 'REFUND_REQUESTED');
    Pay.addRefundEvent(id, r.paymentId, { event: 'pending', from: 'REFUND_REQUESTED', to: 'REFUND_PENDING', admin, note: notes ?? 'Refund approved for processing. Not yet sent.' });
    audit({ admin, action: 'refund.pending', targetType: 'payment', targetId: r.paymentId, reason: id });
    notify({ studentId: r.studentId, type: 'refund_pending', title: 'Refund being processed', message: `Your refund of ${formatInr(r.amountPaise)} has been approved for processing. It has not been sent yet; you will be notified once ELVORA records the completed transfer.`, applicationId: p.applicationId, enrollmentId: p.enrollmentId, dedupeKey: `refund:${id}:pending` });
    return { refund: view(Pay.refundById(id)) };
  })();
}

// ---------------- PENDING -> REFUNDED (only with the real reference) ----------------
export function completeRefund(admin, id, body = {}) {
  needRefundAdmin(admin);
  const errors = {};
  const utr = normalizeUtr(body.refundUtr);
  if (!validUtr(utr)) errors.refundUtr = 'Enter the actual refund transaction reference (UTR) from the bank/UPI statement: 8–35 letters or digits.';
  for (const [k] of REFUND_ACKS) if (body.acknowledgements?.[k] !== true) errors[k] = 'Tick after checking the actual account record.';
  const date = body.refundDate ? String(body.refundDate).trim() : null;
  if (date && !(/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date) && Date.parse(`${date}T00:00:00Z`) <= Date.now() + 86400000)) errors.refundDate = 'Use the transfer date (YYYY-MM-DD), not in the future.';
  const notes = body.notes ? clean(body.notes, 500) : null;
  if (Object.keys(errors).length) throw badRequest('A refund can be marked completed only with the real reference, after checking the actual account record.', errors);
  return db.transaction(() => {
    const r = load(admin, id); const p = stu(r);
    if (r.status !== 'REFUND_PENDING') throw stale(r, 'REFUND_PENDING');
    if (utr === Pay.confirmedUtrOf(r.paymentId) || Pay.confirmedUtr(utr)) throw fail(409, 'REFUND_REFERENCE_IS_PAYMENT', 'That is a payment reference, not a refund transfer reference.');
    if (Pay.refundUtrUsed(utr)) throw fail(409, 'DUPLICATE_REFUND_REFERENCE', 'This refund reference is already recorded against another refund.');
    try { if (!Pay.refundToDone(id, { utr, date, notes }, admin)) throw stale(Pay.refundById(id), 'REFUND_PENDING'); }
    catch (e) { if (Pay.isConstraint(e)) throw fail(409, 'DUPLICATE_REFUND_REFERENCE', 'This refund reference is already recorded against another refund.'); throw e; } // unique index: the database's own guarantee
    Pay.addRefundEvent(id, r.paymentId, { event: 'completed', from: 'REFUND_PENDING', to: 'REFUNDED', admin, note: `Reference ${utr}${date ? `, dated ${date}` : ''}; account record checked.` });
    audit({ admin, action: 'refund.complete', targetType: 'payment', targetId: r.paymentId, reason: `${id}; ${r.amountPaise} paise; ref ${utr}` });
    notify({ studentId: r.studentId, type: 'refund_completed', title: 'Refund completed', message: `ELVORA has recorded your refund of ${formatInr(r.amountPaise)} (reference ${utr}) after checking the transfer in its account statement. It may take a little time to appear in your account.`, applicationId: p.applicationId, enrollmentId: p.enrollmentId, dedupeKey: `refund:${id}:completed` });
    return { refund: view(Pay.refundById(id)), balance: balance(r.paymentId) };
  })();
}

// ---------------- REQUESTED / PENDING -> REJECTED ----------------
export function rejectRefund(admin, id, body = {}) {
  const reason = clean(body.reason, 300);
  if (reason.length < 10) throw badRequest('Explain why the refund is being declined (10–300 characters).', { reason: 'Required' });
  return db.transaction(() => {
    const r = load(admin, id); const p = stu(r);
    if (!['REFUND_REQUESTED', 'REFUND_PENDING'].includes(r.status)) throw stale(r, 'REFUND_REQUESTED or REFUND_PENDING');
    if (!Pay.refundToRejected(id, reason, admin)) throw stale(Pay.refundById(id), 'REFUND_REQUESTED or REFUND_PENDING');
    Pay.addRefundEvent(id, r.paymentId, { event: 'rejected', from: r.status, to: 'REFUND_REJECTED', admin, note: reason });
    audit({ admin, action: 'refund.reject', targetType: 'payment', targetId: r.paymentId, reason: `${id}; ${reason}` });
    notify({ studentId: r.studentId, type: 'refund_rejected', title: 'Refund request declined', message: `Your refund request of ${formatInr(r.amountPaise)} was declined: ${reason} No refund has been sent. Contact support if you have questions.`, applicationId: p.applicationId, enrollmentId: p.enrollmentId, dedupeKey: `refund:${id}:rejected` });
    return { refund: view(Pay.refundById(id)), balance: balance(r.paymentId) };
  })();
}
