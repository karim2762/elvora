import express, { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { applicationReadLimiter, paymentWriteLimiter, paymentUploadLimiter } from '../auth/rateLimit.js';
import * as svc from '../services/priorityCertificate.js';
import * as plan from '../services/instantCertificate.js';
import { studentCorrections } from '../services/freeCorrections.js';
import * as pay from '../services/payments.js';
import * as refunds from '../services/paymentRefunds.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { config } from '../config/index.js';

// Private feature. Mounted only at /api/v1/priority-certificate; no public route links to it. Every handler uses req.student (from the session cookie)
// and the service re-checks ownership of any application/request ID, so a changed ID is a plain 404.
const router = Router();
router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }); next(); });
router.use(requireAuth);
router.use(applicationReadLimiter);
const h = (fn) => (req, res, next) => { try { res.json(fn(req)); } catch (e) { next(e); } };
const gated = (fn) => h((req) => { svc.requireAccess(req.student); return fn(req); });

// Free corrections are never invitation-gated: an ELVORA error is fixed for free whether or not the student uses the paid service.
router.get('/corrections', h((req) => studentCorrections(req.student.id)));
router.get('/access', h((req) => ({ access: svc.accessState(req.student) })));
router.post('/access', h((req) => ({ access: svc.redeem(req.student, req.body?.token) })));
router.get('/portal', gated((req) => ({ identity: svc.identity(req.student), notice: svc.SERVICE_NOTICE, pricing: svc.getPricing() })));
router.get('/pricing', gated(() => svc.getPricing()));
router.get('/options', gated((req) => svc.listOptions(req.student)));
router.get('/internships/:applicationId', gated((req) => svc.internshipDetail(req.student, req.params.applicationId)));
router.post('/eligibility', gated((req) => svc.checkEligibilityFor(req.student, req.body?.applicationId)));
router.post('/requests', (req, res, next) => { try { svc.requireAccess(req.student); const r = svc.createDraft(req.student, req.body); res.status(r.created ? 201 : 200).json(r); } catch (e) { next(e); } });
// 1/2/3-month plans with an instant certificate after payment verification. A verified-but-unissued plan is retried whenever the student lists requests.
router.get('/plans', gated((req) => plan.plans(req.student)));
router.post('/plans', (req, res, next) => { try { svc.requireAccess(req.student); const r = plan.choosePlan(req.student, req.body); res.status(r.created ? 201 : 200).json(r); } catch (e) { next(e); } });
router.get('/requests', asyncHandler(async (req, res) => { svc.requireAccess(req.student); await plan.fulfilPending(req.student); res.json(svc.listRequests(req.student)); }));
router.get('/requests/:id', gated((req) => ({ request: svc.getRequest(req.student, req.params.id) })));
router.get('/requests/:id/history', gated((req) => svc.requestHistory(req.student, req.params.id)));

// Stage 10B Part 1 — manual UPI payments. The amount and payee come from the server; no body field can set either. Every handler is scoped to req.student.
const ag = (fn) => asyncHandler(async (req, res) => { svc.requireAccess(req.student); res.json(await fn(req)); });
router.get('/pricing/version', gated(() => pay.pricingVersion()));
router.get('/payment-info', gated(() => pay.studentPaymentInfo()));
router.post('/requests/:id/payment-order', paymentWriteLimiter, asyncHandler(async (req, res) => { svc.requireAccess(req.student); const r = await pay.createOrder(req.student, req.params.id); res.status(r.created ? 201 : 200).json(r); }));
router.get('/payments', gated((req) => pay.listPayments(req.student)));
router.get('/payments/:id', ag((req) => pay.getPayment(req.student, req.params.id)));
router.get('/payments/:id/refunds', gated((req) => refunds.studentRefunds(req.student, req.params.id)));
router.get('/payment-qr', (req, res, next) => { try { svc.requireAccess(req.student); const q = pay.readQrImage(); res.set({ 'Content-Type': q.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }); res.send(q.buffer); } catch (e) { next(e); } });
router.get('/payments/:id/status', gated((req) => pay.statusFor(req.student, req.params.id)));
router.post('/payments/:id/proof', paymentUploadLimiter, express.raw({ type: ['image/png', 'image/jpeg', 'application/pdf'], limit: config.payments.maxProofBytes }),
  (req, res, next) => { try { svc.requireAccess(req.student); res.status(201).json(pay.uploadProof(req.student, req.params.id, req.body)); } catch (e) { next(e); } });
router.post('/payments/:id/resubmit', paymentWriteLimiter, (req, res, next) => { try { svc.requireAccess(req.student); res.status(201).json(pay.resubmitReference(req.student, req.params.id, req.body)); } catch (e) { next(e); } });
router.post('/payments/:id/submit', paymentWriteLimiter, (req, res, next) => { try { svc.requireAccess(req.student); res.status(201).json(pay.submitReference(req.student, req.params.id, req.body)); } catch (e) { next(e); } });
router.get('/payments/:id/proof/:proofId', (req, res, next) => { try { svc.requireAccess(req.student); const f = pay.readProof(req.params.id, req.params.proofId, req.student.id);
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="payment-proof.${f.ext}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }); res.send(f.buffer); } catch (e) { next(e); } });
export default router;
