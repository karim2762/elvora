import { db } from '../db/index.js';
import * as Pay from '../db/payments.js';
import * as students from '../db/students.js';
import { record as audit, forTarget } from '../db/audit.js';
import { insert as notify } from '../db/notifications.js';
import { formatInr } from './priorityCertificate.js';
import { REJECT_LABELS } from './payments.js';
import { sweepOverdue } from './paymentOverdue.js';
import { HttpError, badRequest, notFound } from '../utils/errors.js';

// Stage 10B Part 2A — administrator verification of MANUAL UPI payments.
// A student's UTR or screenshot is only a claim. Only an administrator holding the 'payment.review' permission (checked by the route AND again here) can
// confirm a payment, after comparing it with the real receiving-account record. Confirming moves the REQUEST to 'Payment Verified' and nothing else:
// it never issues a certificate, completes an internship or approves a request. The existing eligibility/review/issuance workflow stays authoritative.
const fail = (status, code, message, details) => new HttpError(status, message, { code, details });
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s); // an impossible date such as 2026-13-40 must be a 400, never a thrown RangeError

export const ACKNOWLEDGEMENTS = Object.freeze([
  ['accountChecked', 'I checked the actual receiving ELVORA bank/UPI account transaction record.'],
  ['utrMatches', 'The UTR/reference matches the transaction record.'],
  ['amountMatches', 'The amount matches the expected amount.'],
  ['transactionSuccessful', 'The transaction was successful and the money was received.'],
  ['notAssignedElsewhere', 'This transaction has not already been assigned to another payment request.'],
]);
export const REJECT_REASONS = Object.entries(REJECT_LABELS).map(([code, label]) => ({ code, label, needsNote: code === 'OTHER' }));
export const REVIEW_NOTICE = 'Compare the submitted details with the actual transaction record in the ELVORA receiving bank/UPI account. A student-entered UTR or screenshot is not proof of payment, and a duplicate warning is not proof of fraud.';

// ---------------- status presentation (Stage 10C Part 1) ----------------
// One place decides how a payment is described to reviewers. Nothing here changes a status: 'overdue' is an indicator on a payment that is still PENDING_VERIFICATION.
export const STATUS_LABELS = Object.freeze({ AWAITING_PAYMENT: 'Awaiting Payment', PENDING_VERIFICATION: 'Awaiting Verification', VERIFIED: 'Verified', REJECTED: 'Rejected', EXPIRED: 'Expired', REFUND_PENDING: 'Refund Pending', REFUNDED: 'Refunded' });
export function describeStatus(p, split = Pay.refundSplit(p.id), nowIso = new Date().toISOString()) {
  const overdue = p.status === 'PENDING_VERIFICATION' && Boolean(p.verificationDeadline) && p.verificationDeadline < nowIso;
  let key = p.status; let label = STATUS_LABELS[p.status] ?? p.status;
  if (['VERIFIED', 'REFUND_PENDING', 'REFUNDED'].includes(p.status)) { // the confirmed payment row is never edited by a refund, so the refund state is derived from the refund records
    if (split.completedPaise >= p.expectedPaise) { key = 'REFUNDED'; label = 'Refunded'; }
    else if (split.requestedPaise + split.approvedPaise > 0) { key = 'REFUND_PENDING'; label = 'Refund Pending'; }
    else if (split.completedPaise > 0) { key = 'PARTIALLY_REFUNDED'; label = 'Partially Refunded'; }
    else { key = 'VERIFIED'; label = 'Verified'; }
  }
  if (overdue) label = 'Awaiting Verification — Overdue';
  return { key, label, overdue };
}
const hoursSince = (iso, nowMs) => (iso ? Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000)) : null);
// elapsed: since the student submitted (or since the order was created while still awaiting payment). deadline: the configured verification target (default 24 h).
function timing(p, submittedAt, nowMs = Date.now()) {
  const since = submittedAt ?? p.createdAt; const dl = p.verificationDeadline ? Date.parse(p.verificationDeadline) : null;
  const waiting = p.status === 'PENDING_VERIFICATION';
  return { elapsedSeconds: hoursSince(since, nowMs), elapsedSince: since, verificationDeadline: p.verificationDeadline ?? null,
    secondsToDeadline: waiting && dl ? Math.floor((dl - nowMs) / 1000) : null, overdueBySeconds: waiting && dl && dl < nowMs ? Math.floor((nowMs - dl) / 1000) : null };
}

