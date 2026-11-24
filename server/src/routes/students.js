import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseProfileUpdate } from '../utils/validation.js';
import { toPublicStudent } from '../utils/profile.js';
import { requireAuth } from '../auth/session.js';
import * as students from '../db/students.js';

// Every route here acts on req.student (from the session cookie). There is no :id parameter anywhere,
// so a student can never read or change someone else's profile.
const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(requireAuth);

router.get('/me', (req, res) => res.json({ user: toPublicStudent(req.student) }));

router.put('/me', asyncHandler(async (req, res) => {
  const data = parseProfileUpdate(req.body); // whitelisted fields only; email/password/id are ignored
  res.json({ user: toPublicStudent(students.updateProfile(req.student.id, data)) });
}));

export default router;
