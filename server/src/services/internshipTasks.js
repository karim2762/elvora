import { HttpError, notFound } from '../utils/errors.js';
import { db } from '../db/index.js';
import { config } from '../config/index.js';
import { addDays, todayIST } from '../utils/dates.js';
import * as repo from '../db/tasks.js';
import { studentEvaluations } from './projectEvaluation.js';
import * as enrollments from '../db/enrollments.js';
import * as listings from '../db/internshipListings.js';
import { record as audit } from '../db/audit.js';
import { parseTaskFields, publishReadiness, parseSequenceOrder, parseSubmission, parseReview } from '../utils/taskValidation.js';
import { TASK_ID_RE, STUDENT_TASK_ID_RE, stageOf } from '../tasks/constants.js';
import { submissionStatusOf, submissionGuide, SUBMISSION_STATUSES } from '../tasks/githubSubmission.js';

// Stage 09A — each internship listing's own task plan, the assignment of that plan to enrolled students, and the (service-level) student and
// reviewer actions that enforce the integrity rules. The student-facing HTTP interface is Stage 09B; nothing here is reachable by a student route yet.
const conflict = (message, code, details) => new HttpError(409, message, { code, details });
// Students get their tasks (and the submission form) as soon as the application is approved and the internship record exists.
const OPEN_STATUSES = ['Awaiting Start', 'Active'];
const loadListing = (id) => { const l = listings.findById(id); if (!l) throw notFound('Internship not found', 'LISTING_NOT_FOUND'); return l; };
const loadTask = (id) => { const t = TASK_ID_RE.test(id) ? repo.findTask(id) : null; if (!t) throw notFound('Task not found', 'TASK_NOT_FOUND'); return t; };
const view = (t) => ({ ...t, learningStage: stageOf(t), readiness: publishReadiness(t) });
const assertEditable = (l) => { if (l.archivedAt) throw conflict('This internship is archived. Restore it before changing its tasks.', 'LISTING_ARCHIVED'); };
const checkDue = (dueAfterDays, l) => {
  if (dueAfterDays != null && dueAfterDays > l.durationDays) throw new HttpError(400, 'Please fix the highlighted fields', { code: 'VALIDATION', fields: { dueAfterDays: `A deadline can’t be later than the internship’s length (${l.durationDays} days)` } });
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Configuration (administrator)
// ---------------------------------------------------------------------------------------------------------------------------------
export function listForListing(listingId) {
  const l = loadListing(listingId); const rows = repo.listTasks(l.id);
  return {
    internship: { id: l.id, title: l.title, category: l.category, durationDays: l.durationDays },
    tasks: rows.map(view),
    summary: { total: rows.length, published: rows.filter((t) => t.published).length, required: rows.filter((t) => t.required).length, optional: rows.filter((t) => !t.required).length,
      finalProjects: rows.filter((t) => t.taskType === 'Final Project').length, estimatedHours: rows.reduce((n, t) => n + (t.estimatedHours ?? 0), 0) },
  };
}

// Attach a library template to an internship (copying its content) or create a task written only for this internship.
// Tasks start unpublished: students get nothing until an administrator publishes.
export function addTask(listingId, body, admin) {
  const l = loadListing(listingId); assertEditable(l);
  const b = body && typeof body === 'object' ? body : {};
  return db.transaction(() => {
    let created;
    if (typeof b.templateId === 'string') {
      const tpl = repo.findTemplate(b.templateId);
      if (!tpl || tpl.archivedAt) throw notFound('Task template not found', 'TEMPLATE_NOT_FOUND');
      if (!tpl.published) throw conflict('Publish the template before attaching it to an internship.', 'TEMPLATE_NOT_PUBLISHED');
      if (tpl.category !== l.category) throw conflict(`This template is for “${tpl.category}” and this internship is “${l.category}”. Unrelated tasks are never attached.`, 'CATEGORY_MISMATCH');
      if (tpl.minDurationDays && tpl.minDurationDays > l.durationDays) throw conflict(`This template needs an internship of at least ${tpl.minDurationDays} days; this one is ${l.durationDays}.`, 'DURATION_TOO_SHORT');
      if (repo.templateAlreadyAttached(l.id, tpl.id)) throw conflict('That template is already attached to this internship.', 'TEMPLATE_ALREADY_ATTACHED');
      const placement = {}; // only the placement fields are read from the request; the content always comes from the template
      if (b.isRequired !== undefined) placement.isRequired = b.isRequired;
      if (b.dueAfterDays !== undefined) placement.dueAfterDays = b.dueAfterDays;
      const opts = parseTaskFields(placement, { partial: true });
      checkDue(opts.dueAfterDays, l);
      created = repo.insertTask({ internshipId: l.id, templateId: tpl.id, fields: tpl, required: opts.isRequired ?? true, dueAfterDays: opts.dueAfterDays ?? null, published: b.publish === true }, admin);
    } else {
      const v = parseTaskFields(b);
      checkDue(v.dueAfterDays, l);
      if (b.publish === true && !publishReadiness(v).ready) throw conflict(`This task can’t be published yet. Missing: ${publishReadiness(v).missing.join(', ')}.`, 'TASK_INCOMPLETE', { missing: publishReadiness(v).missing });
      created = repo.insertTask({ internshipId: l.id, fields: v, required: v.isRequired ?? true, dueAfterDays: v.dueAfterDays ?? null, published: b.publish === true }, admin);
    }
    audit({ admin, action: 'internship_task.attach', targetType: 'listing', targetId: l.id, reason: `${created.id}: ${created.title}` });
    return { task: view(created) };
  })();
}

// Edits the live task in place: student assignments, submissions and reviews keep pointing at it, and every edit appends a revision.
export function editTask(taskId, body, admin) {
  const current = loadTask(taskId); const l = loadListing(current.internshipId); assertEditable(l);
  const v = parseTaskFields(body, { partial: true });
  const { note, ...changes } = v;
  const merged = { ...current, ...changes, required: changes.isRequired ?? current.required, dueAfterDays: 'dueAfterDays' in changes ? changes.dueAfterDays : current.dueAfterDays };
  checkDue(merged.dueAfterDays, l);
  if (current.published) { const r = publishReadiness(merged); if (!r.ready) throw conflict(`A published task must stay complete. Missing: ${r.missing.join(', ')}. Unpublish it first to work on it.`, 'TASK_INCOMPLETE', { missing: r.missing }); }
  return db.transaction(() => {
    const t = repo.updateTask(taskId, merged, { note, admin });
    audit({ admin, action: 'internship_task.update', targetType: 'task', targetId: taskId, reason: `v${t.version}: ${Object.keys(changes).join(', ') || 'no changes'}` });
    return { task: { ...view(t), assignedCount: repo.assignedCount(t.id) }, note: repo.assignedCount(t.id) ? 'Students who already have this task keep their submissions and review history. Their required/optional status is unchanged.' : undefined };
  })();
}

export function setTaskState(taskId, action, admin) {
  const current = loadTask(taskId); assertEditable(loadListing(current.internshipId));
  if (!['publish', 'unpublish'].includes(action)) throw new HttpError(400, 'Action must be publish or unpublish', { code: 'VALIDATION', fields: { action: 'Choose publish or unpublish' } });
  if (action === 'publish') { const r = publishReadiness(current); if (!r.ready) throw conflict(`This task can’t be published yet. Missing: ${r.missing.join(', ')}.`, 'TASK_INCOMPLETE', { missing: r.missing }); }
  return db.transaction(() => {
    const t = repo.setTaskPublished(taskId, action === 'publish', admin);
    audit({ admin, action: `internship_task.${action}`, targetType: 'task', targetId: taskId, reason: current.title });
    return { task: view(t) };
  })();
}

export function removeTask(taskId, admin) {
  const current = loadTask(taskId); assertEditable(loadListing(current.internshipId));
  db.transaction(() => {
    repo.deleteTask(taskId);
    audit({ admin, action: 'internship_task.delete', targetType: 'task', targetId: taskId, reason: current.title });
  })();
  return { deleted: true };
}

export function reorder(listingId, body, admin) {
  const l = loadListing(listingId); assertEditable(l);
  const ids = parseSequenceOrder(body);
  return db.transaction(() => {
    const rows = repo.reorderTasks(l.id, ids, admin);
    audit({ admin, action: 'internship_task.reorder', targetType: 'listing', targetId: l.id, reason: `${ids.length} tasks` });
    return { tasks: rows.map(view) };
  })();
}
export const revisions = (taskId) => ({ taskId: loadTask(taskId).id, revisions: repo.revisionsFor(taskId) });
export const getTask = (taskId) => { const t = loadTask(taskId); return { task: view(t), revisions: repo.revisionsFor(t.id) }; };

// ---------------------------------------------------------------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------------------------------------------------------------
// Gives ONE internship record the published tasks of ITS OWN listing that it does not have yet. Safe to call any number of times:
//   - a task the student already has is never duplicated (UNIQUE(enrollment_id, task_id) + ON CONFLICT DO NOTHING),
//   - existing progress, submissions and reviews are never touched,
//   - tasks of another internship (or of a template from another category) are never returned (db/tasks.js tasksToAssign),
//   - only an approved application with an ACTIVE internship is assigned anything.
// `actor` is the administrator, or null for the system (activation hook / background worker).
export function assignPlan(enrollmentId, { actor = null } = {}) {
  const e = enrollments.findById(enrollmentId);
  if (!e) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  if (e.applicationStatus !== 'Approved') throw conflict('The application is no longer approved, so no tasks are assigned.', 'APPLICATION_NOT_APPROVED');
  if (!OPEN_STATUSES.includes(e.status)) throw conflict(`Tasks are assigned while an internship is open (this one is “${e.status}”).`, 'NOT_ACTIVE');
  return db.transaction(() => {
    provisionFromLibrary(e);
    const todo = repo.tasksToAssign(e.id);
    if (!todo.length) return { assigned: 0, total: repo.countForEnrollment(e.id) };
    const start = e.startDate ?? todayIST();
    const created = repo.insertAssignments({ enrollment: e, tasks: todo, dueDateFor: (t) => (t.dueAfterDays ? addDays(start, t.dueAfterDays) : null) });
    if (created) audit({ admin: actor, action: 'task_plan.assign', targetType: 'internship', targetId: e.id, reason: `${created} task${created === 1 ? '' : 's'} assigned` });
    return { assigned: created, total: repo.countForEnrollment(e.id) };
  })();
}

// Stage 10C: an internship nobody configured tasks for would leave every student with an empty "My Tasks" page. When (and only when) the listing has
// NO tasks at all, the published library tasks for its category are attached (required, published) so students get a real starter plan.
// A listing an administrator has already worked on (even with only drafts) is never touched. Disable with AUTO_LIBRARY_TASKS=false.
const planSize = (days) => Math.min(8, Math.max(2, Math.ceil(days / 2)));
export function provisionFromLibrary(enrollment) {
  if (!config.tasks.autoLibrary) return 0;
  const l = listings.findById(enrollment.internship.id);
  if (!l || l.archivedAt || repo.listTasks(l.id).length) return 0;
  const picks = repo.libraryTemplatesFor(l.category, l.durationDays).slice(0, planSize(l.durationDays));
  picks.forEach((tpl) => repo.insertTask({ internshipId: l.id, templateId: tpl.id, fields: tpl, required: true, dueAfterDays: null, published: true }, null));
  if (picks.length) audit({ admin: null, action: 'internship_task.attach', targetType: 'listing', targetId: l.id, reason: `${picks.length} library task${picks.length === 1 ? '' : 's'} attached automatically` });
  return picks.length;
}

// Activation hook: a failure here must never undo or block the activation itself. It is recorded (audit, result failure) and the background
// worker retries it, so the situation is visible and recoverable.
export function assignPlanSafely(enrollmentId, actor = null) {
  try { return assignPlan(enrollmentId, { actor }); } catch (err) {
    try { audit({ admin: actor, action: 'task_plan.assign', targetType: 'internship', targetId: enrollmentId, result: 'failure', reason: err?.code ?? err?.message ?? 'ERROR' }); } catch (e) { console.error('[tasks] could not record a failed assignment:', e.message); }
    return { assigned: 0, error: err?.code ?? 'ERROR' };
  }
}

// Explicit administrator action: hand the tasks added AFTER students started to the students of this listing. (Never done silently.)
export function syncListing(listingId, admin) {
  const l = loadListing(listingId);
  const results = repo.activeEnrollmentIdsForListing(l.id).filter((id) => OPEN_STATUSES.includes(enrollments.findById(id)?.status)).map((id) => ({ internshipRecordId: id, ...assignPlanSafely(id, admin) }));
  return { internshipId: l.id, internshipsChecked: results.length, tasksAssigned: results.reduce((n, r) => n + (r.assigned ?? 0), 0), results };
}

// Admin: one internship record's assignments with their state.
export function taskSummaryFor(enrollmentId) {
  return { total: repo.countForEnrollment(enrollmentId), approved: repo.approvedCountForEnrollment(enrollmentId) };
}
export function studentTasksFor(enrollmentId) {
  const e = enrollments.findById(enrollmentId);
  if (!e) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  return { internshipRecordId: e.id, status: e.status, progress: repo.progressFor(e.id), tasks: repo.listForEnrollment(e.id).map(({ studentId: _s, ...t }) => t) };
}
export function studentTaskDetail(id) {
  const t = STUDENT_TASK_ID_RE.test(id) ? repo.findStudentTask(id) : null;
  if (!t) throw notFound('Task not found', 'TASK_NOT_FOUND');
  const { studentId: _s, ...rest } = t;
  return { studentTask: rest, submissions: repo.submissionsFor(t.id), reviews: repo.reviewsFor(t.id) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Student and reviewer actions (service level; the student HTTP interface comes in Stage 09B)
// ---------------------------------------------------------------------------------------------------------------------------------
// The student is always the SIGNED-IN student; the lookup is scoped by student_id, so someone else's assignment is a plain 404.
export function submitWork(student, studentTaskId, body) {
  if (!STUDENT_TASK_ID_RE.test(String(studentTaskId))) throw notFound('Task not found', 'TASK_NOT_FOUND');
  const owned = repo.findOwnedStudentTask(studentTaskId, student.id);
  if (!owned) throw notFound('Task not found', 'TASK_NOT_FOUND');
  const task = repo.findTask(owned.taskId);
  const values = parseSubmission(body, task);
  const r = repo.submit({ studentTaskId, studentId: student.id, values });
  if (!r) throw notFound('Task not found', 'TASK_NOT_FOUND');
  return r;
}
export function startTask(student, studentTaskId) {
  const owned = STUDENT_TASK_ID_RE.test(String(studentTaskId)) ? repo.findOwnedStudentTask(studentTaskId, student.id) : null;
  if (!owned) throw notFound('Task not found', 'TASK_NOT_FOUND');
  if (owned.status !== 'Assigned') throw conflict('This task has already been started.', 'ALREADY_STARTED');
  if (!repo.markStarted(studentTaskId, student.id)) throw conflict('This task has already been started.', 'ALREADY_STARTED');
  return repo.findOwnedStudentTask(studentTaskId, student.id);
}
export function reviewWork(admin, studentTaskId, body) {
  if (!STUDENT_TASK_ID_RE.test(String(studentTaskId))) throw notFound('Task not found', 'TASK_NOT_FOUND');
  const { decision, feedback } = parseReview(body);
  const r = repo.review({ studentTaskId, admin, decision, feedback });
  if (!r) throw notFound('Task not found', 'TASK_NOT_FOUND');
  const { studentId: _s, ...rest } = r;
  return { studentTask: rest };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Student read access (Stage 09B Part 1). Read-only: what a student was assigned and the full instructions for it. Always scoped to the signed-in student.
// ---------------------------------------------------------------------------------------------------------------------------------
export function listForStudent(student) {
  const counts = repo.submissionCountsForStudent(student.id);
  const rows = repo.listForStudent(student.id).map(({ studentId: _s, ...t }) => ({ ...t, submissionStatus: submissionStatusOf(t, counts[t.id] ?? 0) }));
  const done = rows.filter((t) => t.status === 'Approved').length;
  return { tasks: rows, summary: { total: rows.length, approved: done, percent: rows.length ? Math.round((done / rows.length) * 100) : 0 } };
}
export function studentTaskView(student, id) {
  const owned = STUDENT_TASK_ID_RE.test(String(id)) ? repo.findOwnedStudentTask(id, student.id) : null;
  const task = owned ? repo.findTask(owned.taskId) : null;
  if (!owned || !task) throw notFound('Task not found', 'TASK_NOT_FOUND');
  const { studentId: _s, ...assignment } = owned;
  const { createdBy: _c, updatedBy: _u, templateId: _t, internshipId: _i, ...instructions } = task;
  const siblings = repo.listForEnrollment(owned.enrollmentId);
  const submissions = repo.submissionsFor(owned.id);
  const latest = submissions.at(-1) ?? null;
  const active = OPEN_STATUSES.includes(enrollments.findById(owned.enrollmentId)?.status);
  const open = ['Assigned', 'In Progress', 'Changes Requested'].includes(owned.status) && owned.projectStatus !== 'Rejected';
  const submission = {
    status: submissionStatusOf(owned, submissions.length), statuses: SUBMISSION_STATUSES, versions: submissions.length,
    canSubmit: open && active, resubmitting: submissions.length > 0,
    blockedReason: !open ? (owned.status === 'Approved' ? 'This task has been approved. No further changes are needed.' : owned.projectStatus === 'Rejected' ? 'This project was rejected, so it can’t be resubmitted. See the feedback below or contact your reviewer.' : 'Your submission is waiting for review. You can resubmit if changes are requested.')
      : !active ? 'Work can’t be submitted because this internship is no longer open.' : null,
    // Pre-fills the form with the previous version so a correction is an edit, not a rewrite. Older versions stay in `submissions`.
    draft: latest && { description: latest.description, repositoryUrl: latest.repositoryUrl, repositoryDescription: latest.repositoryDescription, liveUrl: latest.liveUrl, documentationUrl: latest.documentationUrl, submissionNotes: latest.submissionNotes },
    guide: submissionGuide(task, owned),
  };
  return { assignment: { ...assignment, submissionStatus: submission.status }, task: { ...instructions, learningStage: stageOf(task) }, submission, submissions, reviews: repo.reviewsFor(owned.id), evaluations: studentEvaluations(owned.id),
    position: { index: siblings.findIndex((s) => s.id === owned.id) + 1, total: siblings.length } };
}
