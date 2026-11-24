import crypto from 'node:crypto';
import { db } from './index.js';
import { HttpError } from '../utils/errors.js';
import { insert as notify } from './notifications.js';
import { record as audit } from './audit.js';
import { stageOf, TASK_TYPES } from '../tasks/constants.js';

// Stage 09A — all task-system SQL. Every value is bound as a parameter. Student reads/writes are scoped by student_id, so someone
// else's task ID behaves exactly like a missing one. Rows that matter for history (submissions, reviews, revisions) are only ever inserted.
const json = (v, d) => { try { return JSON.parse(v ?? ''); } catch { return d; } };
const newId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const isConstraint = (err) => String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT');
const conflict = (message, code, details) => new HttpError(409, message, { code, details });
const actorName = (a) => a?.fullName ?? (a?.via === 'key' ? 'Admin API key' : a ? 'Administrator' : 'Automation');
const escapeLike = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

// ---------------------------------------------------------------------------------------------------------------------------------
// Templates (category-level library)
// ---------------------------------------------------------------------------------------------------------------------------------
const toTemplate = (r) => r && ({
  id: r.id, category: r.category, title: r.title, shortDescription: r.short_description, content: json(r.content, {}),
  difficulty: r.difficulty, taskType: r.task_type, estimatedHours: r.estimated_hours, minDurationDays: r.min_duration_days,
  learningObjectives: json(r.learning_objectives, []), requiredSkills: json(r.required_skills, []), deliverables: json(r.deliverables, []),
  evaluationCriteria: json(r.evaluation_criteria, []), resources: json(r.resources, []), submissionType: r.submission_type,
  published: !!r.is_published, archivedAt: r.archived_at, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
  createdBy: r.created_by, updatedBy: r.updated_by,
});
export const findTemplate = (id) => toTemplate(db.prepare('SELECT * FROM task_templates WHERE id = ?').get(id));

