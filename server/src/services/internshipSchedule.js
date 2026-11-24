import { HttpError, notFound, badRequest } from '../utils/errors.js';
import { todayIST, addDays, isValidDate, backdateError, MAX_BACKDATE_DAYS } from '../utils/dates.js';
import * as enrollments from '../db/enrollments.js';
import { changeEnrollmentStatus } from './enrollments.js';

// Administrator sets WHEN an internship runs (start and end date) and which project the student works on. Used after an internship is approved,
// and for paid 1/2/3-month plans, where the student never chooses dates or the internship: the administrator decides.
//   - the start date may be at most MAX_BACKDATE_DAYS (90) days in the past; it may be in the future (the internship then starts on that day);
//   - the end date can't be before the start date; left empty it is the start date plus the internship length;
//   - a start date today or earlier activates an internship that is still "Awaiting Start".
const PROJECT_MAX = 200;
const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '');

export function setSchedule(id, body, admin, now = new Date()) {
  if (!admin?.id) throw new HttpError(403, 'Only a signed-in administrator can set the dates.', { code: 'ADMIN_REQUIRED' });
  const e = enrollments.findById(id);
  if (!e) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  if (['Completed', 'Cancelled'].includes(e.status)) throw new HttpError(409, `An internship that is “${e.status}” can’t be rescheduled.`, { code: 'ENROLLMENT_CLOSED' });
  if (e.applicationStatus !== 'Approved') throw new HttpError(409, 'The application is no longer approved.', { code: 'APPLICATION_NOT_APPROVED' });

  const b = body && typeof body === 'object' ? body : {};
  const fields = {};
  const startDate = typeof b.startDate === 'string' ? b.startDate : '';
  if (!isValidDate(startDate)) fields.startDate = 'Choose a start date';
  else { const old = backdateError(startDate, now); if (old) fields.startDate = old; }
  let end = typeof b.expectedEndDate === 'string' && b.expectedEndDate ? b.expectedEndDate : null;
  if (end && !isValidDate(end)) { fields.expectedEndDate = 'Use a valid date'; end = null; }
  if (!fields.startDate) {
    if (end && end < startDate) fields.expectedEndDate = 'The end date can’t be before the start date';
    if (!end && !fields.expectedEndDate) end = addDays(startDate, e.internship.durationDays);
  }
  const project = b.assignedProject === undefined ? e.assignedProject : (clean(b.assignedProject) || null);
  if (project && project.length > PROJECT_MAX) fields.assignedProject = `Keep the project name to ${PROJECT_MAX} characters or fewer`;
  if (Object.keys(fields).length) throw badRequest('Please fix the highlighted fields', fields);

  let out = enrollments.updateDetails(id, { startDate, expectedEndDate: end, assignedProject: project, learningObjectives: e.learningObjectives ?? [], instructions: e.instructions ?? null }, admin);
  if (out.status === 'Awaiting Start' && startDate <= todayIST(now)) out = changeEnrollmentStatus(id, { status: 'Active', startDate, expectedEndDate: end }, now, admin);
  return { internship: out, earliestAllowed: addDays(todayIST(now), -MAX_BACKDATE_DAYS) };
}
