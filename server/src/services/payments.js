import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { db } from '../db/index.js';
import * as P from '../db/priority.js';
import * as Pay from '../db/payments.js';
import { record as audit } from '../db/audit.js';
import { insert as notify } from '../db/notifications.js';
import { config } from '../config/index.js';
import { evaluate, formatInr } from './priorityCertificate.js';
import { HttpError, badRequest, notFound } from '../utils/errors.js';

// Stage 10B Part 1 — manual UPI payments. The server alone decides the amount and the payee. A submitted UTR or screenshot is only a CLAIM:
// Administrator verification lives in paymentReview.js. Nothing here verifies or refunds a payment, moves a request toward issuance or issues a certificate.
// Part 2A adds the audited resubmission of a REJECTED payment: a NEW revision linked to the previous one; earlier revisions are never edited.
export const SUBMITTED_MESSAGE = 'Your payment details have been submitted successfully. ELVORA\'s admin team will verify the transaction, normally within 24 hours. Your request will move forward after successful verification.';
const fail = (status, code, message, details) => new HttpError(status, message, { code, details });
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
export const MAX_REVISIONS = 3; // the original submission plus two corrections
export const REJECT_LABELS = Object.freeze({ TRANSACTION_NOT_FOUND: 'Transaction not found', INCORRECT_AMOUNT: 'Incorrect amount', INVALID_REFERENCE: 'Invalid UTR/reference', DUPLICATE_REFERENCE: 'Duplicate transaction reference',
  TRANSACTION_FAILED: 'Transaction failed', WRONG_DESTINATION: 'Payment sent to incorrect destination', INSUFFICIENT_EVIDENCE: 'Insufficient evidence', OTHER: 'Other' });
const studentAudit = (action, id, reason) => audit({ admin: null, action, targetType: 'payment', targetId: id, reason, actorName: 'Student (payment)' });

// ================= permissions =================
export const PERMISSIONS = ['pricing.manage', 'payment.configure', 'payment.review', 'payment.refund', 'payment.report'];
export function can(admin, permission) {
  if (admin?.via !== 'session' || !admin.id) return false; // the shared API key never changes money settings
  return Pay.hasPermission(admin.id, permission) || Boolean(admin.email && config.payments.adminEmails.includes(String(admin.email).toLowerCase()));
}
// Administrators who currently hold a permission (database grant or bootstrap e-mail). Used so notifications reach the people who can act on them.
export const adminsWith = (permission) => Pay.allAdmins().filter((a) => can({ via: 'session', id: a.id, email: a.email }, permission)).map((a) => a.id);
export const requirePermission = (permission) => (req, _res, next) => {
  if (can(req.admin, permission)) return next();
  try { audit({ admin: req.admin, action: 'admin.access_denied', targetType: 'permission', targetId: permission, result: 'failure', reason: 'missing permission' }); } catch { /* never block the 403 */ }
  return next(fail(403, 'PERMISSION_REQUIRED', 'You do not have permission to do this.'));
};

// ================= configuration =================
const VPA = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const PLACEHOLDER = /(example|sample|dummy|placeholder|yourname|test)/i; // example UPI IDs must never become a real payment destination
export function configReadiness(c = Pay.getConfig()) {
  const missing = [];
  if (!c.upiId) missing.push('upiId'); if (!c.payeeName) missing.push('payeeName'); if (!c.instructions) missing.push('instructions'); if (!c.supportContact) missing.push('supportContact');
  return { complete: missing.length === 0, missing };
}
const adminConfigView = ({ qrFile, ...c }) => ({ ...c, qrImage: { configured: Boolean(qrFile), updatedAt: c.qrUpdatedAt }, readiness: configReadiness(c), ready: configReadiness(c).complete && c.manualEnabled });
export const getAdminConfig = () => ({ config: adminConfigView(Pay.getConfig()) });
export function updateConfig(admin, body = {}) {
  const cur = Pay.getConfig(); const errors = {}; const next = { ...cur };
  const str = (k, min, max) => { if (body[k] === undefined) return; if (body[k] === null || body[k] === '') { next[k] = null; return; } const s = clean(body[k], max + 1); if (s.length < min || s.length > max) errors[k] = `${min}–${max} characters`; else next[k] = s; };
  str('payeeName', 2, 80); str('instructions', 10, 1500); str('supportContact', 3, 200);
  if (body.upiId !== undefined) {
    if (body.upiId === null || body.upiId === '') next.upiId = null;
    else { const v = String(body.upiId).trim(); if (!VPA.test(v)) errors.upiId = 'Enter a valid UPI ID such as name@bank'; else if (PLACEHOLDER.test(v)) errors.upiId = 'This looks like an example UPI ID. Enter the official ELVORA UPI ID.'; else next.upiId = v.toLowerCase(); }
  }
  if (body.verificationHours !== undefined) { const n = Number(body.verificationHours); if (!Number.isInteger(n) || n < 1 || n > 168) errors.verificationHours = 'Whole hours between 1 and 168'; else next.verificationHours = n; }
  for (const k of ['manualEnabled', 'submissionsEnabled']) if (body[k] !== undefined) { if (typeof body[k] !== 'boolean') errors[k] = 'true or false'; else next[k] = body[k]; }
  if (next.manualEnabled && !configReadiness(next).complete) errors.manualEnabled = 'Complete the UPI ID, payee name, instructions and support contact before enabling payments.';
  if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields.', errors);
  const destinationChanged = ['upiId', 'payeeName'].filter((k) => next[k] !== cur[k]);
  if (destinationChanged.length && body.confirm !== true) throw badRequest('Changing the payment destination needs your confirmation. Students will pay the new destination.', { confirm: `Confirm the change to: ${destinationChanged.join(', ')}` });
  const changed = Object.keys(next).filter((k) => !['updatedAt', 'updatedBy', 'updatedByName', 'qrFile', 'qrUpdatedAt'].includes(k) && next[k] !== cur[k]);
  if (!changed.length) return { config: adminConfigView(cur), changed: [] };
  db.transaction(() => { Pay.saveConfig(next, admin); audit({ admin, action: 'payment.config_update', targetType: 'payment_config', targetId: '1', reason: `changed: ${changed.join(', ')}` }); })();
  return { config: adminConfigView(Pay.getConfig()), changed };
}

