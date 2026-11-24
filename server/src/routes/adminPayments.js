import express, { Router } from 'express';
import * as refunds from '../services/paymentRefunds.js';
import * as overdue from '../services/paymentOverdue.js';
import * as pay from '../services/payments.js';
import * as review from '../services/paymentReview.js';
import * as fin from '../services/paymentFinancials.js';
import { adminPaymentWriteLimiter, adminExportLimiter } from '../auth/rateLimit.js';
import * as plan from '../services/instantCertificate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { notFound } from '../utils/errors.js';

// Stage 10B Part 1 — mounted at /admin/priority-payments behind requireAdminSession. Each route also needs its own permission (the role 'admin' alone is not enough).
const router = Router();
// Stage 10C: every state-changing admin payment call (config, pricing, confirm, reject, refunds) shares one per-administrator budget.
router.use((req, res, next) => (['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? next() : adminPaymentWriteLimiter(req, res, next)));
const j = (fn) => (req, res, next) => { try { res.json(fn(req)); } catch (e) { next(e); } };
router.get('/pricing', pay.requirePermission('pricing.manage'), j(() => pay.adminPricing()));
router.put('/pricing', pay.requirePermission('pricing.manage'), j((req) => pay.updatePricing(req.admin, req.body)));
router.get('/pricing/history', pay.requirePermission('pricing.manage'), j(() => pay.pricingHistory()));
router.get('/config', pay.requirePermission('payment.configure'), j(() => pay.getAdminConfig()));
router.put('/config', pay.requirePermission('payment.configure'), j((req) => pay.updateConfig(req.admin, req.body)));
router.put('/config/qr', pay.requirePermission('payment.configure'), express.raw({ type: ['image/png', 'image/jpeg'], limit: 600 * 1024 }), j((req) => pay.setQrImage(req.admin, req.body, req.query.confirm)));
router.get('/config/qr', pay.requirePermission('payment.configure'), (req, res, next) => { try { const q = pay.readQrImage(); res.set({ 'Content-Type': q.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.send(q.buffer); } catch (e) { next(e); } });
router.get('/permissions', j((req) => ({ permissions: pay.PERMISSIONS.filter((p) => pay.can(req.admin, p)) }))); // lets the console show only what this admin may use
// Stage 10B Part 2A — verification. Fixed paths above are declared before the '/:id' routes. Every route needs 'payment.review'; decisions are re-checked in the service.
const idOk = (req, _res, next) => (typeof req.params.id === 'string' && /^PAY-[A-Z0-9]{6,20}$/.test(req.params.id) ? next() : next(notFound('Payment not found', 'PAYMENT_NOT_FOUND')));
const R = pay.requirePermission('payment.review');
// Stage 10B Part 2B — overdue reporting and manual refunds. Fixed paths come before '/:id'. Refunds need their own 'payment.refund' permission (checked again in the service).
const RF = pay.requirePermission('payment.refund'); const rid = (req, _res, next) => (/^RFD-[A-Z0-9]{6,20}$/.test(req.params.refundId) ? next() : next(notFound('Refund not found', 'REFUND_NOT_FOUND')));
// Stage 10C Part 1 — financial reports and CSV export need the separate 'payment.report' permission (checked again in the service). Declared before '/:id'.
const RP = pay.requirePermission('payment.report');
router.get('/reports/summary', adminExportLimiter, RP, j((req) => fin.summary(req.admin, req.query)));
router.get('/reports/transactions', adminExportLimiter, RP, j((req) => fin.transactions(req.admin, req.query)));
router.get('/reports/transactions.csv', adminExportLimiter, RP, (req, res, next) => { try { const f = fin.exportCsv(req.admin, req.query); res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${f.filename}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'X-Row-Count': String(f.rows) }); res.send(f.body); } catch (e) { next(e); } });
router.get('/overdue', R, j(() => overdue.overdueReport()));
router.get('/refunds', RF, j((req) => refunds.listRefunds(req.query)));
router.get('/refunds/:refundId', RF, rid, j((req) => refunds.historyFor(req.params.refundId)));
router.post('/refunds/:refundId/pending', RF, rid, j((req) => refunds.markPending(req.admin, req.params.refundId, req.body)));
router.post('/refunds/:refundId/complete', RF, rid, j((req) => refunds.completeRefund(req.admin, req.params.refundId, req.body)));
router.post('/refunds/:refundId/reject', RF, rid, j((req) => refunds.rejectRefund(req.admin, req.params.refundId, req.body)));
router.get('/queue', R, j((req) => review.queue(req.query)));
router.get('/:id', R, idOk, j((req) => review.detail(req.admin, req.params.id)));
router.get('/:id/history', R, idOk, j((req) => review.history(req.params.id)));
router.get('/:id/duplicates', R, idOk, j((req) => review.duplicates(req.params.id)));
router.get('/:id/refunds', RF, idOk, j((req) => refunds.summaryFor(req.params.id)));
router.post('/:id/refunds', RF, idOk, (req, res, next) => { try { res.status(201).json(refunds.createRefund(req.admin, req.params.id, req.body)); } catch (e) { next(e); } });
router.post('/:id/confirm', R, idOk, asyncHandler(async (req, res) => { const out = review.confirm(req.admin, req.params.id, req.body); const certificate = await plan.fulfilForPayment(req.params.id); res.json(certificate ? { ...out, certificate } : out); })); // a paid 1/2/3-month plan gets its certificate right after verification
router.post('/:id/reject', R, idOk, j((req) => review.reject(req.admin, req.params.id, req.body)));
const sendProof = (res, f) => { res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="payment-proof.${f.ext}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.send(f.buffer); };
router.get('/:id/proof/:proofId', R, idOk, (req, res, next) => { try { sendProof(res, review.proof(req.admin, req.params.id, req.params.proofId, pay.readProof)); } catch (e) { next(e); } });
router.get('/:id/proof', R, idOk, (req, res, next) => { try { const id = pay.proofIdFor(req.params.id); sendProof(res, review.proof(req.admin, req.params.id, id, pay.readProof)); } catch (e) { next(e); } });
export default router;
