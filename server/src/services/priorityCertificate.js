import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import * as P from '../db/priority.js';
import * as enrollments from '../db/enrollments.js';
import * as documentsDb from '../db/documents.js';
import { record as audit } from '../db/audit.js';
import { insert as notify } from '../db/notifications.js';
import { newToken, hashToken } from '../auth/tokens.js';
import { evaluateTasks } from './completionEligibility.js';
import { checkEligibility } from '../documents/eligibility.js';
import * as Pay from '../db/payments.js';
import { HttpError, badRequest, notFound } from '../utils/errors.js';
import { toPublicStudent } from '../utils/profile.js';

// Stage 10A Part 1 — private Priority Certificate Processing. Nothing here completes an internship, changes a date, takes a payment or issues a certificate:
// it only READS the existing Stage 05/09/06 records and stores a draft request. Eligibility is always recomputed here; no client value is trusted.

export const SERVICE_NOTICE = [
  'This is a private certificate-processing service. Priority processing is optional.',
  'The fee is for optional priority administrative processing. It is not payment for an academic qualification or for internship completion.',
  'A certificate can only be issued after every required internship completion and evaluation check has genuinely been satisfied.',
  'Enrolling or paying does not establish internship completion.',
  'Corrections caused by an ELVORA administrative error are free.',
  'Standard internship applications remain free.',
];
const actorAudit = (action, id, reason) => audit({ admin: null, action, targetType: 'priority', targetId: id, reason, actorName: 'Student (priority)' });

// ---------------- pricing ----------------
export const formatInr = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const priceView = (p) => ({ priceId: p.id, durationDays: p.durationDays, months: p.months, amountPaise: p.amountPaise, display: formatInr(p.amountPaise), currency: p.currency, taxNote: p.taxNote });
export const getPricing = () => ({ pricingVersion: Pay.currentVersion().version, prices: P.activePrices().filter((p) => [30, 60, 90].includes(p.durationDays)).map(priceView), notes: ['Plans are 1, 2 or 3 months.', 'Fees are set by the server and cannot be changed by the request.', 'No GST invoice is generated and no GST is claimed to be collected by this stage.'] });

// ---------------- invitations ----------------
// Called by scripts/create-priority-invite.mjs and tests (an administrator tool is Part 2). Returns the plaintext token ONCE; only its HMAC is stored.
export function createInvitation({ studentId = null, expiresInDays = 14, maxUses = 1, createdBy = 'script' } = {}) {
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) throw badRequest('expiresInDays must be 1–90');
  const token = newToken(); const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  const id = P.insertInvitation({ tokenHash: hashToken(token), studentId, maxUses, expiresAt, createdBy });
  audit({ admin: null, action: 'priority.invite_create', targetType: 'priority_invitation', targetId: id, reason: studentId ? 'bound to a student' : 'unbound', actorName: createdBy });
  return { id, token, expiresAt };
}
export function revokeInvitation(id) { const n = P.revokeInvitation(id); if (n) audit({ admin: null, action: 'priority.invite_revoke', targetType: 'priority_invitation', targetId: id }); return n > 0; }

const accessFail = (status, code, message) => new HttpError(status, message, { code });
// Access = this student has redeemed an invitation that is still valid. A revoked or expired invitation ends access.
export function accessState(student) {
  if (config.priorityPublicAccess) return { granted: true, state: 'granted' }; // open to every signed-in student; eligibility and payment checks still apply
  const invs = P.invitationsRedeemedBy(student.id);
  if (!invs.length) return { granted: false, state: 'invitation_required', message: 'This private service is available by invitation only. Open your invitation link while signed in.' };
  const nowIso = new Date().toISOString();
  if (invs.some((i) => !i.revokedAt && i.expiresAt > nowIso)) return { granted: true, state: 'granted' };
  if (invs.every((i) => i.revokedAt)) return { granted: false, state: 'revoked', message: 'Your access invitation has been revoked.' };
  return { granted: false, state: 'expired', message: 'Your access invitation has expired. Please ask ELVORA for a new one.' };
}
export function requireAccess(student) {
  const a = accessState(student);
  if (!a.granted) throw accessFail(403, `PRIORITY_${a.state.toUpperCase()}`, a.message);
}
export function redeem(student, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw accessFail(403, 'PRIORITY_INVITATION_INVALID', 'This invitation link is not valid.');
  const inv = P.findInvitationByHash(hashToken(token));
  // One generic answer for unknown and for someone else's bound invitation, so tokens can't be probed.
  if (!inv || (inv.studentId && inv.studentId !== student.id)) throw accessFail(403, 'PRIORITY_INVITATION_INVALID', 'This invitation link is not valid for this account.');
  if (inv.revokedAt) throw accessFail(403, 'PRIORITY_REVOKED', 'This invitation has been revoked.');
  if (inv.expiresAt <= new Date().toISOString()) throw accessFail(403, 'PRIORITY_EXPIRED', 'This invitation has expired. Please ask ELVORA for a new one.');
  if (inv.redeemedBy === student.id) return accessState(student); // the same student re-opening their link is harmless
  if (inv.useCount >= inv.maxUses) throw accessFail(403, 'PRIORITY_INVITATION_USED', 'This invitation has already been used.');
  const changed = db.transaction(() => { const n = P.redeemInvitation(inv.id, student.id); if (n) audit({ admin: null, action: 'priority.invite_redeem', targetType: 'priority_invitation', targetId: inv.id, actorName: 'Student (priority)' }); return n; })();
  if (!changed) throw accessFail(403, 'PRIORITY_INVITATION_USED', 'This invitation can no longer be used.');
  return accessState(student);
}