// ---- official QR image: PNG/JPEG only (no SVG), small, checked by file signature, stored privately under a random server-chosen name ----
const MAX_QR = 512 * 1024;
const qrKind = (b) => (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? ['png', 'image/png'] : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? ['jpg', 'image/jpeg'] : null);
const qrDir = () => path.join(path.dirname(config.payments.proofDir), 'payment-qr');
const QR_NAME = /^[a-f0-9]{32}\.(png|jpg)$/;
export function setQrImage(admin, buffer, confirm) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw badRequest('Send the QR image as the request body (Content-Type: image/png or image/jpeg).');
  if (buffer.length > MAX_QR) throw badRequest(`The QR image must be ${MAX_QR / 1024} KB or smaller.`);
  const kind = qrKind(buffer); if (!kind) throw badRequest('The QR image must be a PNG or JPEG file.');
  if (confirm !== 'true') throw badRequest('Changing the QR image changes where students pay. Confirm the change.', { confirm: 'Required' });
  const name = `${crypto.randomBytes(16).toString('hex')}.${kind[0]}`;
  fs.mkdirSync(qrDir(), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(qrDir(), name), buffer, { flag: 'wx', mode: 0o600 });
  const prev = Pay.getConfig().qrFile;
  try { db.transaction(() => { Pay.setQrFile(name, admin); audit({ admin, action: 'payment.config_update', targetType: 'payment_config', targetId: '1', reason: 'changed: qrImage' }); })(); }
  catch (e) { fs.rmSync(path.join(qrDir(), name), { force: true }); throw e; }
  if (prev && QR_NAME.test(prev)) fs.rmSync(path.join(qrDir(), prev), { force: true });
  return getAdminConfig();
}
export function readQrImage() {
  const f = Pay.getConfig().qrFile; if (!f || !QR_NAME.test(f)) throw notFound('No QR image is configured', 'NO_QR');
  const buffer = fs.readFileSync(path.join(qrDir(), f)); const k = qrKind(buffer); if (!k) throw notFound('No QR image is configured', 'NO_QR');
  return { buffer, mime: k[1] };
}

// What a STUDENT may see. Private fields (who edited, readiness internals) are never included; payee details appear only when payments are genuinely ready.
export function studentPaymentInfo() {
  const c = Pay.getConfig(); const r = configReadiness(c);
  if (!r.complete) return { state: 'not_ready', ready: false, message: 'Payments are not available yet. Please check back later or contact ELVORA support.' };
  if (!c.manualEnabled) return { state: 'disabled', ready: false, message: 'Manual UPI payments are currently unavailable.' };
  return { state: 'ready', ready: true, submissionsOpen: c.submissionsEnabled, payeeName: c.payeeName, upiId: c.upiId, instructions: c.instructions, supportContact: c.supportContact, verificationHours: c.verificationHours,
    steps: ['Open a supported UPI app.', 'Scan the displayed QR code or enter the official UPI ID.', 'Check that the payee name matches the name shown here.', 'Pay the exact amount shown.', 'Complete the transaction.', 'Return to ELVORA.', 'Submit the transaction reference (UTR) number.'],
    notice: 'Scanning the QR code or opening a UPI app does not mean ELVORA has received your payment. Your request moves forward only after an administrator verifies the transaction.',
    qrImageAvailable: Boolean(c.qrFile),
    ...(c.submissionsEnabled ? {} : { submissionsMessage: 'Payment submissions are temporarily paused. You can try again later.' }) };
}

