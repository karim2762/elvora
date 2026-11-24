import { HttpError, notFound, badRequest } from '../utils/errors.js';
import { db } from '../db/index.js';
import * as repo from '../db/projectEvaluations.js';
import * as taskRepo from '../db/tasks.js';
import { insert as notify } from '../db/notifications.js';
import { record as audit } from '../db/audit.js';
import { STUDENT_TASK_ID_RE, TASK_ID_RE } from '../tasks/constants.js';
import { config } from '../config/index.js';
import { CATEGORY_SLUGS } from '../internships/categories.js';
import { SUBMISSION_STATUSES, submissionStatusOf, canTransition, VERIFICATION_NOTICE } from '../tasks/githubSubmission.js';
import { githubEvidence } from './githubProject.js';
import { rubricFor, snapshotRubric, parseScores, calculate, listRubrics } from '../tasks/rubric.js';

// Stage 09B Part 2B — administrator evaluation of GitHub project submissions.
// Rules enforced here (never in the client):
//   - only an administrator SESSION evaluates (routes use requireAdminSession); nobody evaluates their own work;
//   - the decision is an explicit action: no score ever approves or rejects anything by itself;
//   - an evaluation cannot be finalized until every criterion is scored; changes/rejection need written feedback;
//   - every status move is checked against STATUS_TRANSITIONS; finalized evaluations are immutable (database trigger) and each new
//     submission version starts a NEW evaluation, so earlier decisions stay in the history.
export const ADMIN_VERIFICATION_NOTICE = 'Repository ownership, repository contents and commit history have NOT been verified. ELVORA only stores the link the student typed; GitHub verification is part of Stage 09C. ' + VERIFICATION_NOTICE;
export const FINAL_DECISIONS = ['Approved', 'Changes Requested', 'Rejected'];
const MIN_FEEDBACK = 10; const MAX_FEEDBACK = 4000;
const conflict = (message, code, details) => new HttpError(409, message, { code, details });
const validation = (fields) => new HttpError(400, 'Please fix the highlighted fields', { code: 'VALIDATION', fields });

const load = (id) => {
  const row = STUDENT_TASK_ID_RE.test(String(id)) ? repo.gate(id) : null;
  if (!row) throw notFound('Project submission not found', 'SUBMISSION_NOT_FOUND');
  return row;
};
const derive = (row) => submissionStatusOf({ status: row.status, projectStatus: row.project_status }, row.sub_count);
const guardAdmin = (row, admin) => {
  if (!admin?.id || admin.via !== 'session') throw new HttpError(403, 'Only a signed-in administrator can evaluate projects.', { code: 'ADMIN_REQUIRED' });
  if (admin.id === row.student_id && !config.allowSelfReview) throw new HttpError(403, 'You are signed in as the student who submitted this project, so you can’t review it. Sign in with a different administrator account (for local testing only, set ALLOW_SELF_REVIEW=true in .env).', { code: 'SELF_REVIEW' });
};
const withCalc = (e) => e && ({ ...e, calculation: calculate(e.rubric, e.scores) });
const feedbackOf = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '');

