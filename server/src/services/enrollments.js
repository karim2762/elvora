import { HttpError, notFound } from '../utils/errors.js';
import { addDays, todayIST, backdateError } from '../utils/dates.js';
import { parseEnrollmentDetails, parseEnrollmentStatus } from '../utils/validation.js';
import * as applications from '../db/applications.js';
import * as enrollments from '../db/enrollments.js';
import { buildTimeline } from './progress.js';
import { assertTasksSatisfied } from './completionEligibility.js';
import { assignPlanSafely } from './internshipTasks.js';

// Allowed status moves. Only administrators call these (routes/admin.js); there is no student route that writes here.
export const TRANSITIONS = {
  'Awaiting Start': ['Active', 'Cancelled'],
  Active: ['Completed', 'Suspended', 'Cancelled'],
  Suspended: ['Active', 'Cancelled'],
  Completed: [],
  Cancelled: [],
};

const conflict = (message, code) => new HttpError(409, message, { code });
const endFrom = (start, days) => addDays(start, days);

// Admin: create the internship record for an APPROVED application. It starts as "Awaiting Start".
export function createEnrollment(applicationId, body) {
  const application = applications.findById(applicationId);
  if (!application) throw notFound('Application not found', 'APPLICATION_NOT_FOUND');
  if (application.status !== 'Approved') throw conflict('Only an approved application can have an internship.', 'APPLICATION_NOT_APPROVED');
  const d = parseEnrollmentDetails(body);
  // Expected end defaults from start + duration when only a start date is given.
  if (d.startDate && !d.expectedEndDate) d.expectedEndDate = endFrom(d.startDate, application.internship.durationDays);
  const studentId = applications.ownerOf(application.id);
  try {
    const created = enrollments.create({ application, details: { ...d, studentId } });
    // The student gets the internship's published tasks right away (never blocks or undoes the enrollment if it fails; the worker retries).
    assignPlanSafely(created.id);
    return created;
  } catch (err) {
    if (err instanceof enrollments.DuplicateEnrollmentError) throw conflict('This application already has an internship.', 'ENROLLMENT_EXISTS');
    throw err;
  }
}

export function updateEnrollmentDetails(id, body, actor = null) {
  const current = enrollments.findById(id);
  if (!current) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  if (['Completed', 'Cancelled'].includes(current.status)) throw conflict('A finished internship can’t be edited.', 'ENROLLMENT_CLOSED');
  const d = parseEnrollmentDetails(body);
  const tooOld = d.startDate && d.startDate !== current.startDate ? backdateError(d.startDate) : null;
  if (tooOld) throw new HttpError(400, 'Please fix the highlighted fields', { code: 'VALIDATION', fields: { startDate: tooOld } });
  if (d.startDate && !d.expectedEndDate) d.expectedEndDate = endFrom(d.startDate, current.internship.durationDays);
  return enrollments.updateDetails(id, d, actor);
}

// `actor` (the administrator, or null for the automation worker) is recorded in the internship history.
export function changeEnrollmentStatus(id, body, now = new Date(), actor = null) {
  const current = enrollments.findById(id);
  if (!current) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  if (current.applicationStatus !== 'Approved') throw conflict('The application is no longer approved.', 'APPLICATION_NOT_APPROVED');
  const { status, startDate, expectedEndDate, reason } = parseEnrollmentStatus(body);
  if (!TRANSITIONS[current.status].includes(status)) {
    throw conflict(`An internship that is “${current.status}” can’t move to “${status}”.`, 'INVALID_TRANSITION');
  }
  // Stage 09A: whoever asks (administrator, background worker, legacy console), an internship whose student was given required tasks can't be
  // completed until those tasks are approved. Internships without tasks are unaffected.
  if (status === 'Completed') assertTasksSatisfied(current);
  const stamp = now.toISOString();
  const patch = {
    status, startDate: current.startDate, expectedEndDate: current.expectedEndDate,
    activatedAt: current.activatedAt, completedAt: current.completedAt, suspendedAt: current.suspendedAt, cancelledAt: current.cancelledAt,
  };
  if (status === 'Active') {
    if (current.status === 'Awaiting Start') { // first activation
      patch.activatedAt = stamp;
      patch.startDate = startDate ?? current.startDate ?? todayIST(now);
      if (!current.expectedEndDate || startDate) patch.expectedEndDate = endFrom(patch.startDate, current.internship.durationDays);
      if (expectedEndDate) patch.expectedEndDate = expectedEndDate;
    }
    patch.suspendedAt = null; // resuming after a suspension
  } else if (status === 'Suspended') patch.suspendedAt = stamp;
  else if (status === 'Completed') patch.completedAt = stamp;
  else if (status === 'Cancelled') patch.cancelledAt = stamp;
  const resumed = status === 'Active' && current.status === 'Suspended';
  const notice = {
    Active: resumed
      ? { type: 'internship_progress', title: 'Internship resumed', message: '{title} is active again.' }
      : { type: 'internship_activated', title: 'Your internship is active', message: '{title} has started. Open My Internship to see your project and instructions.' },
    Suspended: { type: 'internship_progress', title: 'Internship suspended', message: '{title} is temporarily suspended. Contact ELVORA if you have questions.' },
    Completed: { type: 'internship_completed', title: 'Internship completed', message: 'You have completed {title}. Well done!' },
    Cancelled: { type: 'internship_progress', title: 'Internship cancelled', message: '{title} was cancelled.' },
  }[status];
  const why = reason && (status === 'Suspended' || status === 'Cancelled') ? ` Reason: ${reason}` : '';
  const result = enrollments.applyTransition(id, patch, { ...notice, message: notice.message + why }, { kind: 'status', from: current.status, to: status, detail: reason, actor });
  // Stage 09A: first activation hands the student the internship's published task plan. It never undoes the activation if it fails (it is
  // recorded, and the background worker or an administrator can run it again safely).
  if (status === 'Active' && current.status === 'Awaiting Start') assignPlanSafely(id, actor);
  return result;
}

// What a student may see. No student ID, no internal fields, no admin notes.
export function toStudentView(enrollment, application) {
  const dates = applications.statusDates(application.id);
  return {
    id: enrollment.id,
    applicationId: enrollment.applicationId,
    internship: enrollment.internship,
    status: enrollment.status,
    startDate: enrollment.startDate,
    expectedEndDate: enrollment.expectedEndDate,
    activatedAt: enrollment.activatedAt,
    completedAt: enrollment.completedAt,
    assignedProject: enrollment.assignedProject,
    learningObjectives: enrollment.learningObjectives,
    instructions: enrollment.instructions,
    certificate: enrollment.certificate,
    progressPercent: enrollment.progressPercent,
    timeline: buildTimeline({ application, dates, enrollment }),
  };
}

// GET /student/internships: the signed-in student's own approved internships.
export function listStudentInternships(student) {
  return enrollments.listForStudent(student.id).map((e) => {
    const application = applications.findOwned(e.applicationId, student.id);
    return toStudentView(e, application);
  });
}

// Timeline for one of the student's applications (used by GET /applications/:id). `application` is already owner-checked.
export function applicationTimeline(application, student) {
  const enrollment = enrollments.findForApplicationOwned(application.id, student.id);
  return buildTimeline({ application, dates: applications.statusDates(application.id), enrollment });
}
