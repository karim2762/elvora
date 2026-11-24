import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { notFound } from '../utils/errors.js';
import { APPLICATION_ID_RE } from '../utils/applicationId.js';
import { requireAuth } from '../auth/session.js';
import { applySubmitLimiter, applicationReadLimiter } from '../auth/rateLimit.js';
import { submitApplication } from '../services/applications.js';
import { applicationTimeline } from '../services/enrollments.js';
import { parseApplicationsQuery, APPLICATION_STATUSES } from '../utils/validation.js';
import * as applications from '../db/applications.js';
import { config } from '../config/index.js';
import { kick } from '../automation/worker.js';

// Authentication runs first on every route. Ownership is enforced in SQL (WHERE student_id = <session student>),
// and there is no way to pass a student ID: identity only ever comes from the session cookie.
const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(requireAuth);

router.post('/', applySubmitLimiter, asyncHandler(async (req, res) => {
  const application = submitApplication(req.student, req.body);
  if (config.automation.enabled && config.automation.autoApproveApplications.enabled && config.automation.autoApproveApplications.delayMinutes === 0) kick(); // approve right away when no waiting period is set
  res.status(201).json({ application });
}));

// Declared before /:id so "my" is never read as an ID.
router.get('/my', applicationReadLimiter, (req, res) => {
  // Optional ?status=<one of the five statuses>&page=<n>&pageSize=<n>. Invalid values are a 400. The student is always req.student.
  const { status, page, pageSize } = parseApplicationsQuery(req.query);
  const probe = applications.pageForStudent(req.student.id, { status, limit: 1, offset: 0 });
  const totalPages = Math.max(1, Math.ceil(probe.total / pageSize));
  const current = Math.min(page, totalPages); // a page past the end (e.g. after a filter change) falls back to the last page
  const { total, rows } = applications.pageForStudent(req.student.id, { status, limit: pageSize, offset: (current - 1) * pageSize });
  const byStatus = applications.countByStatus(req.student.id);
  const counts = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, byStatus[s] ?? 0]));
  counts.All = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({ applications: rows, pagination: { page: current, pageSize, total, totalPages }, counts });
});

router.get('/:id', applicationReadLimiter, (req, res, next) => {
  // Someone else's application and a nonexistent one look identical (404), so IDs can't be probed.
  const found = APPLICATION_ID_RE.test(req.params.id) ? applications.findOwned(req.params.id, req.student.id) : null;
  if (!found) return next(notFound('Application not found', 'APPLICATION_NOT_FOUND'));
  res.json({ application: found, timeline: applicationTimeline(found, req.student) });
});

export default router;