// ---------------------------------------------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------------------------------------------
export function parseQuery(q) {
  const s = (v, n = 80) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const fields = {}; const out = {};
  if (s(q.category)) { if (!CATEGORY_SLUGS.includes(q.category)) fields.category = 'Choose a valid category'; else out.category = q.category; }
  if (s(q.taskId)) { if (!TASK_ID_RE.test(q.taskId)) fields.taskId = 'Choose a valid task'; else out.taskId = q.taskId; }
  if (s(q.studentId, 60)) { if (!/^[A-Za-z0-9_-]{1,60}$/.test(q.studentId)) fields.studentId = 'Choose a valid student'; else out.studentId = q.studentId; }
  if (s(q.status)) { if (!SUBMISSION_STATUSES.includes(q.status)) fields.status = `Status must be one of: ${SUBMISSION_STATUSES.join(', ')}`; else out.status = q.status; }
  out.q = s(q.q);
  const page = q.page === undefined ? 1 : Number(q.page); const pageSize = q.pageSize === undefined ? 20 : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) fields.page = 'page ≥ 1 and pageSize 1–50';
  if (Object.keys(fields).length) throw badRequest('Invalid filters', fields);
  return { ...out, page, pageSize };
}
const listItem = (r) => {
  const status = submissionStatusOf({ status: r.status, projectStatus: r.project_status }, r.sub_count);
  return { id: r.id, status, isResubmission: r.sub_count > 1, isNew: status === 'Submitted', versions: r.sub_count, submittedAt: r.submitted_at, updatedAt: r.updated_at,
    student: { id: r.student_id, name: r.student_name, email: r.student_email }, internship: { title: r.internship_title, category: r.category },
    task: { id: r.task_id, title: r.task_title, taskType: r.task_type }, repositoryUrl: r.repository_url, liveUrl: r.live_url,
    lastEvaluation: r.final_count ? { total: r.last_total, decision: r.last_decision, count: r.final_count } : null, hasDraft: r.has_draft > 0 };
};
export function listProjects(query) {
  const f = parseQuery(query);
  const probe = repo.pageForAdmin({ ...f, limit: 1, offset: 0 });
  const totalPages = Math.max(1, Math.ceil(probe.total / f.pageSize)); const page = Math.min(f.page, totalPages);
  const { total, rows } = repo.pageForAdmin({ ...f, limit: f.pageSize, offset: (page - 1) * f.pageSize });
  return { submissions: rows.map(listItem), pagination: { page, pageSize: f.pageSize, total, totalPages }, counts: repo.countsByStatus() };
}
export const filterOptions = () => ({
  statuses: SUBMISSION_STATUSES, tasks: repo.taskOptions(),
  rubrics: listRubrics().map((r) => ({ key: r.key, name: r.name, criteria: r.criteria })),
  students: db.prepare('SELECT DISTINCT s.id, s.full_name AS name, s.email FROM student_tasks st JOIN students s ON s.id = st.student_id ORDER BY s.full_name, s.id').all(),
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------------------------------------------
export function projectDetail(id) {
  const row = load(id);
  const status = derive(row);
  const submissions = taskRepo.submissionsFor(row.id);
  const evaluations = repo.evaluationsFor(row.id).map(withCalc);
  const draft = evaluations.find((e) => e.status === 'Draft') ?? null;
  const rubric = draft?.rubric ?? snapshotRubric(rubricFor(row.category));
  return {
    submission: { id: row.id, status, statuses: SUBMISSION_STATUSES, isResubmission: row.sub_count > 1, versions: row.sub_count, submittedAt: row.submitted_at, reviewedAt: row.reviewed_at, reviewerName: row.reviewer_name },
    student: { id: row.student_id, name: row.student_name, email: row.student_email },
    internship: { id: row.listing_id, title: row.internship_title, category: row.category },
    task: { id: row.task_id, title: row.task_title, taskType: row.task_type },
    latestSubmission: submissions.at(-1) ?? null, submissions,
    evaluations, draft, rubric,
    previousEvaluations: evaluations.filter((e) => e.status === 'Final'),
    allowedNext: ['Submitted', 'Resubmitted'].includes(status) ? ['Under Review'] : status === 'Under Review' ? FINAL_DECISIONS : [],
    canEvaluate: ['Submitted', 'Resubmitted', 'Under Review'].includes(status),
    verificationNotice: ADMIN_VERIFICATION_NOTICE,
    github: githubEvidence(row.id), // Stage 09C Part 2A: read from stored snapshots only, no GitHub call
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Workflow actions
// ---------------------------------------------------------------------------------------------------------------------------------
// Opens a project for review: Submitted / Resubmitted -> Under Review. Idempotent for a project that is already under review.
function beginReview(row, admin, now) {
  const from = derive(row);
  if (from === 'Under Review') return false;
  if (!canTransition(from, 'Under Review')) throw conflict(`A project that is “${from}” can’t be opened for review.`, 'INVALID_TRANSITION', { from, to: 'Under Review' });
  repo.setProjectStatus(row.id, { status: 'Submitted', projectStatus: 'Under Review', now });
  audit({ admin, action: 'project.review_start', targetType: 'student_task', targetId: row.id, reason: `${from} → Under Review (submission v${row.sub_count})` });
  return true;
}
export function startReview(id, admin) {
  return db.transaction(() => {
    const row = load(id); guardAdmin(row, admin);
    beginReview(row, admin, new Date().toISOString());
    return projectDetail(id);
  })();
}

function parseDraftBody(body, rubric, existing) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const fields = {};
  let scores = { ...(existing?.scores ?? {}) };
  if (b.scores !== undefined) {
    const parsed = parseScores(b.scores, rubric); Object.assign(fields, parsed.errors);
    // Sent keys replace saved ones; a key sent as null/'' clears that score.
    for (const k of rubric.criteria.map((c) => c.key)) if (k in (b.scores ?? {})) { if (k in parsed.scores) scores[k] = parsed.scores[k]; else if (b.scores[k] === null || b.scores[k] === '') delete scores[k]; }
  }
  let feedback = existing?.feedback ?? null;
  if (b.feedback !== undefined) {
    if (b.feedback !== null && typeof b.feedback !== 'string') fields.feedback = 'Feedback must be text';
    else { const f = feedbackOf(b.feedback); if (f.length > MAX_FEEDBACK) fields.feedback = `Keep the feedback to ${MAX_FEEDBACK} characters or fewer`; feedback = f || null; }
  }
  if (Object.keys(fields).length) throw validation(fields);
  return { scores, feedback };
}

// Creates the draft for the CURRENT submission (taking a snapshot of the category's rubric) or updates the open one.
function upsertDraft(row, body, admin, now) {
  const sub = repo.latestSubmission(row.id);
  if (!sub) throw conflict('There is no submission to evaluate.', 'NOT_SUBMITTED');
  let draft = repo.openDraftFor(row.id);
  if (draft && draft.submissionId !== sub.id) { repo.supersedeDraft(draft.id, now); draft = null; }
  const rubric = draft?.rubric ?? snapshotRubric(rubricFor(row.category));
  const { scores, feedback } = parseDraftBody(body, rubric, draft);
  const calc = calculate(rubric, scores);
  if (draft) { repo.updateDraft(draft.id, { scores, weightedTotal: calc.total, feedback, admin, now }); return { draft: repo.findEvaluation(draft.id), created: false, sub }; }
  const created = repo.insertDraft({ studentTaskId: row.id, submission: { id: sub.id, version: sub.version }, rubric, scores, weightedTotal: calc.total, feedback, admin, now });
  return { draft: created, created: true, sub };
}

export function saveDraft(id, body, admin) {
  return db.transaction(() => {
    const row = load(id); guardAdmin(row, admin);
    const now = new Date().toISOString();
    const from = derive(row);
    if (from === 'Approved' || from === 'Rejected') throw conflict(`This project is already ${from.toLowerCase()}; its evaluation is final.`, 'ALREADY_DECIDED');
    if (from === 'Changes Requested' || from === 'Not Submitted') throw conflict('There is no submission waiting for evaluation.', 'NOT_SUBMITTED');
    beginReview(row, admin, now); // saving a draft means the administrator is reviewing
    const { draft, created } = upsertDraft(row, body, admin, now);
    audit({ admin, action: 'project.evaluation_save', targetType: 'student_task', targetId: row.id, reason: `${created ? 'Draft created' : 'Draft updated'} ${draft.id} (submission v${draft.submissionVersion})` });
    return projectDetail(id);
  })();
}

export function finalize(id, body, admin) {
  return db.transaction(() => {
    const row = load(id); guardAdmin(row, admin);
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (!FINAL_DECISIONS.includes(b.decision)) throw validation({ decision: `Decision must be one of: ${FINAL_DECISIONS.join(', ')}` });
    if (b.confirm !== true) throw validation({ confirm: 'Confirm that you reviewed the project and want to record this decision' });
    const now = new Date().toISOString();
    const from = derive(row);
    if (from === 'Approved' || from === 'Rejected') throw conflict(`This project is already ${from.toLowerCase()}; its decision can’t be changed.`, 'ALREADY_DECIDED');
    beginReview(row, admin, now); // throws INVALID_TRANSITION for anything that is not Submitted / Resubmitted / Under Review
    const { draft, sub } = upsertDraft(row, { scores: b.scores, feedback: b.feedback }, admin, now);
    const calc = calculate(draft.rubric, draft.scores);
    const fields = {};
    // Stage 10C: `simple: true` is the plain approve / request-changes / reject flow without rubric scores (the total is then simply not recorded).
    const simple = b.simple === true;
    if (!simple && !calc.complete) fields.scores = `Score every criterion before recording a decision (missing: ${draft.rubric.criteria.filter((k) => calc.missing.includes(k.key)).map((k) => k.label).join(', ')})`;
    const feedback = draft.feedback ?? '';
    if (b.decision !== 'Approved' && feedback.length < MIN_FEEDBACK) fields.feedback = `${b.decision === 'Rejected' ? 'Explain why the project is rejected' : 'Explain what needs to change'} (at least ${MIN_FEEDBACK} characters) so the student understands`;
    if (Object.keys(fields).length) throw validation(fields);
    if (!canTransition('Under Review', b.decision)) throw conflict('That decision is not allowed from the current status.', 'INVALID_TRANSITION');

    if (!repo.finalize(draft.id, { scores: draft.scores, weightedTotal: calc.total ?? 0, feedback: draft.feedback, decision: b.decision, admin, now })) throw conflict('This evaluation was already finalized.', 'ALREADY_DECIDED');
    const legacy = b.decision === 'Rejected' ? { status: 'Changes Requested', projectStatus: 'Rejected', decision: null } : { status: b.decision, projectStatus: null, decision: b.decision };
    repo.setProjectStatus(row.id, { status: legacy.status, projectStatus: legacy.projectStatus, decision: legacy.decision, feedback: draft.feedback, admin, now, reviewed: true });
    // task_reviews only allows Approved / Changes Requested (Stage 09A), so a rejection lives in project_evaluations and student_tasks only.
    if (b.decision !== 'Rejected') repo.insertReview({ studentTaskId: row.id, submission: sub, decision: b.decision, feedback: draft.feedback, score: calc.total, breakdown: { rubric: draft.rubric.key, rubricVersion: draft.rubric.version, evaluationId: draft.id, rows: calc.rows }, admin, now });
    const word = { Approved: 'approved', 'Changes Requested': 'returned with requested changes', Rejected: 'not accepted' }[b.decision];
    notify({ studentId: row.student_id, type: { Approved: 'task_approved', 'Changes Requested': 'task_changes_requested', Rejected: 'task_rejected' }[b.decision],
      title: { Approved: 'Project approved', 'Changes Requested': 'Changes requested on your project', Rejected: 'Project not accepted' }[b.decision],
      message: `Your project “${row.task_title}” was ${word}. Open the task to read the feedback.`, enrollmentId: row.enrollment_id,
      studentTaskId: row.id, dedupeKey: `review:${sub.id}:${b.decision}` });
    audit({ admin, action: 'project.decision', targetType: 'student_task', targetId: row.id, reason: `${b.decision} · ${calc.total === null ? 'no score' : `${calc.total}/100`} · evaluation ${draft.id} (submission v${sub.version})` });
    return projectDetail(id);
  })();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Student view: finalized evaluations only (never a draft, never another student's)
// ---------------------------------------------------------------------------------------------------------------------------------
export function studentEvaluations(studentTaskId) {
  return repo.finalEvaluationsFor(studentTaskId).map((e) => {
    const calc = calculate(e.rubric, e.scores);
    return { id: e.id, submissionVersion: e.submissionVersion, decision: e.decision, weightedTotal: e.weightedTotal, feedback: e.feedback, reviewerName: e.adminName, decidedAt: e.decidedAt,
      rubricName: e.rubric.name, breakdown: calc.rows };
  });
}