// ================= pricing =================
const rupeesToPaise = (v) => { const s = String(v).trim(); if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null; return Math.round(Number(s) * 100); };
const priceRow = (p) => ({ priceId: p.id, durationDays: p.durationDays, months: p.months, amountPaise: p.amountPaise, display: formatInr(p.amountPaise), currency: p.currency, version: p.version });
export function activePricing() { const v = Pay.currentVersion(); return { pricingVersion: v.version, currency: 'INR', prices: Pay.versionRows(v.version).map(priceRow) }; }
export const pricingVersion = () => ({ pricingVersion: Pay.currentVersion().version });
export function adminPricing() { const v = Pay.currentVersion(); return { ...activePricing(), updatedAt: v.created_at, updatedBy: v.created_by_name, maxRupees: config.payments.maxPriceRupees, allowedDurations: [30, 60, 90] }; }
export const pricingHistory = () => ({ versions: Pay.allVersions().map((v) => ({ ...v, prices: v.prices.map(priceRow) })), changes: Pay.changesFor().map((c) => ({ ...c, previousDisplay: formatInr(c.previousPaise), newDisplay: formatInr(c.newPaise) })) });
// body: { prices: [{ durationDays: 30|60|90, amountRupees }], preview?: true, confirm?: true }. Preview never writes. A save needs confirm === true.
export function updatePricing(admin, body = {}) {
  const list = Array.isArray(body.prices) ? body.prices : null; const errors = {};
  if (!list || !list.length || list.length > 3) throw badRequest('Provide the prices to change.', { prices: 'Required' });
  const amounts = {}; const max = config.payments.maxPriceRupees * 100;
  for (const item of list) {
    const d = Number(item?.durationDays);
    if (![30, 60, 90].includes(d)) { errors.durationDays = 'Only 1-, 2- and 3-month (30, 60, 90 day) options exist; there is no 7-day paid option.'; continue; }
    if (amounts[d] !== undefined) { errors[`d${d}`] = 'Listed twice'; continue; }
    const paise = rupeesToPaise(item?.amountRupees);
    if (paise === null || paise < 100 || paise > max) errors[`d${d}`] = `Enter an amount from ₹1 to ₹${config.payments.maxPriceRupees.toLocaleString('en-IN')} with at most 2 decimals`;
    else amounts[d] = paise;
  }
  if (Object.keys(errors).length) throw badRequest('Please fix the highlighted prices.', errors);
  const cur = Object.fromEntries(Pay.versionRows(Pay.currentVersion().version).map((p) => [p.durationDays, p]));
  const changes = Object.entries(amounts).filter(([d, p]) => cur[d].amountPaise !== p).map(([d, p]) => ({ durationDays: Number(d), previous: cur[d].amountPaise, next: p, previousDisplay: formatInr(cur[d].amountPaise), nextDisplay: formatInr(p) }));
  if (body.preview === true) return { preview: true, changes, nextVersion: changes.length ? Pay.currentVersion().version + 1 : Pay.currentVersion().version, note: 'Existing orders keep the price they were created with.' };
  if (body.confirm !== true) throw badRequest('Please confirm the price change.', { confirm: 'Required' });
  if (!changes.length) throw badRequest('No price was changed.', { prices: 'No difference from the current prices' });
  const version = db.transaction(() => {
    const v = Pay.publishVersion(amounts, admin);
    audit({ admin, action: 'pricing.update', targetType: 'pricing', targetId: `v${v}`, reason: changes.map((c) => `${c.durationDays}d ${c.previous}->${c.next} paise`).join('; ') });
    return v;
  })();
  return { ...adminPricing(), version, changes };
}

// ================= payment orders =================
const expireStale = (student) => {
  for (const id of Pay.expiredAwaiting(student.id)) db.transaction(() => {
    const p = Pay.paymentById(id);
    if (!p || !Pay.setPaymentStatus(id, 'AWAITING_PAYMENT', 'EXPIRED')) return;
    Pay.addEvent(id, { event: 'expired', from: 'AWAITING_PAYMENT', to: 'EXPIRED', actor: 'system', note: 'The payment order expired before a reference was submitted.' });
    Pay.moveRequest(p.requestId, 'Awaiting Payment', 'Draft', 'Payment order expired; nothing was paid or charged.', 'system');
    audit({ admin: null, action: 'payment.order_expire', targetType: 'payment', targetId: id, actorName: 'System' });
  })();
};
export const upiIntent = (p) => `upi://pay?${new URLSearchParams({ pa: p.payeeUpiId, pn: p.payeeName, am: (p.expectedPaise / 100).toFixed(2), cu: 'INR', tn: `ELVORA ${p.id}` }).toString()}`;

