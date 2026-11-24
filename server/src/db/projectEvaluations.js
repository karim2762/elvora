import crypto from 'node:crypto';
import { db } from './index.js';

// Stage 09B Part 2B — SQL for administrator project evaluation. Every value is a bound parameter. Finalized rows are never updated
// (a trigger enforces it); this file only INSERTs them as drafts and flips a draft to Final exactly once.
const json = (v, d) => { try { return JSON.parse(v ?? ''); } catch { return d; } };
const escapeLike = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
const isConstraint = (err) => String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT');
export { isConstraint };

export const toEvaluation = (r) => r && ({
  id: r.id, studentTaskId: r.student_task_id, submissionId: r.submission_id, submissionVersion: r.submission_version,
  rubric: json(r.rubric, null), scores: json(r.scores, {}), weightedTotal: r.weighted_total, feedback: r.feedback,
  status: r.status, decision: r.decision, adminId: r.admin_id, adminName: r.admin_name,
  createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at,
});
export const evaluationsFor = (studentTaskId) => db.prepare('SELECT * FROM project_evaluations WHERE student_task_id = ? ORDER BY created_at, rowid').all(studentTaskId).map(toEvaluation);
export const finalEvaluationsFor = (studentTaskId) => db.prepare("SELECT * FROM project_evaluations WHERE student_task_id = ? AND status = 'Final' ORDER BY decided_at, rowid").all(studentTaskId).map(toEvaluation);
export const findEvaluation = (id) => toEvaluation(db.prepare('SELECT * FROM project_evaluations WHERE id = ?').get(id));
export const openDraftFor = (studentTaskId) => toEvaluation(db.prepare("SELECT * FROM project_evaluations WHERE student_task_id = ? AND status = 'Draft'").get(studentTaskId));