// ---------------- queue ----------------
export function queue(query = {}) {
  const errors = {}; const one = (k) => (typeof query[k] === 'string' && query[k].trim() !== '' && query[k] !== 'All' ? query[k].trim().slice(0, 80) : null);
  let filter = one('status'); if (filter === 'awaiting_verification') filter = 'pending'; const from = one('from'); const to = one('to'); const dur = one('durationDays'); const q = one('q');
  if (filter && !Pay.QUEUE_FILTERS.includes(filter)) errors.status = `Use one of: ${[...Pay.QUEUE_FILTERS, 'awaiting_verification'].join(', ')}`;
  if (from && !validDate(from)) errors.from = 'Use a date like 2026-11-21';
  if (to && !validDate(to)) errors.to = 'Use a date like 2026-11-21';
  if (from && to && !errors.from && !errors.to && from > to) errors.to = 'The end date can’t be before the start date';
  if (dur && ![30, 60, 90].includes(Number(dur))) errors.durationDays = 'Use 30, 60 or 90';
  const num = (k, d, min, max) => { const v = query[k]; if (v === undefined || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) { errors[k] = `Use a whole number from ${min} to ${max}`; return d; } return n; };
  const pageSize = num('pageSize', 25, 1, 100); const wanted = num('page', 1, 1, 100000);
  if (Object.keys(errors).length) throw badRequest('Invalid filter', errors);
  try { sweepOverdue(); } catch { /* reporting must never break the queue */ }
  const f = { filter, from, to, q, durationDays: dur ? Number(dur) : null };
  const total = Pay.pageQueue({ ...f, limit: 1, offset: 0 }).total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize)); const page = Math.min(wanted, totalPages);
  const { rows } = Pay.pageQueue({ ...f, limit: pageSize, offset: (page - 1) * pageSize });
  const nowMs = Date.now(); const nowIso = new Date(nowMs).toISOString();
  const enrich = (r) => { const p = Pay.paymentById(r.paymentId); const split = Pay.refundSplit(r.paymentId); const d = describeStatus(p, split, nowIso); const last = Pay.lastReview(r.paymentId);
    return { ...r, statusKey: d.key, statusLabel: d.label, overdue: d.overdue, ...timing(p, p.submittedAt ?? r.submittedAt, nowMs), refund: { requestedPaise: split.requestedPaise, approvedPaise: split.approvedPaise, completedPaise: split.completedPaise },
      previousAdminActions: Pay.reviewCount(r.paymentId), lastAction: last ? { decision: last.decision, adminName: last.adminName, at: last.at } : null }; };
  return { payments: rows.map((r) => ({ ...enrich(r), expectedDisplay: formatInr(r.expectedPaise), proofUrl: r.hasProof ? `/admin/priority-payments/${r.paymentId}/proof/${r.proofId}` : null })),
    pagination: { page, pageSize, total, totalPages }, counts: Pay.queueCounts(), filters: { statuses: [...Pay.QUEUE_FILTERS, 'awaiting_verification'], durations: [30, 60, 90] }, verificationTargetHours: Pay.getConfig().verificationHours,
    notice: 'Overdue payments are highlighted only. Nothing is approved or rejected automatically when a deadline passes.' };
}

// ---------------- detail ----------------
export function duplicatesFor(paymentId, submission = Pay.submissionFor(paymentId)) {
  if (!submission) return { confirmed: null, others: [], warning: false };
  const others = Pay.sameUtr(submission.utr, submission.id); const confirmedPaymentId = Pay.confirmedUtr(submission.utr);
  const p = Pay.paymentById(paymentId);
  return { confirmedElsewhere: Boolean(confirmedPaymentId && confirmedPaymentId !== paymentId), confirmedPaymentId: confirmedPaymentId && confirmedPaymentId !== paymentId ? confirmedPaymentId : null,
    others: others.map((o) => ({ ...o, sameStudent: o.studentId === p.studentId })), crossStudent: others.some((o) => o.studentId !== p.studentId),
    warning: others.length > 0 || Boolean(confirmedPaymentId && confirmedPaymentId !== paymentId),
    note: 'A duplicate reference is a reason to investigate, not proof of fraud: a student may have mistyped it or resubmitted it.' };
}
const subView = (paymentId, s) => { const r = Pay.reviewOf(s.id); return { id: s.id, revision: s.revision, previousSubmissionId: s.previousSubmissionId, replacementReason: s.replacementReason, utr: s.utr, paymentDate: s.paymentDate, paymentTime: s.paymentTime, upiApp: s.upiApp, note: s.note,
  submittedAt: s.submittedAt, hasProof: Boolean(s.proofId), proofUrl: s.proofId ? `/admin/priority-payments/${paymentId}/proof/${s.proofId}` : null,
  decision: r ? { decision: r.decision, reason: r.reasonCode ? REJECT_LABELS[r.reasonCode] : null, reasonCode: r.reasonCode, note: r.note, adminId: r.adminId, adminName: r.adminName, at: r.at } : null }; };

