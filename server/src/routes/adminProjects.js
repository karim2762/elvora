import { Router } from 'express';
import { requireAdminSession } from '../auth/admin.js';
import * as projects from '../services/projectEvaluation.js';
import * as evidence from '../services/githubProject.js';
import { asHttp } from '../github/errors.js';

// Stage 09B Part 2B — administrator API for GitHub project submissions and their evaluation. Mounted inside routes/admin.js AFTER the shared
// guards (rate limit, admin auth, "shared key is read-only"), at /admin/projects. Reads accept the console key; EVERY write needs a signed-in
// administrator session, so each decision is tied to a named account and written to the audit log. Students never reach this router: a
// student session gets 403 from the shared guard, and no student route can write a score, a decision or a status.
const router = Router();
const write = requireAdminSession;
const wrap = (fn) => (req, res, next) => { try { res.status(200).json(fn(req)); } catch (err) { next(err); } };

router.get('/', wrap((req) => projects.listProjects(req.query)));
router.get('/options', wrap(() => projects.filterOptions()));
router.get('/:id', wrap((req) => projects.projectDetail(req.params.id)));
router.post('/:id/start-review', write, wrap((req) => projects.startReview(req.params.id, req.admin)));
router.put('/:id/evaluation', write, wrap((req) => projects.saveDraft(req.params.id, req.body, req.admin)));
router.post('/:id/decision', write, wrap((req) => projects.finalize(req.params.id, req.body, req.admin)));

// Stage 09C Part 2A — repository evidence and internal notes. Reads accept the console key; refresh and notes need an administrator SESSION.
// None of these changes a submission status: approving, requesting changes and rejecting stay in POST /:id/decision.
const wrapAsync = (fn) => async (req, res, next) => { try { res.status(200).json(await fn(req)); } catch (err) { next(asHttp(err)); } };
router.get('/:id/github', wrap((req) => evidence.evidenceFor(req.params.id)));
router.post('/:id/github/refresh', write, wrapAsync((req) => evidence.refreshEvidence(req.params.id, req.admin)));
router.get('/:id/notes', wrap((req) => evidence.reviewNotes(req.params.id)));
router.post('/:id/notes', write, wrap((req) => evidence.addReviewNote(req.params.id, req.body, req.admin)));

export default router;
