import { Router } from 'express';
import authRoutes from './auth.js';
import studentRoutes from './students.js';
import applicationRoutes from './applications.js';
import adminRoutes from './admin.js';
import studentAreaRoutes from './student.js';
import publicRoutes from './public.js';
import internshipRoutes from './internships.js';
import priorityRoutes from './priorityCertificate.js';
import { db } from '../db/index.js';

const router = Router();

// Versioned REST API. Feature routers (auth, students, internships, documents...) mount here.
router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'elvora-api', time: new Date().toISOString() }));
// Readiness probe for hosting platforms: also proves the database file is open and readable. Reveals nothing about the error.
router.get('/health/ready', (_req, res) => {
  try { db.prepare('SELECT 1 AS ok').get(); res.json({ status: 'ok', database: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable', database: 'error' }); }
});
router.use('/auth', authRoutes);
router.use('/students', studentRoutes);
router.use('/student', studentAreaRoutes);
router.use('/applications', applicationRoutes);
router.use('/admin', adminRoutes);
router.use('/internships', internshipRoutes); // Stage 07B: public published-internship catalogue (read-only)
router.use('/priority-certificate', priorityRoutes); // Stage 10A: private, invitation-gated; never linked from public pages
router.use('/public', publicRoutes); // unauthenticated, read-only (Stage 06C document verification)

export default router;