const TYPE_RANK = "CASE task_type WHEN 'Practical Assignment' THEN 1 WHEN 'Mini Project' THEN 2 ELSE 3 END";
export function pageTemplates({ category = null, state = null, q = '', taskType = null, limit, offset }) {
  const where = []; const args = [];
  if (category) { where.push('category = ?'); args.push(category); }
  if (taskType) { where.push('task_type = ?'); args.push(taskType); } // a learning stage is bound to a task type, so filtering by type filters by stage
  if (state === 'published') where.push('is_published = 1 AND archived_at IS NULL');
  else if (state === 'draft') where.push('is_published = 0 AND archived_at IS NULL');
  else if (state === 'archived') where.push('archived_at IS NOT NULL');
  else where.push('archived_at IS NULL');
  if (q) { where.push("(title LIKE ? ESCAPE '\\' OR short_description LIKE ? ESCAPE '\\')"); const like = `%${escapeLike(q)}%`; args.push(like, like); }
  const w = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM task_templates ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM task_templates ${w} ORDER BY category, ${TYPE_RANK}, created_at DESC, rowid LIMIT ? OFFSET ?`).all(...args, limit, offset).map(toTemplate);
  return { total, rows };
}

const templateColumns = (v) => ({
  category: v.category, title: v.title, shortDescription: v.shortDescription, content: JSON.stringify(v.content ?? {}), difficulty: v.difficulty, taskType: v.taskType,
  estimatedHours: v.estimatedHours ?? null, minDurationDays: v.minDurationDays ?? null, learningObjectives: JSON.stringify(v.learningObjectives ?? []),
  requiredSkills: JSON.stringify(v.requiredSkills ?? []), deliverables: JSON.stringify(v.deliverables ?? []), evaluationCriteria: JSON.stringify(v.evaluationCriteria ?? []),
  resources: JSON.stringify(v.resources ?? []), submissionType: v.submissionType,
});
export function insertTemplate(v, admin) {
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId('TPL');
    try {
      db.prepare(`INSERT INTO task_templates (id, category, title, short_description, content, difficulty, task_type, estimated_hours, min_duration_days, learning_objectives,
          required_skills, deliverables, evaluation_criteria, resources, submission_type, created_at, updated_at, created_by, updated_by)
        VALUES (@id, @category, @title, @shortDescription, @content, @difficulty, @taskType, @estimatedHours, @minDurationDays, @learningObjectives, @requiredSkills, @deliverables,
          @evaluationCriteria, @resources, @submissionType, @now, @now, @by, @by)`).run({ id, ...templateColumns(v), now, by: admin?.id ?? null });
      return findTemplate(id);
    } catch (err) { if (!isConstraint(err)) throw err; }
  }
  throw new Error('Could not generate a unique template ID');
}
// Stage 09B — library seeding. Inserts ONE template under a fixed ID and returns true, or returns false when that ID already exists
// (so an administrator's edits, unpublishing or archiving are never overwritten).
export function insertSeedTemplate(v, { published = true } = {}) {
  if (db.prepare('SELECT 1 FROM task_templates WHERE id = ?').get(v.id)) return false;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO task_templates (id, category, title, short_description, content, difficulty, task_type, estimated_hours, min_duration_days, learning_objectives,
      required_skills, deliverables, evaluation_criteria, resources, submission_type, is_published, created_at, updated_at, created_by, updated_by)
    VALUES (@id, @category, @title, @shortDescription, @content, @difficulty, @taskType, @estimatedHours, @minDurationDays, @learningObjectives, @requiredSkills, @deliverables,
      @evaluationCriteria, @resources, @submissionType, @published, @now, @now, NULL, NULL)`).run({ id: v.id, ...templateColumns(v), published: published ? 1 : 0, now });
  return true;
}
export function updateTemplate(id, merged, admin) {
  db.prepare(`UPDATE task_templates SET category=@category, title=@title, short_description=@shortDescription, content=@content, difficulty=@difficulty, task_type=@taskType,
      estimated_hours=@estimatedHours, min_duration_days=@minDurationDays, learning_objectives=@learningObjectives, required_skills=@requiredSkills, deliverables=@deliverables,
      evaluation_criteria=@evaluationCriteria, resources=@resources, submission_type=@submissionType, version = version + 1, updated_at=@now, updated_by=@by WHERE id=@id`)
    .run({ id, ...templateColumns(merged), now: new Date().toISOString(), by: admin?.id ?? null });
  return findTemplate(id);
}
export const setTemplateFlags = (id, { published, archived }, admin) => {
  const now = new Date().toISOString();
  if (published !== undefined) db.prepare('UPDATE task_templates SET is_published = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(published ? 1 : 0, now, admin?.id ?? null, id);
  if (archived !== undefined) db.prepare('UPDATE task_templates SET archived_at = ?, is_published = CASE WHEN ? IS NOT NULL THEN 0 ELSE is_published END, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(archived ? now : null, archived ? now : null, now, admin?.id ?? null, id);
  return findTemplate(id);
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Internship tasks (a listing's own copy of its tasks)
// ---------------------------------------------------------------------------------------------------------------------------------
const toTask = (r) => r && ({
  id: r.id, internshipId: r.internship_id, templateId: r.template_id, title: r.title, shortDescription: r.short_description, content: json(r.content, {}),
  difficulty: r.difficulty, taskType: r.task_type, estimatedHours: r.estimated_hours, learningObjectives: json(r.learning_objectives, []),
  requiredSkills: json(r.required_skills, []), deliverables: json(r.deliverables, []), evaluationCriteria: json(r.evaluation_criteria, []),
  resources: json(r.resources, []), submissionType: r.submission_type, sequence: r.sequence, required: !!r.is_required, published: !!r.is_published,
  dueAfterDays: r.due_after_days, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by, updatedBy: r.updated_by,
  ...(r.assignment_count !== undefined ? { assignedCount: r.assignment_count } : {}),
});
export const findTask = (id) => toTask(db.prepare('SELECT * FROM internship_tasks WHERE id = ?').get(id));
export const listTasks = (internshipId, { publishedOnly = false } = {}) =>
  db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM student_tasks st WHERE st.task_id = t.id) AS assignment_count FROM internship_tasks t
    WHERE t.internship_id = ? ${publishedOnly ? 'AND t.is_published = 1' : ''} ORDER BY t.sequence, t.id`).all(internshipId).map(toTask);
export const assignedCount = (taskId) => db.prepare('SELECT COUNT(*) AS n FROM student_tasks WHERE task_id = ?').get(taskId).n;
export const templateAlreadyAttached = (internshipId, templateId) =>
  Boolean(db.prepare('SELECT 1 FROM internship_tasks WHERE internship_id = ? AND template_id = ?').get(internshipId, templateId));
const nextSequence = (internshipId) => (db.prepare('SELECT MAX(sequence) AS m FROM internship_tasks WHERE internship_id = ?').get(internshipId).m ?? 0) + 1;

// Tasks have no category or minimum-length column (a listing already fixes both), and node:sqlite rejects parameters the SQL doesn't use.
const taskColumns = (v) => { const { category: _c, minDurationDays: _m, ...rest } = templateColumns(v); return rest; };
const snapshotOf = (t) => JSON.stringify({ title: t.title, shortDescription: t.shortDescription, content: t.content, difficulty: t.difficulty, taskType: t.taskType, estimatedHours: t.estimatedHours,
  learningObjectives: t.learningObjectives, requiredSkills: t.requiredSkills, deliverables: t.deliverables, evaluationCriteria: t.evaluationCriteria, resources: t.resources,
  submissionType: t.submissionType, sequence: t.sequence, required: t.required, published: t.published, dueAfterDays: t.dueAfterDays });
function revision(task, note, admin) {
  db.prepare('INSERT INTO internship_task_revisions (task_id, version, snapshot, note, changed_by, changed_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(task.id, task.version, snapshotOf(task), note ?? null, admin?.id ?? null, actorName(admin), new Date().toISOString());
}
export const revisionsFor = (taskId) => db.prepare('SELECT version, snapshot, note, changed_by_name, created_at FROM internship_task_revisions WHERE task_id = ? ORDER BY id').all(taskId)
  .map((r) => ({ version: r.version, snapshot: json(r.snapshot, {}), note: r.note, changedBy: r.changed_by_name, at: r.created_at }));

export function insertTask({ internshipId, templateId = null, fields, required = true, dueAfterDays = null, published = false }, admin) {
  return db.transaction(() => {
    const now = new Date().toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId('TSK');
      try {
        db.prepare(`INSERT INTO internship_tasks (id, internship_id, template_id, title, short_description, content, difficulty, task_type, estimated_hours, learning_objectives,
            required_skills, deliverables, evaluation_criteria, resources, submission_type, sequence, is_required, is_published, due_after_days, created_at, updated_at, created_by, updated_by)
          VALUES (@id, @internshipId, @templateId, @title, @shortDescription, @content, @difficulty, @taskType, @estimatedHours, @learningObjectives, @requiredSkills, @deliverables,
            @evaluationCriteria, @resources, @submissionType, @sequence, @required, @published, @dueAfterDays, @now, @now, @by, @by)`)
          .run({ id, internshipId, templateId, ...taskColumns(fields), sequence: nextSequence(internshipId), required: required ? 1 : 0, published: published ? 1 : 0, dueAfterDays, now, by: admin?.id ?? null });
        const t = findTask(id); revision(t, 'Created', admin); return t;
      } catch (err) {
        if (!isConstraint(err)) throw err;
        if (/template/i.test(err.message)) throw conflict('That template is already attached to this internship.', 'TEMPLATE_ALREADY_ATTACHED');
      }
    }
    throw new Error('Could not generate a unique task ID');
  })();
}

// Edits the live task in place (so every student assignment and submission keeps pointing at it), bumps the version and appends a revision.
export function updateTask(id, merged, { note = null, admin }) {
  return db.transaction(() => {
    db.prepare(`UPDATE internship_tasks SET title=@title, short_description=@shortDescription, content=@content, difficulty=@difficulty, task_type=@taskType, estimated_hours=@estimatedHours,
        learning_objectives=@learningObjectives, required_skills=@requiredSkills, deliverables=@deliverables, evaluation_criteria=@evaluationCriteria, resources=@resources,
        submission_type=@submissionType, is_required=@required, due_after_days=@dueAfterDays, version = version + 1, updated_at=@now, updated_by=@by WHERE id=@id`)
      .run({ id, ...taskColumns(merged), required: merged.required ? 1 : 0, dueAfterDays: merged.dueAfterDays ?? null, now: new Date().toISOString(), by: admin?.id ?? null });
    const t = findTask(id); revision(t, note ?? 'Edited', admin); return t;
  })();
}
export function setTaskPublished(id, published, admin) {
  return db.transaction(() => {
    db.prepare('UPDATE internship_tasks SET is_published = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(published ? 1 : 0, new Date().toISOString(), admin?.id ?? null, id);
    const t = findTask(id); revision(t, published ? 'Published' : 'Unpublished', admin); return t;
  })();
}
// A task that was ever given to a student can't be deleted (the foreign key refuses it too); unpublish it instead.
export function deleteTask(id) {
  try { return db.prepare('DELETE FROM internship_tasks WHERE id = ?').run(id).changes; } catch (err) {
    if (isConstraint(err)) throw conflict('Students have already been given this task, so it can’t be deleted. Unpublish it instead to keep their history.', 'TASK_IN_USE');
    throw err;
  }
}
// Sets the sequence of ALL of a listing's tasks to the order given. The list must be exactly the listing's tasks.
export function reorderTasks(internshipId, orderedIds, admin) {
  return db.transaction(() => {
    const current = db.prepare('SELECT id FROM internship_tasks WHERE internship_id = ?').all(internshipId).map((r) => r.id).sort();
    if (current.length !== orderedIds.length || [...orderedIds].sort().some((id, i) => id !== current[i])) {
      throw conflict('Send every task of this internship exactly once.', 'ORDER_MISMATCH', { expected: current.length });
    }
    const now = new Date().toISOString();
    orderedIds.forEach((id, i) => db.prepare('UPDATE internship_tasks SET sequence = ?, updated_at = ?, updated_by = ? WHERE id = ? AND sequence <> ?').run(i + 1, now, admin?.id ?? null, id, i + 1));
    return listTasks(internshipId);
  })();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Assignment (idempotent)
// ---------------------------------------------------------------------------------------------------------------------------------
// Published tasks of the internship's OWN listing that this internship record does not have yet. A task whose template belongs to another
// category is never returned (defence in depth: attachment already refuses it).
export const tasksToAssign = (enrollmentId) =>
  db.prepare(`SELECT t.* FROM internship_tasks t JOIN applications a ON a.internship_id = t.internship_id JOIN enrollments e ON e.application_id = a.id
    LEFT JOIN task_templates tpl ON tpl.id = t.template_id
    WHERE e.id = ? AND t.is_published = 1 AND (tpl.id IS NULL OR tpl.category = a.internship_category)
      AND NOT EXISTS (SELECT 1 FROM student_tasks st WHERE st.enrollment_id = e.id AND st.task_id = t.id)
    ORDER BY t.sequence, t.id`).all(enrollmentId).map(toTask);

export function insertAssignments({ enrollment, tasks, dueDateFor }) {
  return db.transaction(() => {
    const now = new Date().toISOString(); let created = 0;
    for (const t of tasks) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const r = db.prepare(`INSERT INTO student_tasks (id, enrollment_id, student_id, task_id, is_required, task_version, assigned_at, due_date, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (enrollment_id, task_id) DO NOTHING`)
            .run(newId('STK'), enrollment.id, enrollment.studentId, t.id, t.required ? 1 : 0, t.version, now, dueDateFor(t), now);
          created += r.changes; break;
        } catch (err) { if (!isConstraint(err) || !/student_tasks\.id/.test(err.message)) throw err; }
      }
    }
    if (created) {
      notify({ studentId: enrollment.studentId, type: 'tasks_assigned', title: 'Your internship tasks are ready',
        message: `${created} task${created === 1 ? '' : 's'} ${created === 1 ? 'has' : 'have'} been assigned for ${enrollment.internship.title}.`, applicationId: enrollment.applicationId, enrollmentId: enrollment.id });
    }
    return created;
  })();
}
export const countForEnrollment = (enrollmentId) => db.prepare('SELECT COUNT(*) AS n FROM student_tasks WHERE enrollment_id = ?').get(enrollmentId).n;
// Active internships that were never given a plan although their listing has published tasks (activation hook failed, or tasks were published after activation
// of a student who has none yet). NOT used to push NEW tasks to students who already have a plan: that is an explicit admin action (sync).
export const enrollmentsWithoutPlan = () =>
  db.prepare(`SELECT DISTINCT e.id FROM enrollments e JOIN applications a ON a.id = e.application_id JOIN internship_tasks t ON t.internship_id = a.internship_id AND t.is_published = 1
    WHERE a.status = 'Approved' AND e.status IN ('Awaiting Start', 'Active') AND NOT EXISTS (SELECT 1 FROM student_tasks st WHERE st.enrollment_id = e.id) ORDER BY e.id`).all().map((r) => r.id);
export const activeEnrollmentIdsForListing = (internshipId) =>
  db.prepare(`SELECT e.id FROM enrollments e JOIN applications a ON a.id = e.application_id WHERE a.internship_id = ? AND a.status = 'Approved' AND e.status IN ('Awaiting Start', 'Active') ORDER BY e.id`)
    .all(internshipId).map((r) => r.id);

// ---------------------------------------------------------------------------------------------------------------------------------
// Student tasks, submissions, reviews
// ---------------------------------------------------------------------------------------------------------------------------------
const toStudentTask = (r) => r && ({
  id: r.id, enrollmentId: r.enrollment_id, studentId: r.student_id, taskId: r.task_id, status: r.status, projectStatus: r.project_status ?? null, reviewDecision: r.review_decision, required: !!r.is_required,
  taskVersion: r.task_version, assignedAt: r.assigned_at, dueDate: r.due_date, startedAt: r.started_at, submittedAt: r.submitted_at, reviewedAt: r.reviewed_at,
  reviewerName: r.reviewer_name, feedback: r.feedback, updatedAt: r.updated_at,
  task: r.t_title === undefined ? undefined : { title: r.t_title, taskType: r.t_type, difficulty: r.t_difficulty, sequence: r.t_sequence, submissionType: r.t_submission_type,
    learningStage: stageOf({ taskType: r.t_type, content: json(r.t_content, {}) }), estimatedHours: r.t_hours, shortDescription: r.t_short },
});
const SELECT_ST = `SELECT st.*, t.title AS t_title, t.task_type AS t_type, t.difficulty AS t_difficulty, t.sequence AS t_sequence, t.submission_type AS t_submission_type,
  t.content AS t_content, t.estimated_hours AS t_hours, t.short_description AS t_short
  FROM student_tasks st JOIN internship_tasks t ON t.id = st.task_id`;
export const listForEnrollment = (enrollmentId) => db.prepare(`${SELECT_ST} WHERE st.enrollment_id = ? ORDER BY t.sequence, st.id`).all(enrollmentId).map(toStudentTask);
export const listForStudent = (studentId) => db.prepare(`${SELECT_ST} WHERE st.student_id = ? ORDER BY st.enrollment_id, t.sequence, st.id`).all(studentId).map(toStudentTask);
export const findStudentTask = (id) => toStudentTask(db.prepare(`${SELECT_ST} WHERE st.id = ?`).get(id));
export const findOwnedStudentTask = (id, studentId) => toStudentTask(db.prepare(`${SELECT_ST} WHERE st.id = ? AND st.student_id = ?`).get(id, studentId));
export const submissionsFor = (studentTaskId) => db.prepare('SELECT * FROM task_submissions WHERE student_task_id = ? ORDER BY version').all(studentTaskId)
  .map((s) => ({ id: s.id, version: s.version, description: s.description, repositoryUrl: s.repository_url, liveUrl: s.live_url,
    repositoryDescription: s.repository_description, documentationUrl: s.documentation_url, submissionNotes: s.submission_notes, implementedFeatures: s.implemented_features ?? null, testingPerformed: s.testing_performed ?? null, challengesEncountered: s.challenges_encountered ?? null, attachments: json(s.attachments, []), submittedAt: s.submitted_at }));
export const reviewsFor = (studentTaskId) => db.prepare('SELECT * FROM task_reviews WHERE student_task_id = ? ORDER BY id').all(studentTaskId)
  .map((r) => ({ id: r.id, submissionVersion: r.submission_version, decision: r.decision, feedback: r.feedback,
    score: r.score ?? null, scoreBreakdown: json(r.score_breakdown, null), reviewerName: r.reviewer_name, reviewedAt: r.reviewed_at }));
// How many versions each of a student's tasks has (a "Submitted" task with more than one is shown as "Resubmitted").
export const submissionCountsForStudent = (studentId) => Object.fromEntries(db.prepare(`SELECT ts.student_task_id AS id, COUNT(*) AS n FROM task_submissions ts
  JOIN student_tasks st ON st.id = ts.student_task_id WHERE st.student_id = ? GROUP BY ts.student_task_id`).all(studentId).map((r) => [r.id, r.n]));

const gate = (id, studentId) => db.prepare(`SELECT st.*, e.status AS enrollment_status, a.status AS application_status, a.internship_title FROM student_tasks st
  JOIN enrollments e ON e.id = st.enrollment_id JOIN applications a ON a.id = e.application_id WHERE st.id = ? ${studentId ? 'AND st.student_id = ?' : ''}`).get(...(studentId ? [id, studentId] : [id]));

// A student submits (or resubmits) work for a task assigned to THEM. Everything is re-checked inside the transaction.
// Returns null when the task does not exist or is not theirs (the caller answers 404 either way).
export function submit({ studentTaskId, studentId, values }) {
  return db.transaction(() => {
    const row = gate(studentTaskId, studentId);
    if (!row) return null;
    if (row.application_status !== 'Approved' || !['Awaiting Start', 'Active'].includes(row.enrollment_status)) throw conflict('Work can’t be submitted because this internship is no longer open.', 'INTERNSHIP_NOT_ACTIVE');
    if (row.project_status === 'Rejected') throw conflict('This project was rejected, so it can’t be resubmitted. Please contact your reviewer.', 'TASK_REJECTED');
    if (!['Assigned', 'In Progress', 'Changes Requested'].includes(row.status)) {
      throw conflict(row.status === 'Approved' ? 'This task has already been approved.' : 'Your submission is waiting for review.', row.status === 'Approved' ? 'TASK_APPROVED' : 'AWAITING_REVIEW');
    }
    // One repository, one project: the same repository cannot be reused for a different task of the same student.
    if (values.repositoryUrl && db.prepare(`SELECT 1 FROM task_submissions ts JOIN student_tasks st ON st.id = ts.student_task_id
      WHERE st.student_id = ? AND st.id <> ? AND lower(ts.repository_url) = lower(?) LIMIT 1`).get(row.student_id, row.id, values.repositoryUrl)) {
      throw new HttpError(409, 'You already used this repository for another task. Create a separate repository for each project.', { code: 'DUPLICATE_REPOSITORY', fields: { repositoryUrl: 'This repository is already used for another task of yours' } });
    }
    const now = new Date().toISOString();
    const version = (db.prepare('SELECT MAX(version) AS v FROM task_submissions WHERE student_task_id = ?').get(row.id).v ?? 0) + 1;
    const id = newId('SUB');
    db.prepare(`INSERT INTO task_submissions (id, student_task_id, version, description, repository_url, live_url, attachments, submitted_at, repository_description, documentation_url, submission_notes, implemented_features, testing_performed, challenges_encountered)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, row.id, version, values.description, values.repositoryUrl, values.liveUrl, '[]', now, values.repositoryDescription ?? null, values.documentationUrl ?? null, values.submissionNotes ?? null, values.implementedFeatures ?? null, values.testingPerformed ?? null, values.challengesEncountered ?? null);
    db.prepare("UPDATE student_tasks SET status = 'Submitted', project_status = NULL, review_decision = NULL, started_at = COALESCE(started_at, ?), submitted_at = ?, updated_at = ? WHERE id = ?").run(now, now, now, row.id);
    return { submission: { id, version, submittedAt: now }, studentTask: findStudentTask(row.id) };
  })();
}

