import { HttpError, notFound, badRequest } from '../utils/errors.js';
import { todayIST, backdateError } from '../utils/dates.js';
import { parseEnrollmentStatus } from '../utils/validation.js';
import * as enrollments from '../db/enrollments.js';
import { changeEnrollmentStatus, TRANSITIONS } from './enrollments.js';
import { asLifecycleChecks } from './completionEligibility.js';
import { taskSummaryFor } from './internshipTasks.js';

// Stage 07B — administrator internship lifecycle (activate, progress, complete, suspend, cancel).
// Every function re-reads the record, validates on the server, writes through the same transactional db layer as the legacy
// status route, and records WHO did it in enrollment_events. Routes call these with a signed-in administrator only.
const conflict = (message, code, details) => new HttpError(409, message, { code, details });
const REASON_MIN = 5; const REASON_MAX = 500; const NOTE_MAX = 300;
const text = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '');

const load = (id) => { const e = enrollments.findById(id); if (!e) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'); return e; };
function reasonOf(body) {
  const reason = text(body?.reason);
  if (reason.length < REASON_MIN) throw badRequest('Please fix the highlighted fields', { reason: `Give a reason (at least ${REASON_MIN} characters). It is saved in the history and shown to the student.` });
  if (reason.length > REASON_MAX) throw badRequest('Please fix the highlighted fields', { reason: `Keep the reason to ${REASON_MAX} characters or fewer` });
  return reason;
}

// The conditions that must hold before an internship can be marked Completed. The reviewer's own confirmation is checked separately.
export function completionChecks(e, now = new Date()) {
  const today = todayIST(now);
  return [
    { key: 'application_approved', label: 'The application is still approved', need: 'The application must still be approved', passed: e.applicationStatus === 'Approved' },
    { key: 'active', label: 'The internship is active (not suspended or cancelled)', need: 'The internship must be Active (resume it if suspended)', passed: e.status === 'Active' },
    { key: 'started', label: 'A start date is set and has been reached', need: 'A start date on or before today must be set', passed: Boolean(e.startDate) && e.startDate <= today },
    { key: 'progress', label: 'Progress is recorded at 100%', need: 'Set the progress to 100% first', passed: e.progressPercent === 100 },
    ...asLifecycleChecks(e), // Stage 09A: required tasks approved (only when this student was given tasks)
  ];
}
const actionsFor = (e) => ({
  activate: e.status === 'Awaiting Start', resume: e.status === 'Suspended', suspend: e.status === 'Active', progress: e.status === 'Active',
  complete: e.status === 'Active', cancel: TRANSITIONS[e.status].includes('Cancelled'),
});
export function lifecycleView(id, now = new Date()) {
  const e = load(id);
  const { studentId: _s, ...internship } = e;
  return { internship, events: enrollments.eventsFor(id), completionChecks: completionChecks(e, now), allowedActions: actionsFor(e), tasks: taskSummaryFor(id) };
}

export function activate(id, body, admin, now = new Date()) {
  const e = load(id);
  if (!['Awaiting Start', 'Suspended'].includes(e.status)) throw conflict(`An internship that is “${e.status}” can’t be activated.`, 'INVALID_TRANSITION');
  if (e.status === 'Suspended') return changeEnrollmentStatus(id, { status: 'Active' }, now, admin); // resume
  const parsed = parseEnrollmentStatus({ status: 'Active', startDate: body?.startDate, expectedEndDate: body?.expectedEndDate });
  const start = parsed.startDate ?? e.startDate ?? todayIST(now);
  if (start > todayIST(now)) throw badRequest('Please fix the highlighted fields', { startDate: 'An internship can only be activated on or after its start date. Pick today or an earlier date.' });
  const tooOld = parsed.startDate ? backdateError(start, now) : null;
  if (tooOld) throw badRequest('Please fix the highlighted fields', { startDate: tooOld });
  if (parsed.expectedEndDate && parsed.expectedEndDate < start) throw badRequest('Please fix the highlighted fields', { expectedEndDate: 'The end date can’t be before the start date' });
  return changeEnrollmentStatus(id, { status: 'Active', startDate: start, expectedEndDate: parsed.expectedEndDate }, now, admin);
}

export function suspend(id, body, admin, now = new Date()) { return changeEnrollmentStatus(id, { status: 'Suspended', reason: reasonOf(body) }, now, admin); }
export function cancel(id, body, admin, now = new Date()) { return changeEnrollmentStatus(id, { status: 'Cancelled', reason: reasonOf(body) }, now, admin); }

export function updateProgress(id, body, admin) {
  const e = load(id);
  if (e.applicationStatus !== 'Approved') throw conflict('The application is no longer approved.', 'APPLICATION_NOT_APPROVED');
  if (e.status !== 'Active') throw conflict('Progress can only be updated while the internship is Active.', 'NOT_ACTIVE');
  const n = body?.progressPercent;
  if (!Number.isInteger(n) || n < 0 || n > 100) throw badRequest('Please fix the highlighted fields', { progressPercent: 'Enter a whole number from 0 to 100' });
  const note = text(body?.note) || null;
  if (note && note.length > NOTE_MAX) throw badRequest('Please fix the highlighted fields', { note: `Keep the note to ${NOTE_MAX} characters or fewer` });
  if (e.progressPercent === n) return e; // nothing to record
  return enrollments.setProgress(id, n, { actor: admin, note, previous: e.progressPercent });
}

// Completion needs: every check above AND the administrator's explicit confirmation that they reviewed them.
export function complete(id, body, admin, now = new Date()) {
  if (!admin?.id) throw new HttpError(403, 'Only a signed-in administrator can complete an internship.', { code: 'ADMIN_REQUIRED' });
  const e = load(id);
  if (['Completed', 'Cancelled'].includes(e.status)) throw conflict(`An internship that is “${e.status}” can’t be completed.`, 'INVALID_TRANSITION');
  const checks = completionChecks(e, now);
  const failed = checks.filter((c) => !c.passed);
  if (failed.length) throw conflict(`Can’t complete yet. Still needed: ${failed.map((c) => c.need ?? c.label).join('; ')}.`, 'COMPLETION_CHECKS_FAILED', { checks });
  if (body?.confirmReviewed !== true) throw badRequest('Please fix the highlighted fields', { confirmReviewed: 'Confirm that you reviewed the completion conditions' });
  const note = text(body?.note) || null;
  if (note && note.length > NOTE_MAX) throw badRequest('Please fix the highlighted fields', { note: `Keep the note to ${NOTE_MAX} characters or fewer` });
  return changeEnrollmentStatus(id, { status: 'Completed', reason: note }, now, admin);
}
