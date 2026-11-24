import { Router } from 'express';
import { config } from '../config/index.js';
import { optionalAuth, requireAuth } from '../auth/session.js';
import { applicationReadLimiter, taskSubmitLimiter } from '../auth/rateLimit.js';
import { HttpError, notFound } from '../utils/errors.js';
import { asHttp } from '../github/errors.js';
import * as oauth from '../github/oauth.js';
import * as repos from '../github/repositories.js';
import * as gh from '../db/github.js';
import { inspect, snapshotView, canCallGitHub } from '../github/inspect.js';
import { studentStatus } from '../github/status.js';
import { publicState } from '../github/config.js';
import * as project from '../services/githubProject.js';
import * as taskView from '../services/internshipTasks.js';

// Stage 09C Part 1 — student GitHub API, mounted at /student/github. The student is ALWAYS req.student; task IDs are resolved inside that
// student's own assignments. No token, secret or raw GitHub answer is ever returned. Only the documented body fields are read.
const router = Router();
const wrap = (fn) => async (req, res, next) => { try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out); } catch (err) { next(asHttp(err)); } };
const back = (res, query) => res.redirect(302, `${config.clientUrl}/student/overview?${new URLSearchParams(query)}#github`);

// The browser comes back from GitHub here. Cookie-based session (SameSite=Lax allows this top-level navigation); the one-time `state` must have
// been issued to THIS signed-in student. Nothing sensitive goes into the redirect: only a short result code.
router.get('/callback', optionalAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.student) return res.redirect(302, `${config.clientUrl}/login`);
  try {
    await oauth.completeConnect(req.student, { code: req.query.code, state: req.query.state, error: typeof req.query.error === 'string' ? req.query.error : undefined });
    back(res, { github: 'connected' });
  } catch (err) { const e = asHttp(err); back(res, { github: 'error', reason: e instanceof HttpError && e.code ? String(e.code).slice(0, 40) : 'GITHUB_ERROR' }); }
});

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(requireAuth);

router.get('/status', applicationReadLimiter, wrap((req) => studentStatus(req.student.id)));
router.post('/connect', taskSubmitLimiter, wrap((req) => oauth.beginConnect(req.student)));
router.delete('/', taskSubmitLimiter, wrap((req) => oauth.disconnect(req.student)));

// ---- the repository of one assignment ----
const taskId = (req) => req.params.id;
router.get('/tasks/:id/repository', applicationReadLimiter, wrap((req) => {
  const eligibility = repos.eligibilityFor(taskId(req), req.student);
  const repo = repos.repositoryForTask(taskId(req), req.student);
  return { integration: publicState(), eligibility, repository: repos.repositoryView(repo), account: studentStatus(req.student.id).account };
}));
router.post('/tasks/:id/repository', taskSubmitLimiter, wrap(async (req, res) => { const r = await repos.createOrganizationRepository(taskId(req), { student: req.student }); res.status(r.created ? 201 : 200); return { created: r.created, repository: repos.repositoryView(r.repository), note: 'GitHub may email you an invitation to the repository. Accept it to start pushing.' }; }));
router.post('/tasks/:id/repository/link', taskSubmitLimiter, wrap(async (req, res) => { const r = await repos.linkRepository(req.student, taskId(req), req.body); res.status(201); return { repository: repos.repositoryView(r.repository), checkedWithGitHub: r.checkedWithGitHub }; }));
router.delete('/tasks/:id/repository/link', taskSubmitLimiter, wrap((req) => repos.unlinkRepository(req.student, taskId(req))));
router.post('/tasks/:id/repository/verify-ownership', taskSubmitLimiter, wrap(async (req) => { const r = await repos.verifyOwnership(req.student, taskId(req)); return { repository: repos.repositoryView(r.repository), ownership: r.ownership }; }));
router.post('/tasks/:id/repository/inspect', taskSubmitLimiter, wrap(async (req) => {
  const repo = repos.repositoryForTask(taskId(req), req.student);
  if (!repo) throw notFound('No repository is linked to this task.', 'REPOSITORY_NOT_FOUND');
  if (!canCallGitHub()) throw new HttpError(503, 'GitHub integration is not set up yet.', { code: 'GITHUB_NOT_CONFIGURED' });
  const r = await inspect(repo, { requestedBy: req.student.id, studentActor: true });
  return { repository: repos.repositoryView(r.repository), inspection: snapshotView(gh.latestSnapshot(repo.id)) };
}));
router.get('/tasks/:id/repository/inspection', applicationReadLimiter, wrap((req) => {
  const repo = repos.repositoryForTask(taskId(req), req.student);
  if (!repo) throw notFound('No repository is linked to this task.', 'REPOSITORY_NOT_FOUND');
  return { repository: repos.repositoryView(repo), inspection: snapshotView(gh.latestSnapshot(repo.id)) };
}));

// ---- Stage 09C Part 2A: GitHub project submission and its history ----
router.post('/tasks/:id/submissions', taskSubmitLimiter, wrap(async (req, res) => { const r = await project.submitGithubProject(req.student, taskId(req), req.body); res.status(201); const view = taskView.studentTaskView(req.student, taskId(req)); return { ...view, ...r, submissionState: view.submission }; }));
router.get('/tasks/:id/submissions', applicationReadLimiter, wrap((req) => project.submissionHistory(req.student, taskId(req))));

export default router;
