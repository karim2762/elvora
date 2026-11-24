import { Router } from 'express';
import { requireAdminSession } from '../auth/admin.js';
import { HttpError, notFound } from '../utils/errors.js';
import { asHttp } from '../github/errors.js';
import { adminHealth } from '../github/status.js';
import * as repos from '../github/repositories.js';
import * as gh from '../db/github.js';
import { inspect, snapshotView, canCallGitHub } from '../github/inspect.js';

// Stage 09C Part 1 — administrator GitHub API, mounted inside routes/admin.js AFTER the shared guards, at /admin/github. Reads accept the console
// key; every write needs a signed-in administrator session so it is tied to a named account and audited.
const router = Router();
const wrap = (fn) => async (req, res, next) => { try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out); } catch (err) { next(asHttp(err)); } };
const find = (req) => { const repo = repos.repositoryForTask(req.params.id, null); if (!repo) throw notFound('No repository is linked to this task.', 'REPOSITORY_NOT_FOUND'); return repo; };

router.get('/status', wrap((req) => adminHealth({ live: req.query.live === '1' })));
router.get('/tasks/:id/repository', wrap((req) => { const repo = repos.repositoryForTask(req.params.id, null); return { repository: repos.repositoryView(repo, { admin: true }), inspection: repo ? snapshotView(gh.latestSnapshot(repo.id)) : null }; }));
router.post('/tasks/:id/repository', requireAdminSession, wrap(async (req, res) => { const r = await repos.createOrganizationRepository(req.params.id, { admin: req.admin }); res.status(r.created ? 201 : 200); return { created: r.created, repository: repos.repositoryView(r.repository, { admin: true }) }; }));
router.post('/tasks/:id/repository/inspect', requireAdminSession, wrap(async (req) => {
  const repo = find(req);
  if (!canCallGitHub()) throw new HttpError(503, 'GitHub integration is not set up yet.', { code: 'GITHUB_NOT_CONFIGURED' });
  const r = await inspect(repo, { requestedBy: req.admin.id, admin: req.admin });
  return { repository: repos.repositoryView(r.repository, { admin: true }), inspection: snapshotView(gh.latestSnapshot(repo.id)) };
}));

export default router;
