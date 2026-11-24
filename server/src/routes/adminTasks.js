import { Router } from 'express';
import { notFound, badRequest } from '../utils/errors.js';
import { requireAdminSession } from '../auth/admin.js';
import { ENROLLMENT_ID_RE } from '../utils/enrollmentId.js';
import { CATEGORY_SLUGS } from '../internships/categories.js';
import { TASK_DIFFICULTIES, TASK_TYPES, SUBMISSION_TYPES, LEARNING_STAGES, STAGE_BY_TYPE } from '../tasks/constants.js';
import * as templates from '../services/taskTemplates.js';
import * as tasks from '../services/internshipTasks.js';
import * as completion from '../services/completionEligibility.js';
import * as evaluation from '../services/applicationEvaluation.js';

// Stage 09A — administrator API for task templates, internship tasks, assignment, criteria and application evaluation.
// Mounted inside routes/admin.js AFTER the shared guards (rate limit, admin auth, "shared key is read-only"). Reads accept the console key;
// EVERY write additionally needs a signed-in administrator session, so each change is tied to a named account and written to the audit log.
// Internship LISTING ids (ELV-PY-001) live under /internship-listings; internship RECORD ids (a student's enrollment) under /internships.
const router = Router();
const write = requireAdminSession;
const wrap = (fn) => (req, res, next) => { try { const out = fn(req, res); if (out !== undefined) res.status(res.statusCode === 201 ? 201 : 200).json(out); } catch (err) { next(err); } };
const record = (req) => { if (!ENROLLMENT_ID_RE.test(req.params.id)) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'); return req.params.id; };
function paging(q) {
  const page = q.page === undefined ? 1 : Number(q.page); const pageSize = q.pageSize === undefined ? 20 : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw badRequest('Invalid paging', { page: 'page ≥ 1 and pageSize 1–50' });
  return { page, pageSize };
}

// ---- task templates (reusable library) ----
router.get('/task-templates/options', wrap(() => ({ categories: CATEGORY_SLUGS, difficulties: TASK_DIFFICULTIES, taskTypes: TASK_TYPES, submissionTypes: SUBMISSION_TYPES, learningStages: LEARNING_STAGES })));
router.get('/task-templates', wrap((req) => {
  const category = typeof req.query.category === 'string' ? req.query.category : null;
  if (category && !CATEGORY_SLUGS.includes(category)) throw badRequest('Unknown category', { category: 'Choose a valid category' });
  const state = ['published', 'draft', 'archived'].includes(req.query.state) ? req.query.state : null;
  const stage = typeof req.query.stage === 'string' && req.query.stage ? req.query.stage : null;
  if (stage && !LEARNING_STAGES.includes(stage)) throw badRequest('Unknown learning stage', { stage: `Choose one of: ${LEARNING_STAGES.join(', ')}` });
  const taskType = stage ? Object.keys(STAGE_BY_TYPE).find((k) => STAGE_BY_TYPE[k] === stage) : null;
  return templates.listTemplates({ category, state, taskType, q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '', ...paging(req.query) });
}));
router.post('/task-templates', write, wrap((req, res) => { res.status(201); return templates.createTemplate(req.body, req.admin); }));
router.get('/task-templates/:id', wrap((req) => templates.getTemplate(req.params.id)));
router.patch('/task-templates/:id', write, wrap((req) => templates.editTemplate(req.params.id, req.body, req.admin)));
router.patch('/task-templates/:id/state', write, wrap((req) => templates.setTemplateState(req.params.id, req.body?.action, req.admin)));

// ---- a listing's own task plan, deadlines, completion and application criteria ----
router.get('/internship-listings/:id/tasks', wrap((req) => tasks.listForListing(req.params.id)));
router.post('/internship-listings/:id/tasks', write, wrap((req, res) => { res.status(201); return tasks.addTask(req.params.id, req.body, req.admin); }));
router.put('/internship-listings/:id/tasks/order', write, wrap((req) => tasks.reorder(req.params.id, req.body, req.admin)));
router.post('/internship-listings/:id/tasks/sync', write, wrap((req) => tasks.syncListing(req.params.id, req.admin)));
router.get('/internship-listings/:id/completion-criteria', wrap((req) => completion.getCompletionCriteria(req.params.id)));
router.put('/internship-listings/:id/completion-criteria', write, wrap((req) => completion.setCompletionCriteria(req.params.id, req.body, req.admin)));
router.get('/internship-listings/:id/application-criteria', wrap((req) => evaluation.getApplicationCriteria(req.params.id)));
router.put('/internship-listings/:id/application-criteria', write, wrap((req) => evaluation.setApplicationCriteria(req.params.id, req.body, req.admin)));

router.get('/internship-tasks/:taskId', wrap((req) => tasks.getTask(req.params.taskId)));
router.patch('/internship-tasks/:taskId', write, wrap((req) => tasks.editTask(req.params.taskId, req.body, req.admin)));
router.patch('/internship-tasks/:taskId/state', write, wrap((req) => tasks.setTaskState(req.params.taskId, req.body?.action, req.admin)));
router.delete('/internship-tasks/:taskId', write, wrap((req) => tasks.removeTask(req.params.taskId, req.admin)));

// ---- one student's internship record: assignments, review, completion eligibility ----
router.get('/internships/:id/tasks', wrap((req) => tasks.studentTasksFor(record(req))));
router.post('/internships/:id/tasks/assign', write, wrap((req) => tasks.assignPlan(record(req), { actor: req.admin })));
router.get('/internships/:id/completion-evaluation', wrap((req) => completion.completionEvaluation(record(req))));
router.get('/student-tasks/:id', wrap((req) => tasks.studentTaskDetail(req.params.id)));
router.patch('/student-tasks/:id/review', write, wrap((req) => tasks.reviewWork(req.admin, req.params.id, req.body)));

// ---- application evaluation (declared BEFORE /applications/:id in routes/admin.js, so "recommendations" is never read as an application ID) ----
router.get('/applications/recommendations', wrap((req) => evaluation.recommendations({ internshipId: typeof req.query.internshipId === 'string' ? req.query.internshipId.slice(0, 40) : null })));
router.get('/applications/:id/evaluation', wrap((req) => evaluation.getEvaluation(req.params.id)));
router.post('/applications/:id/evaluation', write, wrap((req, res) => { res.status(201); return evaluation.runEvaluation(req.params.id, req.admin); }));
router.post('/applications/:id/evaluation/review', write, wrap((req, res) => { res.status(201); return evaluation.reviewEvaluation(req.params.id, req.body, req.admin); }));

export default router;
