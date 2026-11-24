import { Router } from 'express';
import * as svc from '../services/adminPriority.js';
import * as cor from '../services/freeCorrections.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Stage 10A Part 2 — mounted at /admin/priority-certificates behind requireAdminSession (a named administrator account; the shared key never reaches here).
const router = Router();
const j = (fn) => (req, res, next) => { try { res.json(fn(req)); } catch (e) { next(e); } };
router.get('/requests', j((req) => svc.listRequests(req.query)));
router.get('/requests/:id', j((req) => svc.getRequest(req.params.id)));
router.post('/requests/:id/review', j((req) => svc.reviewEligibility(req.admin, req.params.id)));
router.post('/requests/:id/status', j((req) => svc.changeStatus(req.admin, req.params.id, req.body)));
router.post('/requests/:id/notes', j((req) => svc.addAdminNote(req.admin, req.params.id, req.body)));
router.post('/requests/:id/issue', asyncHandler(async (req, res) => res.json(await svc.issueCertificate(req.admin, req.params.id))));
// Stage 10C Part 2: every correction route needs the 'certificate.correct' permission (enforced again inside the service for create / approve / cancel).
router.use('/corrections', cor.requireCorrectionPermission);
router.get('/corrections', j((req) => cor.listCorrections(req.query)));
router.get('/corrections/students/:studentId/certificates', j((req) => cor.certificatesForStudent(req.params.studentId)));
router.post('/corrections', (req, res, next) => { try { res.status(201).json({ correction: cor.createCorrection(req.admin, req.body) }); } catch (e) { next(e); } });
router.get('/corrections/:id', j((req) => ({ correction: cor.correctionView(req.params.id) })));
router.post('/corrections/:id/approve', asyncHandler(async (req, res) => res.json({ correction: await cor.approveCorrection(req.admin, req.params.id) })));
router.post('/corrections/:id/cancel', j((req) => ({ correction: cor.cancelCorrection(req.admin, req.params.id, req.body) })));
export default router;
