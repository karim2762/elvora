import { db } from '../db/index.js';
import * as A from '../db/priorityAdmin.js';
import * as P from '../db/priority.js';
import * as students from '../db/students.js';
import * as enrollments from '../db/enrollments.js';
import * as documentsDb from '../db/documents.js';
import * as audit from '../db/audit.js';
import { insert as notify } from '../db/notifications.js';
import { evaluate } from './priorityCertificate.js';
import { completionEvaluation } from './completionEligibility.js';
import { issueGenerated, toAdminDocument } from '../documents/issuance.js';
import { HttpError, badRequest, notFound } from '../utils/errors.js';

// Stage 10A Part 2 — administrator management of priority certificate requests. Nothing here completes an internship, edits a date, takes a payment or
// trusts a client-sent status/eligibility: every transition is validated here, eligibility is recomputed by the same Part 1 engine, and issuing goes
// through the existing Stage 06 generator.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const PAYMENT_STATUSES = ['Awaiting Payment', 'Payment Pending', 'Payment Verified', 'Refunded'];
// Administrator transitions. Payment statuses are Stage 10B placeholders: no admin transition leads into or out of them here, and a payment status never counts as completion.
// 'Certificate Issued' is reachable only through issueCertificate() (it must actually generate the document).
export const ADMIN_TRANSITIONS = Object.freeze({
  Draft: ['Eligibility Check', 'Rejected', 'Cancelled'],
  'Payment Verified': ['Eligibility Check'], // Stage 10B Part 2A: a verified payment enters the normal eligibility review; it does not approve or issue anything
  'Eligibility Check': ['Under Review', 'Correction Required', 'Rejected', 'Cancelled'],
  'Under Review': ['Approved for Issuance', 'Correction Required', 'Rejected', 'Cancelled'],
  'Correction Required': ['Eligibility Check', 'Rejected', 'Cancelled'],
  'Approved for Issuance': ['Under Review', 'Rejected', 'Cancelled'],
});
const NEEDS_REASON = ['Rejected', 'Correction Required', 'Cancelled'];
const NEEDS_ELIGIBLE = ['Under Review', 'Approved for Issuance'];
const text = (v, min, max, field) => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (s.length < min || s.length > max) throw badRequest(min ? `${field} must be ${min}–${max} characters.` : `${field} is too long.`, { [field]: `Required, ${min}–${max} characters` });
  return s;
};
const roleOf = (admin) => (admin?.via === 'session' ? 'admin' : 'key');

// Student notifications are in-app (the existing notifications table). Wording is generic: no reasons, dates, scores or other students' data.
// dedupeKey makes a retried action unable to notify twice; the notification event itself is audited.
export function notifyStudent({ admin = null, studentId, request = null, type, title, message, dedupeKey, documentId = null }) {
  const created = notify({ studentId, type, title, message, applicationId: request?.applicationId ?? null, enrollmentId: request?.enrollmentId ?? null, documentId, dedupeKey });
  if (created) audit.record({ admin, action: 'priority.notify', targetType: request ? 'priority' : 'student', targetId: request?.id ?? studentId, reason: `${type}${documentId ? `; doc ${documentId}` : ''}` });
  return created;
}
const STATUS_NOTICE = {
  'Eligibility Check': ['priority_review_done', 'Eligibility review completed', 'ELVORA has completed the eligibility review of your priority request. Open the priority portal to see its status.'],
  'Under Review': ['priority_review_done', 'Your priority request is under review', 'Your priority request is now under administrative review.'],
  'Correction Required': ['priority_info_needed', 'Additional information required', 'ELVORA needs more information for your priority request. Open the priority portal for details.'],
  Rejected: ['priority_rejected', 'Your priority request was not approved', 'Your priority request was not approved. Open the priority portal to see the reason.'],
  'Approved for Issuance': ['priority_approved', 'Your priority request is approved', 'Your priority request has been approved for issuance.'],
  Cancelled: ['priority_cancelled', 'Your priority request was cancelled', 'Your priority request was cancelled. Open the priority portal for details.'],
};