export function detail(admin, id) {
  const p = Pay.paymentById(id);
  if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  const st = students.findById(p.studentId);
  const reqRow = db.prepare('SELECT id, status, duration_days, created_at, instant FROM priority_requests WHERE id = ?').get(p.requestId);
  const history = db.prepare('SELECT from_status, to_status, note, actor, created_at FROM priority_request_history WHERE request_id = ? ORDER BY id').all(p.requestId).map((h) => ({ from: h.from_status, to: h.to_status, note: h.note, actor: h.actor, at: h.created_at }));
  const subs = Pay.submissionsFor(p.id); const current = subs[subs.length - 1] ?? null;
  const dup = duplicatesFor(p.id, current);
  const overdue = p.status === 'PENDING_VERIFICATION' && Boolean(p.verificationDeadline) && p.verificationDeadline < new Date().toISOString();
  const self = admin?.id && admin.id === p.studentId;
  audit({ admin, action: 'payment.review_view', targetType: 'payment', targetId: id });
  return {
    notice: REVIEW_NOTICE,
    status: (({ key, label }) => ({ key, label }))(describeStatus(p)), timing: timing(p, current?.submittedAt ?? p.submittedAt), transaction: Pay.transactionFor(p.id), refundSummary: Pay.refundSplit(p.id),
    payment: { id: p.id, internalReference: p.internalReference, status: p.status, overdue, expectedPaise: p.expectedPaise, expectedDisplay: formatInr(p.expectedPaise), currency: p.currency, durationDays: p.durationDays, pricingVersion: p.pricingVersion,
      payeeName: p.payeeName, payeeUpiId: p.payeeUpiId, createdAt: p.createdAt, submittedAt: p.submittedAt, verificationDeadline: p.verificationDeadline,
      verifiedAt: p.verifiedAt, verifiedBy: p.verifiedBy, verifiedByName: p.verifiedByName, rejectionCode: p.rejectionCode, rejectionReason: p.rejectionCode ? REJECT_LABELS[p.rejectionCode] : null, rejectionNote: p.rejectionNote, reviewedAt: p.reviewedAt, reviewedBy: p.reviewedBy },
    student: st ? { id: st.id, fullName: st.fullName } : { id: p.studentId, fullName: null }, // no e-mail, phone or other personal data
    request: reqRow ? { id: reqRow.id, status: reqRow.status, instant: reqRow.instant === 1, durationDays: reqRow.duration_days, createdAt: reqRow.created_at, history } : null,
    applicationId: p.applicationId, enrollmentId: p.enrollmentId,
    currentSubmission: current && subView(p.id, current), submissions: subs.map((s) => subView(p.id, s)), previousAttempts: subs.slice(0, -1).map((s) => subView(p.id, s)),
    duplicates: dup, events: Pay.eventsFor(p.id), audit: forTarget('payment', p.id, 50),
    review: { acknowledgements: ACKNOWLEDGEMENTS.map(([key, text]) => ({ key, text })), rejectReasons: REJECT_REASONS,
      canConfirm: p.status === 'PENDING_VERIFICATION' && !self, canReject: p.status === 'PENDING_VERIFICATION' && !self, ...(self ? { blockedReason: 'You cannot review your own payment.' } : {}),
      submissionId: current?.id ?? null },
  };
}
export function history(id) {
  const p = Pay.paymentById(id); if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  return { paymentId: id, status: p.status, events: Pay.eventsFor(id), reviews: Pay.reviewsFor(id), submissions: Pay.submissionsFor(id).map((s) => subView(id, s)), audit: forTarget('payment', id, 100) };
}
export function duplicates(id) { const p = Pay.paymentById(id); if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND'); return { paymentId: id, ...duplicatesFor(id) }; }
export function proof(admin, paymentId, proofId, readProof) {
  const f = readProof(paymentId, proofId); // 404 unless this proof belongs to this payment
  audit({ admin, action: 'payment.proof_view', targetType: 'payment', targetId: paymentId, reason: proofId });
  return f;
}

// ---------------- decisions ----------------
const needAdmin = (admin) => { if (admin?.via !== 'session' || !admin.id) throw fail(403, 'PERMISSION_REQUIRED', 'A named administrator session is required.'); };
// Loads and validates the payment inside the caller's (IMMEDIATE) transaction. Another administrator's decision, a resubmission or a status change that landed first
// makes the stored status or latest submission differ from what this admin reviewed, and the decision is refused (never applied twice).
function lockedPending(admin, id, body) {
  const p = Pay.paymentById(id);
  if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  if (p.studentId === admin.id) throw fail(403, 'SELF_REVIEW', 'You cannot review your own payment.');
  if (p.status !== 'PENDING_VERIFICATION') throw fail(409, p.status === 'VERIFIED' ? 'ALREADY_VERIFIED' : 'NOT_PENDING', p.status === 'VERIFIED' ? 'This payment has already been verified.' : 'This payment is not waiting for verification.', { status: p.status });
  const sub = Pay.submissionFor(p.id);
  if (!sub) throw fail(409, 'NO_SUBMISSION', 'There is no submitted reference to review.');
  if (typeof body?.submissionId !== 'string' || body.submissionId !== sub.id) throw fail(409, 'STALE_SUBMISSION', 'The student submitted newer details. Reload the payment and review the current submission.');
  return { p, sub };
}

export function confirm(admin, id, body = {}) {
  needAdmin(admin);
  const ack = {}; const missing = [];
  for (const [key] of ACKNOWLEDGEMENTS) { ack[key] = body?.acknowledgements?.[key] === true; if (!ack[key]) missing.push(key); }
  if (missing.length) throw badRequest('Tick every confirmation after checking the actual receiving account.', Object.fromEntries(missing.map((k) => [k, 'Required'])));
  const note = body.note ? clean(body.note, 300) : null;
  return db.transaction(() => {
    const { p, sub } = lockedPending(admin, id, body);
    if (sub.amountPaise !== p.expectedPaise) throw fail(409, 'AMOUNT_MISMATCH', 'The recorded amount differs from the order amount.'); // never expected: the amount is frozen
    if (Pay.confirmedUtr(sub.utr)) throw fail(409, 'DUPLICATE_CONFIRMED_UTR', 'This transaction reference is already confirmed for another payment.');
    try { Pay.insertConfirmedUtr({ utr: sub.utr, paymentId: p.id, submissionId: sub.id, adminId: admin.id }); } // PRIMARY KEY(utr): the database refuses a second confirmation
    catch (e) { if (Pay.isConstraint(e)) throw fail(409, 'DUPLICATE_CONFIRMED_UTR', 'This transaction reference is already confirmed for another payment.'); throw e; }
    if (!Pay.markVerified(p.id, admin)) throw fail(409, 'ALREADY_DECIDED', 'This payment was decided by someone else.');
    // The internal transaction record (unique id, student, request, confirmed amount and UTR, verifying administrator, time). UNIQUE keys and a consistency trigger make a second or mismatching record impossible.
    let transactionId;
    try { transactionId = Pay.insertTransaction({ payment: p, submission: sub, admin }); }
    catch (e) { if (Pay.isConstraint(e)) throw fail(409, 'DUPLICATE_TRANSACTION', 'A transaction record already exists for this payment or reference.'); throw e; }
    Pay.insertReview({ paymentId: p.id, submissionId: sub.id, decision: 'VERIFIED', note, acknowledgements: ack, adminId: admin.id, adminName: admin.fullName ?? 'Administrator' });
    // The request moves to PAYMENT_VERIFIED ('Payment Verified'). That is all: eligibility review, approval and issuance remain separate administrator steps with their own gates.
    if (!Pay.moveRequest(p.requestId, 'Payment Pending', 'Payment Verified', 'Payment verified by an administrator. The request now continues through the normal eligibility review.', 'admin')) throw fail(409, 'REQUEST_STATE', 'The request is not waiting for payment verification.');
    Pay.addEvent(p.id, { event: 'verified', from: 'PENDING_VERIFICATION', to: 'VERIFIED', actor: `admin:${admin.id}`, note: note ?? 'Confirmed against the receiving account record.' });
    audit({ admin, action: 'payment.verify', targetType: 'payment', targetId: p.id, reason: `submission ${sub.id}; request ${p.requestId}; ${p.expectedPaise} paise; ${transactionId}` });
    audit({ admin, action: 'payment.transaction_record', targetType: 'payment', targetId: p.id, reason: `${transactionId}; ${p.expectedPaise} paise` });
    const instant = db.prepare('SELECT instant FROM priority_requests WHERE id = ?').get(p.requestId)?.instant === 1;
    notify({ studentId: p.studentId, type: 'payment_verified', title: 'Payment verified', message: instant ? 'Your payment has been approved. Your offer letter is being issued now and will appear under Documents. Your certificate follows when your plan period is completed.' : 'Your priority payment has been verified. Your request now continues through ELVORA’s review. A certificate is issued only after every normal eligibility check passes.', applicationId: p.applicationId, enrollmentId: p.enrollmentId, dedupeKey: `pay:${p.id}:verified` });
    return { verified: true, transactionId, payment: detailLite(p.id) };
  })();
}

export function reject(admin, id, body = {}) {
  needAdmin(admin);
  const code = typeof body.reason === 'string' ? body.reason : body.reasonCode;
  if (typeof code !== 'string' || !REJECT_LABELS[code]) throw badRequest('Choose a rejection reason.', { reason: `One of: ${Object.keys(REJECT_LABELS).join(', ')}` });
  const note = body.note ? clean(body.note, 300) : null;
  if (code === 'OTHER' && (!note || note.length < 10)) throw badRequest('Explain the reason (10–300 characters).', { note: 'Required for "Other"' });
  return db.transaction(() => {
    const { p, sub } = lockedPending(admin, id, body);
    if (!Pay.markRejected(p.id, admin, code, note)) throw fail(409, 'ALREADY_DECIDED', 'This payment was decided by someone else.');
    Pay.insertReview({ paymentId: p.id, submissionId: sub.id, decision: 'REJECTED', reasonCode: code, note, adminId: admin.id, adminName: admin.fullName ?? 'Administrator' });
    // The submission, its proof and every earlier decision are kept. The request goes back to 'Awaiting Payment' so the student can use the audited resubmission.
    if (!Pay.moveRequest(p.requestId, 'Payment Pending', 'Awaiting Payment', `Payment not accepted: ${REJECT_LABELS[code]}. The student may submit a corrected reference.`, 'admin')) throw fail(409, 'REQUEST_STATE', 'The request is not waiting for payment verification.');
    Pay.addEvent(p.id, { event: 'rejected', from: 'PENDING_VERIFICATION', to: 'REJECTED', actor: `admin:${admin.id}`, note: `${REJECT_LABELS[code]}${note ? `: ${note}` : ''}` });
    audit({ admin, action: 'payment.reject', targetType: 'payment', targetId: p.id, reason: `${code}; submission ${sub.id}` });
    const needInfo = code === 'INSUFFICIENT_EVIDENCE'; // "more information required": same state (the student may submit a corrected reference), clearer message
    notify({ studentId: p.studentId, type: needInfo ? 'payment_info_required' : 'payment_rejected', title: needInfo ? 'More information needed for your payment' : 'Payment not accepted', message: needInfo ? 'ELVORA needs more information to verify your payment. Open the priority portal and submit the correct reference with a clear receipt. No certificate is affected until a payment is verified.' : `Your payment details could not be verified (${REJECT_LABELS[code]}). Open the priority portal to see what to do next. No certificate is affected until a payment is verified.`, applicationId: p.applicationId, enrollmentId: p.enrollmentId, dedupeKey: `pay:${p.id}:rejected:${sub.id}` });
    return { rejected: true, payment: detailLite(p.id) };
  })();
}
const detailLite = (id) => { const p = Pay.paymentById(id); return { id: p.id, status: p.status, verifiedAt: p.verifiedAt, verifiedBy: p.verifiedBy, rejectionCode: p.rejectionCode, reviewedAt: p.reviewedAt }; };