export function insertDraft({ studentTaskId, submission, rubric, scores, weightedTotal, feedback, admin, now }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `PEV-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    try {
      db.prepare(`INSERT INTO project_evaluations (id, student_task_id, submission_id, submission_version, rubric_key, rubric_version, rubric, scores, weighted_total, feedback,
          status, admin_id, admin_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?, ?)`)
        .run(id, studentTaskId, submission.id, submission.version, rubric.key, rubric.version, JSON.stringify(rubric), JSON.stringify(scores), weightedTotal, feedback, admin.id, admin.fullName ?? 'Administrator', now, now);
      return findEvaluation(id);
    } catch (err) { if (!isConstraint(err) || !/project_evaluations\.id/.test(err.message)) throw err; }
  }
  throw new Error('Could not generate a unique evaluation ID');
}
export const updateDraft = (id, { scores, weightedTotal, feedback, admin, now }) =>
  db.prepare("UPDATE project_evaluations SET scores = ?, weighted_total = ?, feedback = ?, admin_id = ?, admin_name = ?, updated_at = ? WHERE id = ? AND status = 'Draft'")
    .run(JSON.stringify(scores), weightedTotal, feedback, admin.id, admin.fullName ?? 'Administrator', now, id).changes;
export const supersedeDraft = (id, now) => db.prepare("UPDATE project_evaluations SET status = 'Superseded', updated_at = ? WHERE id = ? AND status = 'Draft'").run(now, id).changes;
export const finalize = (id, { scores, weightedTotal, feedback, decision, admin, now }) =>
  db.prepare("UPDATE project_evaluations SET status = 'Final', scores = ?, weighted_total = ?, feedback = ?, decision = ?, admin_id = ?, admin_name = ?, updated_at = ?, decided_at = ? WHERE id = ? AND status = 'Draft'")
    .run(JSON.stringify(scores), weightedTotal, feedback, decision, admin.id, admin.fullName ?? 'Administrator', now, now, id).changes;

// The task row plus what the evaluator needs, in one query. Admin-side: not scoped to a student.
export const gate = (id) => db.prepare(`SELECT st.*, e.status AS enrollment_status, a.internship_category AS category, a.internship_title AS internship_title, a.internship_id AS listing_id,
    a.full_name AS applicant_name, s.full_name AS student_name, s.email AS student_email, s.role AS student_role,
    t.title AS task_title, t.task_type AS task_type, t.submission_type AS task_submission_type,
    (SELECT COUNT(*) FROM task_submissions ts WHERE ts.student_task_id = st.id) AS sub_count
  FROM student_tasks st JOIN enrollments e ON e.id = st.enrollment_id JOIN applications a ON a.id = e.application_id
  JOIN students s ON s.id = st.student_id JOIN internship_tasks t ON t.id = st.task_id WHERE st.id = ?`).get(id);
export const latestSubmission = (studentTaskId) => db.prepare('SELECT * FROM task_submissions WHERE student_task_id = ? ORDER BY version DESC LIMIT 1').get(studentTaskId);

export function setProjectStatus(studentTaskId, { status, projectStatus, decision = null, feedback = null, admin = null, now, reviewed = false }) {
  if (reviewed) {
    return db.prepare('UPDATE student_tasks SET status = ?, project_status = ?, review_decision = ?, reviewed_at = ?, reviewer_id = ?, reviewer_name = ?, feedback = ?, updated_at = ? WHERE id = ?')
      .run(status, projectStatus, decision, now, admin.id, admin.fullName ?? 'Administrator', feedback, now, studentTaskId).changes;
  }
  return db.prepare('UPDATE student_tasks SET status = ?, project_status = ?, updated_at = ? WHERE id = ?').run(status, projectStatus, now, studentTaskId).changes;
}
export const insertReview = ({ studentTaskId, submission, decision, feedback, score, breakdown, admin, now }) =>
  db.prepare('INSERT INTO task_reviews (student_task_id, submission_id, submission_version, decision, feedback, reviewer_id, reviewer_name, reviewed_at, score, score_breakdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(studentTaskId, submission.id, submission.version, decision, feedback, admin.id, admin.fullName ?? 'Administrator', now, score, JSON.stringify(breakdown));

// ---- admin listing -------------------------------------------------------------------------------------------------------------
// Derived-status conditions mirror submissionStatusOf() in tasks/githubSubmission.js.
const STATUS_SQL = {
  'Not Submitted': "(st.status IN ('Assigned', 'In Progress'))",
  'Submitted': "(st.status = 'Submitted' AND st.project_status IS NULL AND COALESCE(sc.n, 0) <= 1)",
  'Resubmitted': "(st.status = 'Submitted' AND st.project_status IS NULL AND sc.n > 1)",
  'Under Review': "(st.status = 'Submitted' AND st.project_status = 'Under Review')",
  'Changes Requested': "(st.status = 'Changes Requested' AND st.project_status IS NULL)",
  'Approved': "(st.status = 'Approved')",
  'Rejected': "(st.project_status = 'Rejected')",
};
export function pageForAdmin({ category, taskId, studentId, status, q, limit, offset }) {
  const where = []; const p = {};
  if (category) { where.push('a.internship_category = @category'); p.category = category; }
  if (taskId) { where.push('st.task_id = @taskId'); p.taskId = taskId; }
  if (studentId) { where.push('st.student_id = @studentId'); p.studentId = studentId; }
  if (status) where.push(STATUS_SQL[status]);
  if (status !== 'Not Submitted') where.push('COALESCE(sc.n, 0) > 0'); // a project submission needs at least one version
  if (q) {
    where.push(`(s.full_name LIKE @q ESCAPE '\\' OR s.email LIKE @q ESCAPE '\\' OR t.title LIKE @q ESCAPE '\\' OR a.internship_title LIKE @q ESCAPE '\\' OR st.id LIKE @q ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM task_submissions x WHERE x.student_task_id = st.id AND (x.repository_url LIKE @q ESCAPE '\\' OR x.description LIKE @q ESCAPE '\\')))`);
    p.q = `%${escapeLike(q)}%`;
  }
  const from = `FROM student_tasks st JOIN enrollments e ON e.id = st.enrollment_id JOIN applications a ON a.id = e.application_id JOIN students s ON s.id = st.student_id
    JOIN internship_tasks t ON t.id = st.task_id LEFT JOIN (SELECT student_task_id, COUNT(*) AS n FROM task_submissions GROUP BY student_task_id) sc ON sc.student_task_id = st.id`;
  const fromSql = from;
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n ${fromSql} ${cond}`).get(p).n;
  const rows = db.prepare(`SELECT st.id, st.status, st.project_status, st.submitted_at, st.updated_at, COALESCE(sc.n, 0) AS sub_count, st.student_id, s.full_name AS student_name, s.email AS student_email,
      a.internship_category AS category, a.internship_title AS internship_title, st.task_id, t.title AS task_title, t.task_type,
      (SELECT x.repository_url FROM task_submissions x WHERE x.student_task_id = st.id ORDER BY x.version DESC LIMIT 1) AS repository_url,
      (SELECT x.live_url FROM task_submissions x WHERE x.student_task_id = st.id ORDER BY x.version DESC LIMIT 1) AS live_url,
      (SELECT pe.weighted_total FROM project_evaluations pe WHERE pe.student_task_id = st.id AND pe.status = 'Final' ORDER BY pe.decided_at DESC, pe.rowid DESC LIMIT 1) AS last_total,
      (SELECT pe.decision FROM project_evaluations pe WHERE pe.student_task_id = st.id AND pe.status = 'Final' ORDER BY pe.decided_at DESC, pe.rowid DESC LIMIT 1) AS last_decision,
      (SELECT COUNT(*) FROM project_evaluations pe WHERE pe.student_task_id = st.id AND pe.status = 'Final') AS final_count,
      (SELECT COUNT(*) FROM project_evaluations pe WHERE pe.student_task_id = st.id AND pe.status = 'Draft') AS has_draft
    ${fromSql} ${cond} ORDER BY (st.status = 'Submitted') DESC, COALESCE(st.submitted_at, st.updated_at) DESC, st.id LIMIT @limit OFFSET @offset`).all({ ...p, limit, offset });
  return { total, rows };
}
export const countsByStatus = () => {
  const out = {};
  for (const [name, cond] of Object.entries(STATUS_SQL)) {
    out[name] = db.prepare(`SELECT COUNT(*) AS n FROM student_tasks st LEFT JOIN (SELECT student_task_id, COUNT(*) AS n FROM task_submissions GROUP BY student_task_id) sc ON sc.student_task_id = st.id WHERE ${cond} ${name === 'Not Submitted' ? '' : 'AND COALESCE(sc.n, 0) > 0'}`).get().n;
  }
  return out;
};
export const taskOptions = () => db.prepare(`SELECT t.id, t.title, a2.internship_category AS category FROM internship_tasks t JOIN (SELECT DISTINCT internship_id, internship_category FROM applications) a2 ON a2.internship_id = t.internship_id
  WHERE EXISTS (SELECT 1 FROM student_tasks st WHERE st.task_id = t.id) ORDER BY t.title, t.id`).all();