// ---------- list / detail ----------
export function listRequests(query = {}) {
  const errors = {}; const one = (k) => (typeof query[k] === 'string' && query[k].trim() !== '' && query[k] !== 'All' ? query[k].trim().slice(0, 80) : null);
  const status = one('status'); const from = one('from'); const to = one('to'); const dur = one('durationDays');
  if (status && !A.REQUEST_STATUSES.includes(status)) errors.status = 'Unknown status';
  if (from && !validDate(from)) errors.from = 'Use a date like 2026-11-21';
  if (to && !validDate(to)) errors.to = 'Use a date like 2026-11-21';
  if (from && to && !errors.from && !errors.to && from > to) errors.to = 'The end date can’t be before the start date';
  if (dur && ![30, 60, 90].includes(Number(dur))) errors.durationDays = 'Use 30, 60 or 90';
  const num = (k, d, min, max) => { const v = query[k]; if (v === undefined || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) { errors[k] = `Use a whole number from ${min} to ${max}`; return d; } return n; };
  const pageSize = num('pageSize', 25, 1, 100); const wanted = num('page', 1, 1, 100000);
  if (Object.keys(errors).length) throw badRequest('Invalid filter', errors);
  const f = { student: one('student'), applicationId: one('applicationId'), requestId: one('requestId'), durationDays: dur ? Number(dur) : null, status, from, to };
  const total = A.pageRequests({ ...f, limit: 1, offset: 0 }).total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize)); const page = Math.min(wanted, totalPages);
  const { rows } = A.pageRequests({ ...f, limit: pageSize, offset: (page - 1) * pageSize });
  return { requests: rows.map((r) => ({ ...r, kind: 'priority', paymentState: r.paid ? 'paid' : 'unpaid', free: false })), pagination: { page, pageSize, total, totalPages }, filters: { statuses: A.REQUEST_STATUSES, durations: [30, 60, 90] }, counts: A.countsByStatus() };
}

function loadContext(id) {
  const req = A.requestById(id);
  if (!req) throw notFound('Request not found', 'REQUEST_NOT_FOUND');
  const student = students.findById(req.studentId);
  const app = P.applicationOwned(req.applicationId, req.studentId); // the application must still belong to the request's student
  if (!student || !app) throw new HttpError(409, 'The records behind this request no longer match.', { code: 'RECORD_MISMATCH' });
  return { req, student, app };
}

// Student data an administrator reviewing a request needs — no e-mail, phone, password hash or links.
const studentView = (s) => ({ id: s.id, fullName: s.fullName, college: s.college, degree: s.degree, branch: s.branch, academicYear: s.academicYear, graduationYear: s.graduationYear });

