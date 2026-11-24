import { Router } from 'express';
import { notFound } from '../utils/errors.js';
import { listPublic, getPublic } from '../services/internshipListings.js';

// Stage 07B: public, read-only catalogue. Only published, non-archived internships are ever returned, so administrator changes
// (publish, unpublish, archive, edits) show up on the public pages immediately.
// Stage 08A response shape: the named key (`internships` / `internship`) matches every other endpoint and is what the client reads.
// `data` is kept as a deprecated alias with identical content so existing integrations keep working; remove it only with an API version bump.
const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/', (_req, res) => { const internships = listPublic(); res.json({ internships, data: internships }); });
router.get('/:id', (req, res, next) => {
  const i = getPublic(req.params.id);
  return i ? res.json({ internship: i, data: i }) : next(notFound('Internship not found', 'INTERNSHIP_NOT_FOUND'));
});
export default router;