// ---------------- eligibility ----------------
const OPEN_BLOCK = ['Correction Required'];
const dayNum = (d) => Math.floor(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 86400000);

// Pure evaluation of ONE student-owned application. Returns { state, eligible, reasons[], checks[] }.
// state: eligible | ineligible | pending_evaluation | existing_certificate | pending_correction
export function evaluate(student, app) {
  const checks = []; const reasons = [];
  const add = (key, label, passed, reason, pending = false) => { checks.push({ key, label, passed, ...(passed ? {} : { reason }) }); if (!passed) reasons.push({ key, message: reason, pending }); };
  let state = 'ineligible'; let enrollment = null; let price = null;
  const fin = () => {
    if (!reasons.length) state = 'eligible';
    return { state, eligible: state === 'eligible', reasons: reasons.map((r) => r.message), checks, enrollmentId: enrollment?.id ?? null, price: price ? priceView(price) : null };
  };
  add('owner', 'Application belongs to you', true);
  price = P.activePriceFor(app.durationDays);
  add('duration', 'Priority option offered for this duration', Boolean(price),
    app.durationDays === 7 ? 'Priority processing is not offered for 7-day internships.' : 'Priority processing is not offered for this internship duration.');
  add('approved', 'Application approved', app.applicationStatus === 'Approved', 'Your internship application is not approved.');
  if (app.applicationStatus !== 'Approved' || !app.enrollmentId) {
    if (app.applicationStatus === 'Approved') add('record', 'Internship record exists', false, 'ELVORA has not created your internship record yet.');
    return fin();
  }
  enrollment = enrollments.findById(app.enrollmentId);
  if (!enrollment || enrollment.studentId !== student.id || enrollment.applicationId !== app.applicationId) { add('record', 'Internship record exists', false, 'Your internship record could not be verified.'); enrollment = null; return fin(); }
  add('started', 'Internship has started', !['Awaiting Start'].includes(enrollment.status), 'The internship has not started.');
  add('not_closed', 'Internship is not cancelled or suspended', !['Cancelled', 'Suspended'].includes(enrollment.status), `The internship is ${String(enrollment.status).toLowerCase()}.`);
  if (enrollment.status === 'Active') add('in_progress', 'Internship finished', false, 'The internship is still in progress.');
  add('dates', 'Start and end dates recorded', Boolean(enrollment.startDate && enrollment.expectedEndDate), 'The internship start or end date has not been recorded.');
  const completed = enrollment.status === 'Completed' && Boolean(enrollment.completedAt);
  if (enrollment.status === 'Completed' && !enrollment.completedAt) add('completion', 'Completion recorded', false, 'Internship completion has not been approved.');
  if (completed && enrollment.startDate) {
    const days = dayNum(enrollment.completedAt) - dayNum(enrollment.startDate) + 1;
    add('duration_served', 'Required duration completed', days >= app.durationDays, `The required internship duration (${app.durationDays} days) has not been completed (${Math.max(days, 0)} recorded).`);
  }
  if (completed) {
    const t = evaluateTasks(enrollment);
    const failing = t.checks.filter((c) => c.blocking);
    add('tasks', 'Required tasks approved', failing.length === 0, 'Required tasks are pending.', true);
    add('evaluation', 'No project evaluation pending', !(t.progress.awaitingReview > 0), 'Project evaluation is pending.', true);
    if (enrollment.certificateReview.decision === 'Declined') add('review', 'No administrative hold', false, 'An existing document requires administrative review.');
    // Final cross-check through the SAME rule the certificate generator uses (Stage 06), never a copy of it.
    const existing = documentsDb.findByEnrollmentAndType(enrollment.id, 'certificate');
    const gate = { blocking: t.blocking, message: failing.map((c) => c.detail).join(' ') };
    const issuance = checkEligibility({ type: 'certificate', enrollment, existing: null, strict: true, taskGate: gate });
    add('issuance_rules', 'Meets certificate issuance rules', issuance.eligible || issuance.code === 'CERTIFICATE_NOT_APPROVED', issuance.message);
    if (existing || enrollment.certificate) { add('existing', 'No certificate already issued', false, 'A certificate already exists for this internship.'); state = 'existing_certificate'; return { ...fin(), state }; }
  } else if (enrollment.status !== 'Awaiting Start') {
    if (enrollment.status === 'Active') { /* reason added above */ } else if (enrollment.status === 'Completed') { /* handled */ }
  }
  const open = P.openRequestForEnrollment(enrollment.id, student.id);
  if (open && OPEN_BLOCK.includes(open.status)) { add('correction', 'No pending correction', false, 'A correction or replacement request is pending administrative review.'); state = 'pending_correction'; return { ...fin(), state }; }
  const r = fin();
  if (r.state !== 'eligible' && reasons.length && reasons.every((x) => x.pending)) r.state = 'pending_evaluation';
  return r;
}