export function getRequest(id) {
  const { req, student, app } = loadContext(id);
  const ev = evaluate(student, app);
  const enrollment = enrollments.findById(req.enrollmentId);
  const docs = enrollment ? documentsDb.listForAdmin({ enrollmentId: enrollment.id, limit: 20 }).map((d) => ({ ...toAdminDocument(d), replacedBy: A.replacementOf(d.id)?.id ?? null, replaces: A.replacedFrom(d.id)?.id ?? null })) : [];
  const completion = enrollment ? completionEvaluation(enrollment.id) : null;
  const pendingProjects = enrollment ? db.prepare(`SELECT COUNT(*) AS n FROM student_tasks WHERE enrollment_id = ? AND project_status = 'Under Review'`).get(enrollment.id)?.n ?? 0 : 0;
  const allowed = ADMIN_TRANSITIONS[req.status] ?? [];
  return {
    request: { ...req, kind: 'priority', paymentState: req.paid ? 'paid' : 'unpaid', free: false },
    student: studentView(student),
    application: { applicationId: app.applicationId, internshipTitle: app.title, category: app.category, durationDays: app.durationDays, applicationStatus: app.applicationStatus },
    actual: enrollment ? { status: enrollment.status, startDate: enrollment.startDate, expectedEndDate: enrollment.expectedEndDate, completedAt: enrollment.completedAt, certificateDecision: enrollment.certificateReview.decision } : null,
    eligibility: { state: ev.state, eligible: ev.eligible, reasons: ev.reasons, checks: ev.checks, outstanding: ev.checks.filter((c) => !c.passed).map((c) => c.reason ?? c.label) },
    completionEvidence: completion && { taskProgress: completion.taskProgress, checks: completion.checks, taskRequirementsMet: completion.taskRequirementsMet, projectSubmissionsAwaitingEvaluation: pendingProjects },
    documents: docs,
    previousChecks: A.lastChecks(req.id, req.studentId, req.enrollmentId),
    history: A.historyFor(req.id), notes: A.notesFor(req.id),
    audit: audit.forTarget('priority', req.id, 50),
    allowedTransitions: allowed.map((t) => ({ to: t, needsReason: NEEDS_REASON.includes(t) || t === 'Approved for Issuance', needsEligibility: NEEDS_ELIGIBLE.includes(t) })),
    canIssue: req.status === 'Approved for Issuance',
    notice: 'Payment statuses are not managed in this release. Payment never counts as internship completion; a certificate is only issued when every completion check genuinely passes.',
  };
}

// ---------- eligibility review ----------
export function reviewEligibility(admin, id) {
  return db.transaction(() => {
    const { req, student, app } = loadContext(id);
    const ev = evaluate(student, app);
    const checkId = P.insertCheck({ studentId: req.studentId, applicationId: req.applicationId, enrollmentId: ev.enrollmentId, state: ev.state, eligible: ev.eligible, reasons: ev.reasons, checks: ev.checks });
    audit.record({ admin, action: 'priority.eligibility_review', targetType: 'priority', targetId: id, reason: `${ev.state}; check ${checkId}` });
    let moved = false;
    if (['Draft', 'Payment Verified'].includes(req.status) && A.setStatus(id, { from: req.status, to: 'Eligibility Check', note: 'Eligibility review completed by ELVORA.' })) {
      moved = true;
      audit.record({ admin, action: 'priority.status_change', targetType: 'priority', targetId: id, reason: `${req.status} → Eligibility Check` });
    }
    if (moved || req.status === 'Eligibility Check') notifyStudent({ admin, studentId: req.studentId, request: req, type: 'priority_review_done', title: STATUS_NOTICE['Eligibility Check'][1], message: STATUS_NOTICE['Eligibility Check'][2], dedupeKey: `prio:${id}:review:${checkId}` });
    return { checkId, state: ev.state, eligible: ev.eligible, reasons: ev.reasons, checks: ev.checks, request: A.requestById(id) };
  })();
}