export function markStarted(studentTaskId, studentId) {
  const now = new Date().toISOString();
  return db.prepare("UPDATE student_tasks SET status = 'In Progress', started_at = ?, updated_at = ? WHERE id = ? AND student_id = ? AND status = 'Assigned'").run(now, now, studentTaskId, studentId).changes > 0;
}

// An administrator's review of the latest submission. Only a SUBMITTED task can be reviewed, and never by its own student.
export function review({ studentTaskId, admin, decision, feedback }) {
  return db.transaction(() => {
    const row = gate(studentTaskId, null);
    if (!row) return null;
    if (!admin?.id) throw new HttpError(403, 'Only a signed-in administrator can review work.', { code: 'ADMIN_REQUIRED' });
    if (admin.id === row.student_id) throw new HttpError(403, 'You cannot review your own work.', { code: 'SELF_REVIEW' });
    if (row.status !== 'Submitted') throw conflict(row.status === 'Approved' ? 'This task is already approved.' : 'There is no submission waiting for review.', 'NOT_SUBMITTED');
    const sub = db.prepare('SELECT id, version FROM task_submissions WHERE student_task_id = ? ORDER BY version DESC LIMIT 1').get(row.id);
    if (!sub) throw conflict('There is no submission to review.', 'NOT_SUBMITTED');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO task_reviews (student_task_id, submission_id, submission_version, decision, feedback, reviewer_id, reviewer_name, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, sub.id, sub.version, decision, feedback, admin.id, actorName(admin), now);
    // A simple review settles the task, so any evaluation draft for it is retired (kept, marked Superseded) and the refined status cleared.
    db.prepare("UPDATE project_evaluations SET status = 'Superseded', updated_at = ? WHERE student_task_id = ? AND status = 'Draft'").run(now, row.id);
    db.prepare('UPDATE student_tasks SET project_status = NULL, status = ?, review_decision = ?, reviewed_at = ?, reviewer_id = ?, reviewer_name = ?, feedback = ?, updated_at = ? WHERE id = ?')
      .run(decision, decision, now, admin.id, actorName(admin), feedback, now, row.id);
    const title = db.prepare('SELECT title FROM internship_tasks WHERE id = ?').get(row.task_id).title;
    notify({
      studentId: row.student_id, type: decision === 'Approved' ? 'task_approved' : 'task_changes_requested',
      title: decision === 'Approved' ? 'Task approved' : 'Changes requested on your task',
      message: decision === 'Approved' ? `Your work on “${title}” was approved.` : `Your reviewer asked for changes on “${title}”. Open the task to see the feedback.`,
      enrollmentId: row.enrollment_id, studentTaskId: row.id, dedupeKey: `review:${sub.id}:${decision}`,
    });
    audit({ admin, action: 'task.review', targetType: 'student_task', targetId: row.id, reason: `${decision} (submission ${sub.version})` });
    return findStudentTask(row.id);
  })();
}