const TIMELINE = [
  ['created', 'Payment order created'], ['awaiting', 'Awaiting payment'], ['submitted', 'UTR submitted'], ['review', 'Awaiting admin verification'], ['outcome', 'Payment verified or rejected'], ['refund', 'Refund'],
];
function timeline(p, events) {
  const at = (e) => events.find((x) => x.event === e)?.at ?? null; const s = p.status;
  const submitted = Boolean(p.submittedAt); const decided = ['VERIFIED', 'REJECTED', 'REFUND_PENDING', 'REFUNDED'].includes(s);
  const steps = [
    { key: 'created', label: 'Payment order created', state: 'done', at: p.createdAt },
    { key: 'awaiting', label: 'Awaiting payment', state: submitted ? 'done' : s === 'EXPIRED' ? 'failed' : 'current', at: p.createdAt, ...(s === 'EXPIRED' ? { note: 'Order expired' } : {}) },
    { key: 'submitted', label: 'UTR submitted', state: submitted ? 'done' : 'upcoming', at: p.submittedAt },
    { key: 'review', label: 'Awaiting admin verification', state: submitted && !decided ? 'current' : decided ? 'done' : 'upcoming', at: p.submittedAt, deadline: p.verificationDeadline },
    { key: 'outcome', label: s === 'REJECTED' ? 'Payment rejected' : s === 'VERIFIED' || s === 'REFUND_PENDING' || s === 'REFUNDED' ? 'Payment verified' : 'Payment verified or rejected', state: decided ? (s === 'REJECTED' ? 'failed' : 'done') : 'upcoming', at: at('verified') ?? at('rejected') },
  ];
  const rf = Pay.refundsForStudentPayment(p.id, p.studentId).filter((r) => r.status !== 'REFUND_REJECTED');
  if (rf.length) steps.push({ key: 'refund', label: rf.every((r) => r.status === 'REFUNDED') ? 'Refunded' : 'Refund in progress (not yet sent)', state: rf.every((r) => r.status === 'REFUNDED') ? 'done' : 'current', at: rf[rf.length - 1].completedAt ?? rf[rf.length - 1].requestedAt });
  else if (['REFUND_PENDING', 'REFUNDED'].includes(s)) steps.push({ key: 'refund', label: s === 'REFUNDED' ? 'Refunded' : 'Refund pending', state: s === 'REFUNDED' ? 'done' : 'current', at: at('refund') });
  return steps;
}
const refundForStudent = (r) => ({ id: r.id, status: r.status, amountPaise: r.amountPaise, amountDisplay: formatInr(r.amountPaise), requestedAt: r.requestedAt, completedAt: r.completedAt, refundReference: r.status === 'REFUNDED' ? r.refundUtr : null, rejectionReason: r.rejectionReason });
const paymentView = (p, { withEvents = true } = {}) => {
  const events = Pay.eventsFor(p.id); const sub = Pay.submissionFor(p.id);
  return { id: p.id, internalReference: p.internalReference, requestId: p.requestId, applicationId: p.applicationId, durationDays: p.durationDays, months: p.durationDays / 30, status: p.status,
    amountPaise: p.expectedPaise, amountDisplay: formatInr(p.expectedPaise), currency: p.currency, pricingVersion: p.pricingVersion,
    payeeName: p.payeeName, createdAt: p.createdAt, expiresAt: p.expiresAt, submittedAt: p.submittedAt, verificationDeadline: p.verificationDeadline,
    submission: sub ? { utr: sub.utr, paymentDate: sub.paymentDate, paymentTime: sub.paymentTime, upiApp: sub.upiApp, hasProof: Boolean(sub.proofId), proofId: sub.proofId, submittedAt: sub.submittedAt, revision: sub.revision } : null,
    submissions: Pay.submissionsFor(p.id).map((x) => ({ id: x.id, revision: x.revision, utr: x.utr, submittedAt: x.submittedAt, replacementReason: x.replacementReason, hasProof: Boolean(x.proofId), proofId: x.proofId, decision: Pay.reviewOf(x.id)?.decision ?? null })),
    ...(p.status === 'REJECTED' ? { rejection: { reason: REJECT_LABELS[p.rejectionCode] ?? 'Not accepted', note: p.rejectionCode === 'OTHER' ? p.rejectionNote : null, at: p.reviewedAt }, canResubmit: Pay.revisionCount(p.id) < MAX_REVISIONS, revisionsLeft: Math.max(0, MAX_REVISIONS - Pay.revisionCount(p.id)) } : {}),
    refunds: Pay.refundsForStudentPayment(p.id, p.studentId).map(refundForStudent),
    timeline: timeline(p, events), ...(withEvents ? { events: events.map((e) => ({ event: e.event, at: e.at, note: e.note })) } : {}),
    ...(p.status === 'PENDING_VERIFICATION' ? { message: SUBMITTED_MESSAGE } : {}) };
};

export async function createOrder(student, requestId) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 60) throw badRequest('requestId is required');
  expireStale(student);
  const info = studentPaymentInfo();
  if (!info.ready) throw fail(503, info.state === 'disabled' ? 'PAYMENTS_DISABLED' : 'PAYMENTS_NOT_READY', info.message);
  const created = db.transaction(() => {
    const req = Pay.requestRow(requestId, student.id);
    if (!req) throw notFound('Request not found', 'REQUEST_NOT_FOUND'); // another student's request looks exactly like a missing one
    const live = Pay.liveForRequest(req.id);
    if (live) return { id: live.id, created: false };
    const app = P.applicationOwned(req.application_id, student.id);
    if (!app) throw notFound('Internship application not found', 'APPLICATION_NOT_FOUND');
    if (req.status !== 'Draft') throw fail(409, 'REQUEST_NOT_PAYABLE', 'This request cannot be paid for in its current state.');
    const ev = req.instant === 1 ? { eligible: true, reasons: [] } : evaluate(student, app); // eligibility is recomputed; the client's opinion is never used. A paid 1/2/3-month plan has no completion prerequisite: its certificate follows the verified payment.
    if (!ev.eligible) throw fail(409, 'PRIORITY_NOT_ELIGIBLE', ev.reasons[0] ?? 'This internship is not eligible for priority processing.', { reasons: ev.reasons });
    const price = P.activePriceFor(app.durationDays); // the latest ACTIVE price; none exists for 7-day (or any unlisted) durations
    if (!price) throw fail(409, 'NO_PAID_OPTION', 'Priority processing is not offered for this internship duration.');
    const version = Pay.currentVersion().version;
    const cfg = Pay.getConfig();
    Pay.resnapshotRequestPrice(req.id, price);
    const id = Pay.insertPayment({ requestId: req.id, studentId: student.id, applicationId: req.application_id, enrollmentId: req.enrollment_id, durationDays: app.durationDays, expectedPaise: price.amountPaise,
      priceId: price.id, pricingVersion: version, payeeUpiId: cfg.upiId, payeeName: cfg.payeeName, expiresAt: new Date(Date.now() + config.payments.orderExpiryHours * 3600000).toISOString() });
    Pay.moveRequest(req.id, 'Draft', 'Awaiting Payment', 'Payment order created. No payment has been received.', 'student');
    Pay.addEvent(id, { event: 'created', to: 'AWAITING_PAYMENT', actor: 'student', note: `${formatInr(price.amountPaise)}, pricing v${version}` });
    studentAudit('payment.order_create', id, `request ${req.id}; ${price.amountPaise} paise; v${version}`);
    notify({ studentId: student.id, type: 'payment_order_created', title: 'Payment order created', message: 'Your priority payment order is ready. Complete the UPI payment and submit the transaction reference. Nothing is confirmed until an administrator verifies it.', applicationId: req.application_id, enrollmentId: req.enrollment_id, dedupeKey: `pay:${id}:created` });
    return { id, created: true };
  })();
  return { created: created.created, ...(await orderDetail(student, created.id)) };
}