// ---------- status changes ----------
export function changeStatus(admin, id, body) {
  const to = body?.to;
  if (typeof to !== 'string' || !A.REQUEST_STATUSES.includes(to)) throw badRequest('Choose a valid status.', { to: 'Unknown status' });
  if (PAYMENT_STATUSES.includes(to)) throw new HttpError(409, 'Payment statuses are not managed in this release.', { code: 'PAYMENT_STAGE_NOT_AVAILABLE' });
  if (to === 'Certificate Issued') throw new HttpError(409, 'A request becomes Certificate Issued only when the certificate is issued.', { code: 'USE_ISSUE_ACTION' });
  const reason = NEEDS_REASON.includes(to) ? text(body?.reason, 10, 500, 'reason') : (typeof body?.reason === 'string' && body.reason.trim() ? text(body.reason, 0, 500, 'reason') : null);
  const note = to === 'Approved for Issuance' ? text(body?.note ?? body?.reason, 10, 500, 'note') : null;
  return db.transaction(() => {
    const { req, student, app } = loadContext(id);
    if (!(ADMIN_TRANSITIONS[req.status] ?? []).includes(to)) throw new HttpError(409, `A request in “${req.status}” can’t be moved to “${to}”.`, { code: 'INVALID_TRANSITION' });
    if (NEEDS_ELIGIBLE.includes(to)) {
      const ev = evaluate(student, app); // recomputed now; a stale or client-claimed result is never used
      P.insertCheck({ studentId: req.studentId, applicationId: req.applicationId, enrollmentId: ev.enrollmentId, state: ev.state, eligible: ev.eligible, reasons: ev.reasons, checks: ev.checks });
      if (!ev.eligible) throw new HttpError(409, ev.reasons[0] ?? 'The completion requirements are not met.', { code: 'NOT_ELIGIBLE', details: { state: ev.state, reasons: ev.reasons } });
    }
    if (!A.setStatus(id, { from: req.status, to, note: reason ?? note })) throw new HttpError(409, 'The request was changed by someone else. Reload and try again.', { code: 'STALE_STATUS' });
    if (note) A.addNote(id, { adminId: admin.id, adminName: admin.fullName ?? 'Administrator', note: `Approval evidence: ${note}` });
    audit.record({ admin, action: 'priority.status_change', targetType: 'priority', targetId: id, reason: `${req.status} → ${to}${reason ? `: ${reason}` : ''}` });
    if (to === 'Approved for Issuance') audit.record({ admin, action: 'priority.approve', targetType: 'priority', targetId: id, reason: note });
    if (to === 'Rejected') audit.record({ admin, action: 'priority.reject', targetType: 'priority', targetId: id, reason });
    const n = STATUS_NOTICE[to];
    if (n) notifyStudent({ admin, studentId: req.studentId, request: req, type: n[0], title: n[1], message: n[2], dedupeKey: `prio:${id}:to:${to}:${A.historyFor(id).length}` });
    return { request: A.requestById(id) };
  })();
}

export function addAdminNote(admin, id, body) {
  const note = text(body?.note, 3, 1000, 'note');
  return db.transaction(() => {
    if (!A.requestById(id)) throw notFound('Request not found', 'REQUEST_NOT_FOUND');
    A.addNote(id, { adminId: admin.id, adminName: admin.fullName ?? 'Administrator', note });
    audit.record({ admin, action: 'priority.note_add', targetType: 'priority', targetId: id, reason: `${roleOf(admin)} note` });
    return { notes: A.notesFor(id) };
  })();
}

// ---------- issue ----------
// Uses the existing Stage 06 generator. It refuses unless the internship is genuinely completed, tasks approved and the certificate approved by an administrator.
export async function issueCertificate(admin, id) {
  const { req, student, app } = loadContext(id);
  if (req.status !== 'Approved for Issuance') throw new HttpError(409, 'Only a request approved for issuance can be issued.', { code: 'INVALID_TRANSITION' });
  const ev = evaluate(student, app);
  if (!ev.eligible) throw new HttpError(409, ev.reasons[0] ?? 'The completion requirements are not met.', { code: 'NOT_ELIGIBLE', details: { state: ev.state, reasons: ev.reasons } });
  const doc = await issueGenerated({ type: 'certificate', enrollmentId: req.enrollmentId, issuedBy: admin.fullName ?? 'Administrator', admin });
  return db.transaction(() => {
    if (!A.setStatus(id, { from: 'Approved for Issuance', to: 'Certificate Issued', note: 'Certificate issued.', documentId: doc.id })) throw new HttpError(409, 'The request was changed by someone else.', { code: 'STALE_STATUS' });
    audit.record({ admin, action: 'priority.issue', targetType: 'priority', targetId: id, reason: `doc ${doc.id}` });
    notifyStudent({ admin, studentId: req.studentId, request: req, type: 'priority_issued', title: 'Your certificate has been issued', message: 'Your priority request is complete and your certificate is available in Documents.', dedupeKey: `prio:${id}:issued`, documentId: doc.id });
    return { request: A.requestById(id), document: { id: doc.id, documentNumber: doc.documentNumber, status: doc.status } };
  })();
}