const recordCheck = (student, app, result) => P.insertCheck({ studentId: student.id, applicationId: app.applicationId, enrollmentId: result.enrollmentId, state: result.state, eligible: result.eligible, reasons: result.reasons, checks: result.checks });
const ownedApp = (student, applicationId) => {
  if (typeof applicationId !== 'string' || !applicationId || applicationId.length > 60) throw badRequest('applicationId is required');
  const app = P.applicationOwned(applicationId, student.id);
  if (!app) throw notFound('Internship application not found', 'APPLICATION_NOT_FOUND'); // another student's ID looks exactly like a missing one
  return app;
};

const detailView = (student, app) => {
  const r = evaluate(student, app); const e = r.enrollmentId ? enrollments.findById(r.enrollmentId) : null;
  return { applicationId: app.applicationId, internship: { id: app.internshipId, title: app.title, category: app.category, durationDays: app.durationDays },
    actual: e ? { status: e.status, startDate: e.startDate, expectedEndDate: e.expectedEndDate, completedAt: e.completedAt } : null,
    eligibility: { state: r.state, eligible: r.eligible, reasons: r.reasons, checks: r.checks }, price: r.price };
};
export const listOptions = (student) => ({ options: P.applicationsForStudent(student.id).map((a) => detailView(student, a)), notice: SERVICE_NOTICE });
export const internshipDetail = (student, applicationId) => detailView(student, ownedApp(student, applicationId));
export const identity = (student) => { const p = toPublicStudent(student); return { fullName: p.fullName, email: p.email, college: p.college, degree: p.degree, branch: p.branch, academicYear: p.academicYear, graduationYear: p.graduationYear }; };

export function checkEligibilityFor(student, applicationId) {
  const app = ownedApp(student, applicationId); const r = evaluate(student, app); const checkId = recordCheck(student, app, r);
  return { checkId, applicationId, state: r.state, eligible: r.eligible, reasons: r.reasons, checks: r.checks, price: r.price, checkedAt: new Date().toISOString() };
}

// ---------------- requests ----------------
// Eligibility is recomputed inside the transaction. The fee comes ONLY from the server price list; body.fee/amount are never read.
export function createDraft(student, body) {
  const app = ownedApp(student, body?.applicationId);
  const personal = body?.confirmPersonal === true; const academic = body?.confirmAcademic === true;
  if (!personal || !academic) throw badRequest('Please confirm your personal and academic information.', { confirmPersonal: personal ? undefined : 'Required', confirmAcademic: academic ? undefined : 'Required' });
  return db.transaction(() => {
    const r = evaluate(student, app); const checkId = recordCheck(student, app, r);
    if (!r.eligible) throw new HttpError(409, r.reasons[0] ?? 'This internship is not eligible for priority processing.', { code: 'PRIORITY_NOT_ELIGIBLE', details: { state: r.state, reasons: r.reasons } });
    const existing = P.openRequestForEnrollment(r.enrollmentId, student.id);
    if (existing) {
      if (existing.status === 'Draft') P.updateDraftConfirmations(existing.id, student.id, { personal, academic, checkId });
      return { created: false, request: requestView(student, existing.id) };
    }
    const price = P.activePriceFor(app.durationDays);
    const id = P.insertDraft({ studentId: student.id, application: app, enrollmentId: r.enrollmentId, price, checkId, personal, academic });
    actorAudit('priority.request_create', id, `draft; ${price.durationDays}d`);
    notify({ studentId: student.id, type: 'priority_received', title: 'Priority request received', message: 'ELVORA has received your priority certificate request. Nothing has been charged.', applicationId: app.applicationId, enrollmentId: r.enrollmentId, dedupeKey: `prio:${id}:received` });
    return { created: true, request: requestView(student, id) };
  })();
}
const requestView = (student, id) => { const r = P.requestOwned(id, student.id); return r && { ...r, amountDisplay: formatInr(r.price.amountPaise), nextStep: r.status === 'Draft' ? 'Your draft is saved. Create a payment order to continue; nothing has been charged yet.' : null }; };
export const listRequests = (student) => ({ requests: P.requestsForStudent(student.id).map((r) => requestView(student, r.id)) });
export function getRequest(student, id) { const r = requestView(student, id); if (!r) throw notFound('Request not found', 'REQUEST_NOT_FOUND'); return r; }
export function requestHistory(student, id) { getRequest(student, id); return { history: P.historyOwned(id, student.id) }; }