async function orderDetail(student, id) {
  expireStale(student);
  const p = Pay.paymentOwned(id, student.id);
  if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  const out = { payment: paymentView(p) };
  if (p.status === 'AWAITING_PAYMENT') { // destination and amount come from the frozen server-side order, never from a request
    const intent = upiIntent(p);
    // QR / UPI ID consistency (Stage 10C): this order keeps the destination it was created with (the amount and payee the student was shown never change under them). If an administrator has since
    // changed the official destination, the live QR image and instructions would disagree with this order, so they are withheld and the student is told which destination applies to THIS order.
    const info = studentPaymentInfo(); const cfg = Pay.getConfig(); const changed = info.ready && (cfg.upiId !== p.payeeUpiId || cfg.payeeName !== p.payeeName);
    out.pay = { upiId: p.payeeUpiId, payeeName: p.payeeName, upiIntent: intent, qrDataUrl: await QRCode.toDataURL(intent, { errorCorrectionLevel: 'M', margin: 2, width: 320 }),
      info: changed ? { ...info, qrImageAvailable: false } : info,
      ...(changed ? { destinationChanged: true, destinationNotice: 'ELVORA’s payment destination has changed since this order was created. Pay only the UPI ID and QR code shown for this order, or contact support before paying.' } : {}) };
  }
  return out;
}
export const getPayment = (student, id) => orderDetail(student, id);
export function listPayments(student) { expireStale(student); return { payments: Pay.paymentsForStudent(student.id).map((p) => paymentView(p, { withEvents: false })) }; }
export function statusFor(student, id) { expireStale(student); const p = Pay.paymentOwned(id, student.id); if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND'); const v = paymentView(p); return { id: v.id, status: v.status, timeline: v.timeline, verificationDeadline: v.verificationDeadline, message: v.message ?? null }; }

// ================= proof upload =================
const MAGIC = [['image/png', 'png', (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))], ['image/jpeg', 'jpg', (b) => b.length > 4 && b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))], ['application/pdf', 'pdf', (b) => b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-']];
export function uploadProof(student, paymentId, buffer) {
  const p = Pay.paymentOwned(paymentId, student.id);
  if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  if (!['AWAITING_PAYMENT', 'REJECTED'].includes(p.status)) throw fail(409, 'PAYMENT_NOT_OPEN', 'Proof can only be added while the payment is awaiting your submission or a corrected reference.');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw badRequest('Attach a PNG, JPG or PDF file (up to ' + Math.floor(config.payments.maxProofBytes / 1048576) + ' MB).');
  if (buffer.length > config.payments.maxProofBytes) throw fail(413, 'PROOF_TOO_LARGE', 'The file is too large.');
  const kind = MAGIC.find(([, , test]) => test(buffer)); // content is checked, not just the declared type
  if (!kind) throw fail(415, 'PROOF_TYPE', 'Only PNG, JPG or PDF files are accepted.');
  if (Pay.stagedProofCount(p.id) >= 5 * (Pay.revisionCount(p.id) + 1)) throw fail(429, 'PROOF_LIMIT', 'Too many files were uploaded for this payment.');
  fs.mkdirSync(config.payments.proofDir, { recursive: true, mode: 0o700 });
  const fileName = `${crypto.randomBytes(16).toString('hex')}.${kind[1]}`;
  const target = path.join(config.payments.proofDir, fileName);
  fs.writeFileSync(target, buffer, { mode: 0o600, flag: 'wx' });
  let proofId;
  try { proofId = db.transaction(() => { const id = Pay.insertProof({ paymentId: p.id, studentId: student.id, fileName, mime: kind[0], size: buffer.length }); Pay.addEvent(p.id, { event: 'proof_uploaded', actor: 'student' }); studentAudit('payment.proof_upload', p.id, kind[0]); return id; })(); }
  catch (e) { fs.rmSync(target, { force: true }); throw e; } // no orphan file is left behind when the record could not be written
  return { proofId, mime: kind[0], size: buffer.length };
}
const SAFE = /^[a-f0-9]{32}\.(png|jpg|pdf)$/;
export function readProof(paymentId, proofId, studentId = null) {
  const p = studentId ? Pay.paymentOwned(paymentId, studentId) : Pay.paymentById(paymentId);
  const proof = p && typeof proofId === 'string' ? Pay.proofFor(p.id, proofId) : null;
  if (!proof || !SAFE.test(proof.fileName)) throw notFound('Proof not found', 'PROOF_NOT_FOUND');
  try { return { buffer: fs.readFileSync(path.join(config.payments.proofDir, proof.fileName)), mime: proof.mime, ext: proof.fileName.split('.').pop() }; } catch { throw notFound('Proof not found', 'PROOF_NOT_FOUND'); }
}
export function proofIdFor(paymentId) { return Pay.submissionFor(paymentId)?.proofId ?? null; }

// ================= UTR submission =================
export const normalizeUtr = (v) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
// Providers differ in length and style, so only the character set and a broad length range are enforced; obviously fake strings are refused.
export const validUtr = (u) => /^[A-Z0-9]{8,35}$/.test(u) && !/^(.)\1+$/.test(u) && !/^(0123456789|1234567890|123456789012)/.test(u);
const UPI_APPS = ['Google Pay', 'PhonePe', 'Paytm', 'BHIM', 'Amazon Pay', 'WhatsApp', 'Bank app', 'Other'];

export function submitReference(student, paymentId, body = {}) {
  expireStale(student);
  const errors = {};
  const utr = normalizeUtr(body.utr);
  if (!validUtr(utr)) errors.utr = 'Enter the transaction reference (UTR) from your UPI app: 8–35 letters or digits, no spaces or symbols.';
  const date = typeof body.paymentDate === 'string' ? body.paymentDate.trim() : ''; const time = typeof body.paymentTime === 'string' ? body.paymentTime.trim() : '';
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
  if (!dateOk) errors.paymentDate = 'Enter the payment date (YYYY-MM-DD).';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.paymentTime = 'Enter the approximate payment time (HH:MM, 24-hour).';
  const upiApp = body.upiApp ? clean(body.upiApp, 40) : null; if (upiApp && !UPI_APPS.includes(upiApp)) errors.upiApp = 'Choose one of the listed apps.';
  const note = body.note ? clean(body.note, 300) : null;
  if (body.confirmed !== true) errors.confirmed = 'Please confirm the summary before submitting.';
  if (Object.keys(errors).length) throw badRequest('Please check the highlighted fields.', errors);
  const cfg = Pay.getConfig();
  if (!configReadiness(cfg).complete || !cfg.manualEnabled) throw fail(503, 'PAYMENTS_DISABLED', 'Manual UPI payments are currently unavailable.');
  if (!cfg.submissionsEnabled) throw fail(503, 'SUBMISSIONS_PAUSED', 'Payment submissions are temporarily paused. Please try again later.');

  try { return submitTx(student, paymentId, body, { utr, date, time, upiApp, note, cfg }); }
  catch (e) { if (e?.code === 'DUPLICATE_UTR') { studentAudit('payment.duplicate_attempt', paymentId, 'utr already submitted'); notifyDuplicateAttempt(paymentId, utr); } throw e; } // written outside the rolled-back transaction
}
function submitTx(student, paymentId, body, { utr, date, time, upiApp, note, cfg }) {
  return db.transaction(() => {
    const p = Pay.paymentOwned(paymentId, student.id);
    if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
    if (body.amountPaise !== undefined && Number(body.amountPaise) !== p.expectedPaise) throw fail(400, 'PAYMENT_AMOUNT_MISMATCH', `The amount must be exactly ${formatInr(p.expectedPaise)}. It cannot be changed.`);
    if (p.status === 'REJECTED') throw fail(409, 'USE_RESUBMISSION', 'This payment was not accepted. Submit a corrected reference using the resubmission option.');
    if (p.status === 'PENDING_VERIFICATION' || p.submittedAt) throw fail(409, 'ALREADY_SUBMITTED', 'A reference has already been submitted for this payment. Contact support if it needs correcting.');
    if (p.status !== 'AWAITING_PAYMENT') throw fail(409, 'PAYMENT_NOT_OPEN', 'This payment order can no longer accept a reference.');
    const created = Date.parse(p.createdAt); const when = Date.parse(`${date}T00:00:00Z`);
    if (when < created - 2 * 86400000 || when > Date.now() + 86400000) throw badRequest('The payment date does not fit this order.', { paymentDate: 'Use the date you actually paid, on or after the order was created.' });
    if (Pay.utrTaken(utr, p.id)) { // same message whether it was this student's or someone else's: no information about other accounts
      throw fail(409, 'DUPLICATE_UTR', 'This transaction reference has already been submitted. Check the number, or contact support.');
    }
    let proofId = null;
    if (body.proofId !== undefined && body.proofId !== null && body.proofId !== '') {
      const proof = Pay.proofFor(p.id, String(body.proofId)); if (!proof || proof.studentId !== student.id || proof.linked) throw badRequest('That uploaded file cannot be used.', { proofId: 'Upload the file again' });
      proofId = proof.id;
    }
    let sub;
    try { sub = Pay.insertSubmission({ paymentId: p.id, studentId: student.id, utr, amountPaise: p.expectedPaise, paymentDate: date, paymentTime: time, upiApp, note, proofId }); }
    catch (e) { if (Pay.isConstraint(e)) throw fail(409, 'DUPLICATE_UTR', 'This transaction reference has already been submitted. Check the number, or contact support.'); throw e; }
    if (proofId) Pay.linkProof(proofId);
    const reference = `ELV-PAY-${sub.submittedAt.slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const deadline = new Date(Date.parse(sub.submittedAt) + cfg.verificationHours * 3600000).toISOString(); // a target only: nothing is auto-verified or auto-rejected at the deadline
    if (!Pay.markSubmitted(p.id, reference, sub.submittedAt, deadline)) throw fail(409, 'PAYMENT_NOT_OPEN', 'This payment order can no longer accept a reference.');
    Pay.moveRequest(p.requestId, 'Awaiting Payment', 'Payment Pending', 'Payment reference submitted by the student. Not yet verified.', 'student'); // = PAYMENT_VERIFICATION_PENDING
    Pay.addEvent(p.id, { event: 'submitted', from: 'AWAITING_PAYMENT', to: 'PENDING_VERIFICATION', actor: 'student', note: reference });
    flagDuplicates(p, sub.id, utr);
    studentAudit('payment.submit', p.id, `${reference}; ${p.expectedPaise} paise; proof ${proofId ? 'yes' : 'no'}`);
    notify({ studentId: student.id, type: 'payment_submitted', title: 'Payment details submitted', message: SUBMITTED_MESSAGE, applicationId: p.applicationId, enrollmentId: p.enrollmentId, dedupeKey: `pay:${p.id}:submitted` });
    for (const adminId of Pay.adminIds()) notify({ studentId: adminId, type: 'payment_verification_needed', title: 'Payment awaiting verification', message: `Payment ${reference} (${formatInr(p.expectedPaise)}) needs administrator verification by ${deadline.slice(0, 16).replace('T', ' ')} UTC.`, dedupeKey: `pay:${p.id}:admin` });
    return { submitted: true, message: SUBMITTED_MESSAGE, payment: paymentView(Pay.paymentById(p.id)) };
  })();
}


// A reference that already appears on another (e.g. rejected) submission is FLAGGED for the administrator. A flag is a prompt to investigate, never a verdict.
function flagDuplicates(p, submissionId, utr) {
  const others = Pay.sameUtr(utr, submissionId);
  if (!others.length) return;
  const crossStudent = others.some((o) => o.studentId !== p.studentId);
  Pay.addEvent(p.id, { event: 'duplicate_flagged', actor: 'system', note: `${others.length} other submission(s) use this reference${crossStudent ? ', including another student' : ''}. This is a warning, not proof of fraud.` });
  studentAudit('payment.duplicate_flag', p.id, `${others.length} other submission(s); cross-student ${crossStudent}`);
  for (const adminId of adminsWith('payment.review')) notify({ studentId: adminId, type: 'payment_duplicate_admin', title: 'Duplicate payment reference detected', message: `Payment ${p.internalReference ?? p.id} uses a reference already seen on ${others.length} other submission(s)${crossStudent ? ', including another student' : ''}. Investigate before deciding; this is a warning, not proof of fraud.`, dedupeKey: `pay:${p.id}:dup:${submissionId}` });
}
// A blocked duplicate attempt is also surfaced to reviewers (outside the rolled-back transaction). The key is per payment and reference, so repeated tries notify once.
function notifyDuplicateAttempt(paymentId, utr) {
  try { for (const adminId of adminsWith('payment.review')) notify({ studentId: adminId, type: 'payment_duplicate_admin', title: 'Duplicate payment reference attempted', message: `A student tried to submit a transaction reference that is already on file for payment order ${paymentId}. The submission was blocked.`, dedupeKey: `pay:${paymentId}:dupattempt:${utr}` }); } catch { /* never block the student's error */ }
}

// ================= audited resubmission =================
// Only a REJECTED payment whose request is still waiting for payment may take a corrected reference. The original submission, its proof and the administrator's
// decision stay exactly as they were; the new reference is stored as the next revision and linked to the one it replaces.
export function resubmitReference(student, paymentId, body = {}) {
  expireStale(student);
  const errors = {};
  const utr = normalizeUtr(body.utr);
  if (!validUtr(utr)) errors.utr = 'Enter the transaction reference (UTR) from your UPI app: 8–35 letters or digits, no spaces or symbols.';
  const date = typeof body.paymentDate === 'string' ? body.paymentDate.trim() : ''; const time = typeof body.paymentTime === 'string' ? body.paymentTime.trim() : '';
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
  if (!dateOk) errors.paymentDate = 'Enter the payment date (YYYY-MM-DD).';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.paymentTime = 'Enter the approximate payment time (HH:MM, 24-hour).';
  const upiApp = body.upiApp ? clean(body.upiApp, 40) : null; if (upiApp && !UPI_APPS.includes(upiApp)) errors.upiApp = 'Choose one of the listed apps.';
  const note = body.note ? clean(body.note, 300) : null;
  const reason = clean(body.reason, 300); if (reason.length < 10) errors.reason = 'Explain why you are submitting a correction (10–300 characters).';
  if (body.confirmed !== true) errors.confirmed = 'Please confirm the summary before submitting.';
  if (Object.keys(errors).length) throw badRequest('Please check the highlighted fields.', errors);
  const cfg = Pay.getConfig();
  if (!configReadiness(cfg).complete || !cfg.manualEnabled) throw fail(503, 'PAYMENTS_DISABLED', 'Manual UPI payments are currently unavailable.');
  if (!cfg.submissionsEnabled) throw fail(503, 'SUBMISSIONS_PAUSED', 'Payment submissions are temporarily paused. Please try again later.');
  try {
    return db.transaction(() => {
      const p = Pay.paymentOwned(paymentId, student.id); // another student's payment looks exactly like a missing one
      if (!p) throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
      if (body.amountPaise !== undefined && Number(body.amountPaise) !== p.expectedPaise) throw fail(400, 'PAYMENT_AMOUNT_MISMATCH', `The amount must be exactly ${formatInr(p.expectedPaise)}. It cannot be changed.`);
      if (['VERIFIED', 'REFUND_PENDING', 'REFUNDED'].includes(p.status)) throw fail(409, 'PAYMENT_VERIFIED', 'A verified payment cannot be changed.');
      if (p.status !== 'REJECTED') throw fail(409, 'NOT_REJECTED', 'A corrected reference can only be submitted for a payment that was not accepted.');
      const reqRow = Pay.requestRow(p.requestId, student.id);
      if (!reqRow || reqRow.status !== 'Awaiting Payment') throw fail(409, 'REQUEST_NOT_PAYABLE', 'This request can no longer accept a corrected payment reference.');
      const count = Pay.revisionCount(p.id);
      if (count >= MAX_REVISIONS) throw fail(409, 'RESUBMISSION_LIMIT', 'The number of corrections allowed for this payment has been reached. Contact support.');
      const prev = Pay.submissionFor(p.id); const prevReview = Pay.reviewOf(prev.id);
      if (!prevReview || prevReview.decision !== 'REJECTED') throw fail(409, 'NOT_REJECTED', 'The previous submission has not been rejected.');
      if (Pay.utrTaken(utr, p.id)) throw fail(409, 'DUPLICATE_UTR', 'This transaction reference has already been submitted. Check the number, or contact support.');
      const reused = Pay.submissionsFor(p.id).some((x) => x.utr === utr); // the same reference again is only useful when the problem was the evidence, not the reference
      if (reused && !['INSUFFICIENT_EVIDENCE', 'OTHER'].includes(prevReview.reasonCode)) throw badRequest('Enter a different reference: the one you sent before was not accepted.', { utr: 'Use the corrected reference' });
      const when = Date.parse(`${date}T00:00:00Z`);
      if (when < Date.parse(p.createdAt) - 2 * 86400000 || when > Date.now() + 86400000) throw badRequest('The payment date does not fit this order.', { paymentDate: 'Use the date you actually paid, on or after the order was created.' });
      let proofId = null;
      if (body.proofId !== undefined && body.proofId !== null && body.proofId !== '') {
        const proof = Pay.proofFor(p.id, String(body.proofId)); if (!proof || proof.studentId !== student.id || proof.linked) throw badRequest('That uploaded file cannot be used.', { proofId: 'Upload the file again' });
        proofId = proof.id;
      }
      let sub;
      try { sub = Pay.insertSubmission({ paymentId: p.id, studentId: student.id, utr, amountPaise: p.expectedPaise, paymentDate: date, paymentTime: time, upiApp, note, proofId, revision: count + 1, previousSubmissionId: prev.id, replacementReason: reason }); }
      catch (e) { if (Pay.isConstraint(e)) throw fail(409, 'DUPLICATE_UTR', 'This transaction reference has already been submitted. Check the number, or contact support.'); throw e; }
      if (proofId) Pay.linkProof(proofId);
      const deadline = new Date(Date.parse(sub.submittedAt) + cfg.verificationHours * 3600000).toISOString();
      if (!Pay.markResubmitted(p.id, sub.submittedAt, deadline)) throw fail(409, 'PAYMENT_NOT_OPEN', 'This payment can no longer accept a corrected reference.');
      if (!Pay.moveRequest(p.requestId, 'Awaiting Payment', 'Payment Pending', `Corrected payment reference (revision ${count + 1}) submitted by the student. Not yet verified.`, 'student')) throw fail(409, 'REQUEST_NOT_PAYABLE', 'This request can no longer accept a corrected payment reference.');
      Pay.addEvent(p.id, { event: 'resubmitted', from: 'REJECTED', to: 'PENDING_VERIFICATION', actor: 'student', note: `revision ${count + 1} replaces ${prev.id}: ${reason}` });
      flagDuplicates(p, sub.id, utr);
      studentAudit('payment.resubmit', p.id, `revision ${count + 1}; replaces ${prev.id}; proof ${proofId ? 'yes' : 'no'}`);
      notify({ studentId: student.id, type: 'payment_resubmitted', title: 'Corrected payment details submitted', message: SUBMITTED_MESSAGE, applicationId: p.applicationId, enrollmentId: p.enrollmentId, dedupeKey: `pay:${p.id}:resubmitted:${count + 1}` });
      for (const adminId of Pay.adminIds()) notify({ studentId: adminId, type: 'payment_resubmitted_admin', title: 'Corrected payment awaiting verification', message: `A corrected reference (revision ${count + 1}) for payment ${p.internalReference} needs administrator verification.`, dedupeKey: `pay:${p.id}:admin:${count + 1}` });
      return { submitted: true, revision: count + 1, message: SUBMITTED_MESSAGE, payment: paymentView(Pay.paymentById(p.id)) };
    })();
  } catch (e) { if (e?.code === 'DUPLICATE_UTR') { studentAudit('payment.duplicate_attempt', paymentId, 'utr already submitted (resubmission)'); notifyDuplicateAttempt(paymentId, utr); } throw e; }
}