// What the completion rules need, in one query. Required tasks are those that were required WHEN ASSIGNED (is_required snapshot).
export function progressFor(enrollmentId) {
  const r = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(st.is_required), 0) AS required_total,
      COALESCE(SUM(CASE WHEN st.is_required = 1 AND st.status = 'Approved' THEN 1 ELSE 0 END), 0) AS required_approved,
      COALESCE(SUM(CASE WHEN st.is_required = 0 AND st.status = 'Approved' THEN 1 ELSE 0 END), 0) AS optional_approved,
      COALESCE(SUM(CASE WHEN st.status = 'Submitted' THEN 1 ELSE 0 END), 0) AS awaiting_review,
      COALESCE(SUM(CASE WHEN t.task_type = 'Final Project' AND st.is_required = 1 THEN 1 ELSE 0 END), 0) AS final_total,
      COALESCE(SUM(CASE WHEN t.task_type = 'Final Project' AND st.is_required = 1 AND st.status = 'Approved' THEN 1 ELSE 0 END), 0) AS final_approved
    FROM student_tasks st JOIN internship_tasks t ON t.id = st.task_id WHERE st.enrollment_id = ?`).get(enrollmentId);
  return { total: r.total, requiredTotal: r.required_total, requiredApproved: r.required_approved, optionalApproved: r.optional_approved,
    awaitingReview: r.awaiting_review, finalProjectTotal: r.final_total, finalProjectApproved: r.final_approved };
}
export const hasPublishedTasks = (internshipId) => Boolean(db.prepare('SELECT 1 FROM internship_tasks WHERE internship_id = ? AND is_published = 1').get(internshipId));
export const hasPublishedRequiredTasks = (internshipId) => Boolean(db.prepare('SELECT 1 FROM internship_tasks WHERE internship_id = ? AND is_published = 1 AND is_required = 1').get(internshipId));

// ---------------------------------------------------------------------------------------------------------------------------------
// Criteria (per listing)
// ---------------------------------------------------------------------------------------------------------------------------------
export const getCriteria = (internshipId, kind) => {
  const r = db.prepare('SELECT config, updated_at, updated_by FROM internship_criteria WHERE internship_id = ? AND kind = ?').get(internshipId, kind);
  return r ? { config: json(r.config, {}), updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
};
export function setCriteria(internshipId, kind, config, admin) {
  db.prepare(`INSERT INTO internship_criteria (internship_id, kind, config, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (internship_id, kind) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(internshipId, kind, JSON.stringify(config), new Date().toISOString(), admin?.id ?? null);
  return getCriteria(internshipId, kind);
}

// Stage 10C — library fallback. Published library templates that fit an internship (same category, short enough), best-first.
export const libraryTemplatesFor = (category, durationDays) =>
  db.prepare(`SELECT * FROM task_templates WHERE category = ? AND is_published = 1 AND archived_at IS NULL
    AND (min_duration_days IS NULL OR min_duration_days <= ?) ORDER BY ${TYPE_RANK}, created_at, rowid`).all(category, durationDays).map(toTemplate);
// Open internships (approved application) that were never given any task.
export const openEnrollmentsWithoutAnyTask = () =>
  db.prepare(`SELECT e.id FROM enrollments e JOIN applications a ON a.id = e.application_id
    WHERE a.status = 'Approved' AND e.status IN ('Awaiting Start', 'Active') AND NOT EXISTS (SELECT 1 FROM student_tasks st WHERE st.enrollment_id = e.id) ORDER BY e.id`).all().map((r) => r.id);
export const approvedCountForEnrollment = (enrollmentId) =>
  db.prepare("SELECT COUNT(*) AS n FROM student_tasks WHERE enrollment_id = ? AND status = 'Approved'").get(enrollmentId).n;
