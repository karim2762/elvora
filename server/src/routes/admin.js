import express, { Router } from 'express';
import { notFound } from '../utils/errors.js';
import { APPLICATION_ID_RE } from '../utils/applicationId.js';
import { parseStatusChange, parseReviewNote, parseListingsQuery, parseApplicationsQuery, APPLICATION_STATUSES } from '../utils/validation.js';
import * as listingRepo from '../db/internshipListings.js';
import { createListing, editListing, applyAction, deleteListing, getListing, toAdminView } from '../services/internshipListings.js';
import { CATEGORIES, DURATIONS, DIFFICULTIES, INTERNSHIP_TYPES } from '../internships/categories.js';
import { requireAdmin, requireAdminSession } from '../auth/admin.js';
import { buildAdminDashboard } from '../services/adminDashboard.js';
import { adminLimiter } from '../auth/rateLimit.js';
import * as applications from '../db/applications.js';
import * as enrollments from '../db/enrollments.js';
import { ENROLLMENT_ID_RE } from '../utils/enrollmentId.js';
import { createEnrollment, updateEnrollmentDetails, changeEnrollmentStatus } from '../services/enrollments.js';
import * as lifecycle from '../services/internshipLifecycle.js';
import * as schedule from '../services/internshipSchedule.js';
import { fulfilForEnrollment } from '../services/instantCertificate.js';
import * as studentAdmin from '../services/studentAdmin.js';
import { HttpError } from '../utils/errors.js';
import { config } from '../config/index.js';
import { issueDocument } from '../services/documents.js';
import * as documentSystem from '../documents/service.js';
import { issueGenerated, revokeDocument, toAdminDocument, adminFile } from '../documents/issuance.js';
import * as documentRecords from '../db/documents.js';
import { DOCUMENT_ID_RE } from '../utils/documentId.js';
import { DOCUMENT_TYPES, DOCUMENT_STATUSES } from '../documents/constants.js';
import { parseIssueRequest, parseRevokeRequest } from '../utils/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseCertificateDecision } from '../utils/validation.js';
import { decideCertificate } from '../services/certificateApproval.js';
import { runNow, kick, status as automationStatus } from '../automation/worker.js';
import * as adminDocuments from '../services/adminDocuments.js';
import { issueInstantOffer, pickableListings } from '../services/quickOffer.js';
import * as announcementService from '../services/announcements.js';
import * as settingsService from '../services/settings.js';
import { listAuditLogs } from '../services/auditLogs.js';
import { record as audit } from '../db/audit.js';
import adminTasksRouter from './adminTasks.js';
import adminProjectsRouter from './adminProjects.js';
import adminGithubRouter from './adminGithub.js';
import adminPaymentsRouter from './adminPayments.js';
import adminPriorityRouter from './adminPriority.js';

// Only administrators can change an application's status. There is no student-facing route that writes status.
const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// Stage 07A: the role-based dashboard. It needs a signed-in ADMINISTRATOR session (the shared ADMIN_API_KEY is not enough here),
// so the identity it shows always comes from the server-side session. Registered before the console guard below on purpose.
router.get('/dashboard', adminLimiter, requireAdminSession, (req, res) => res.json(buildAdminDashboard(req.admin)));

// Stage 10A Part 2: priority requests and free corrections need a signed-in administrator session (never the shared key).
router.use('/priority-certificates', adminLimiter, requireAdminSession, adminPriorityRouter);
// Stage 10B Part 1: pricing, UPI configuration and payment proof need a named administrator session AND a specific permission.
router.use('/priority-payments', adminLimiter, requireAdminSession, adminPaymentsRouter);

router.use(adminLimiter, requireAdmin);

// Stage 08A: the shared ADMIN_API_KEY is READ-ONLY unless ADMIN_API_KEY_ALLOW_WRITES=true. Every route below that changes data (any method
// other than GET/HEAD/OPTIONS) needs a signed-in administrator session, so the action is recorded against a named account. A refused attempt
// is itself written to the audit log (key fingerprint only, never the key).
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.admin?.via !== 'key' || config.adminKeyWrites) return next();
  try { audit({ admin: req.admin, action: 'admin.access_denied', targetType: 'route', targetId: `${req.method} ${req.baseUrl}${req.path}`, result: 'failure', reason: 'Shared key cannot change data' }); }
  catch (e) { console.error('[audit] could not record a refused key write:', e.message); }
  return next(new HttpError(403, 'This action needs an administrator sign-in. The shared admin key is read-only.', { code: 'ADMIN_SESSION_REQUIRED' }));
});

// Console reads. GET /admin/me lets the admin page check a key before it shows anything.
router.get('/me', (_req, res) => res.json({ ok: true }));

// Stage 09A: task templates, internship tasks, criteria and application evaluation. Mounted before /applications/:id on purpose (see routes/adminTasks.js).
router.use(adminTasksRouter);
// Stage 09B Part 2B: GitHub project submissions and their evaluation.
router.use('/projects', adminProjectsRouter);
router.use('/github', adminGithubRouter); // Stage 09C Part 1

router.get('/applications', (req, res) => {
  const { status, page, pageSize } = parseApplicationsQuery(req.query);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const probe = applications.pageForAdmin({ status, q, limit: 1, offset: 0 });
  const totalPages = Math.max(1, Math.ceil(probe.total / pageSize));
  const current = Math.min(page, totalPages);
  const { total, rows } = applications.pageForAdmin({ status, q, limit: pageSize, offset: (current - 1) * pageSize });
  const byStatus = applications.countAllByStatus();
  const counts = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, byStatus[s] ?? 0]));
  counts.All = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({ applications: rows, pagination: { page: current, pageSize, total, totalPages }, counts });
});

router.get('/internships', (_req, res) => res.json({ internships: enrollments.listAllForAdmin().map((e) => ({ ...e, studentId: undefined })) }));

// ---- Stage 07B: application review (details, validated status changes with history, internal notes). Administrator only. ----
const appId = (req) => { if (!APPLICATION_ID_RE.test(req.params.id)) throw notFound('Application not found', 'APPLICATION_NOT_FOUND'); return req.params.id; };
router.get('/applications/:id', (req, res, next) => {
  try { const a = applications.adminDetails(appId(req)); if (!a) throw notFound('Application not found', 'APPLICATION_NOT_FOUND'); return res.json({ application: a }); } catch (err) { return next(err); }
});
router.post('/applications/:id/notes', (req, res, next) => {
  try {
    const { note } = parseReviewNote(req.body);
    const n = applications.addNote(appId(req), note, req.admin);
    if (!n) throw notFound('Application not found', 'APPLICATION_NOT_FOUND');
    audit({ admin: req.admin, action: 'application.note_add', targetType: 'application', targetId: req.params.id }); // the note text itself is not copied into the log
    return res.status(201).json({ note: n });
  } catch (err) { return next(err); }
});
router.patch('/applications/:id/status', (req, res, next) => {
  try {
    const { status, note } = parseStatusChange(req.body);
    const id = appId(req);
    // An application that already has an internship must stay Approved (change the internship instead).
    if (status !== 'Approved' && enrollments.findByApplication(id)) {
      throw new HttpError(409, 'This application already has an internship, so it must stay Approved.', { code: 'ENROLLMENT_EXISTS' });
    }
    const result = applications.changeStatus(id, status, { admin: req.admin, note });
    if (!result) throw notFound('Application not found', 'APPLICATION_NOT_FOUND');
    if (result.changed && status === 'Approved' && config.automation.enabled) kick(); // internship record + offer letter now, not at the next timer tick
    // Only reached after the transaction committed, so a success response always means the change and its notification are saved.
    return res.json({ application: applications.adminDetails(id) ?? result.application, changed: result.changed });
  } catch (err) { return next(err); }
});

// ---- Stage 07B: internship LISTINGS (the catalogue students browse and apply to). ----
// NB: /admin/internships (above/below) already means a student's internship RECORD (an enrollment), so listings live under their own path.
router.get('/internship-listings/options', (_req, res) => res.json({ categories: CATEGORIES.map(({ slug, label }) => ({ slug, label })), durations: DURATIONS, difficulties: DIFFICULTIES, types: INTERNSHIP_TYPES }));
router.get('/internship-listings', (req, res, next) => {
  try {
    const { state, category, page, pageSize, q } = parseListingsQuery(req.query);
    const probe = listingRepo.pageForAdmin({ q, category, state, limit: 1, offset: 0 });
    const totalPages = Math.max(1, Math.ceil(probe.total / pageSize));
    const current = Math.min(page, totalPages);
    const { total, rows } = listingRepo.pageForAdmin({ q, category, state, limit: pageSize, offset: (current - 1) * pageSize });
    return res.json({ internships: rows.map((r) => toAdminView(r, r.applicationCount)), pagination: { page: current, pageSize, total, totalPages }, counts: listingRepo.counts() });
  } catch (err) { return next(err); }
});
router.post('/internship-listings', (req, res, next) => { try { return res.status(201).json({ internship: createListing(req.body, req.admin) }); } catch (err) { return next(err); } });
router.get('/internship-listings/:id', (req, res, next) => { try { return res.json({ internship: getListing(req.params.id) }); } catch (err) { return next(err); } });
router.patch('/internship-listings/:id', (req, res, next) => { try { return res.json({ internship: editListing(req.params.id, req.body, req.admin) }); } catch (err) { return next(err); } });
router.patch('/internship-listings/:id/state', (req, res, next) => { try { return res.json({ internship: applyAction(req.params.id, req.body?.action, req.admin) }); } catch (err) { return next(err); } });
router.delete('/internship-listings/:id', (req, res, next) => { try { deleteListing(req.params.id, req.admin); return res.json({ deleted: true }); } catch (err) { return next(err); } });

// ---- Stage 05B: internships. Activation, completion, suspension and cancellation are administrator-only. ----
const enrollmentView = (e) => ({ ...e, studentId: undefined });
const withEnrollment = (handler) => (req, res, next) => {
  if (!ENROLLMENT_ID_RE.test(req.params.id)) return next(notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'));
  try { return res.json({ internship: enrollmentView(handler(req)) }); } catch (err) { return next(err); }
};

router.post('/applications/:id/internship', (req, res, next) => {
  if (!APPLICATION_ID_RE.test(req.params.id)) return next(notFound('Application not found', 'APPLICATION_NOT_FOUND'));
  try {
    const e = createEnrollment(req.params.id, req.body);
    audit({ admin: req.admin, action: 'internship.create', targetType: 'internship', targetId: e.id, reason: `Application ${req.params.id}` });
    return res.status(201).json({ internship: enrollmentView(e) });
  } catch (err) { return next(err); }
});
router.patch('/internships/:id', withEnrollment((req) => {
  const e = updateEnrollmentDetails(req.params.id, req.body, req.admin);
  audit({ admin: req.admin, action: 'internship.update', targetType: 'internship', targetId: req.params.id, reason: 'Details updated' });
  return e;
}));
// The generic status route is kept for the legacy console (X-Admin-Key). A signed-in administrator is routed through the strict
// lifecycle rules below (reasons, completion checks), so the dashboard can never complete an internship without them.
router.patch('/internships/:id/status', withEnrollment((req) => {
  const { status } = req.body ?? {};
  const strict = req.admin?.via === 'session';
  const body = req.body ?? {};
  let e;
  if (strict && status === 'Active') e = lifecycle.activate(req.params.id, body, req.admin);
  else if (strict && status === 'Suspended') e = lifecycle.suspend(req.params.id, body, req.admin);
  else if (strict && status === 'Cancelled') e = lifecycle.cancel(req.params.id, body, req.admin);
  else if (strict && status === 'Completed') e = lifecycle.complete(req.params.id, body, req.admin);
  else e = changeEnrollmentStatus(req.params.id, body, new Date(), req.admin);
  if (e.status === 'Completed' && config.automation.enabled) kick(); // an already-approved certificate is generated right away
  return e;
}));

// ---- Stage 07B: lifecycle actions. Administrator SESSION required (the shared key can't act here), every action is recorded with the admin's name. ----
const lifecycleRoute = (fn, { kickWorker = false } = {}) => (req, res, next) => {
  if (!ENROLLMENT_ID_RE.test(req.params.id)) return next(notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'));
  try {
    const e = fn(req.params.id, req.body ?? {}, req.admin);
    if (kickWorker && e.status === 'Completed' && config.automation.enabled) kick();
    return res.json({ internship: enrollmentView(e) });
  } catch (err) { return next(err); }
};
router.get('/internships/:id/lifecycle', requireAdminSession, (req, res, next) => {
  if (!ENROLLMENT_ID_RE.test(req.params.id)) return next(notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'));
  try { return res.json(lifecycle.lifecycleView(req.params.id)); } catch (err) { return next(err); }
});
router.patch('/internships/:id/schedule', requireAdminSession, async (req, res, next) => {
  if (!ENROLLMENT_ID_RE.test(req.params.id)) return next(notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'));
  try {
    const out = schedule.setSchedule(req.params.id, req.body ?? {}, req.admin);
    try { await fulfilForEnrollment(req.params.id); } catch { /* paid plans retry on the next background cycle */ }
    return res.json({ internship: enrollmentView(enrollments.findById(req.params.id)), earliestAllowed: out.earliestAllowed });
  } catch (err) { return next(err); }
});
router.patch('/internships/:id/activate', requireAdminSession, lifecycleRoute(lifecycle.activate));
router.patch('/internships/:id/progress', requireAdminSession, lifecycleRoute(lifecycle.updateProgress));
router.patch('/internships/:id/suspend', requireAdminSession, lifecycleRoute(lifecycle.suspend));
router.patch('/internships/:id/cancel', requireAdminSession, lifecycleRoute(lifecycle.cancel));
router.patch('/internships/:id/complete', requireAdminSession, lifecycleRoute(lifecycle.complete, { kickWorker: true }));

// ---- Stage 07B: students. Administrator SESSION required; passwords/tokens/roles are never returned or writable here. ----
router.get('/students', requireAdminSession, (req, res, next) => { try { return res.json(studentAdmin.listStudents(req.query)); } catch (err) { return next(err); } });
router.get('/students/:id', requireAdminSession, (req, res, next) => { try { return res.json(studentAdmin.studentDetail(req.params.id)); } catch (err) { return next(err); } });
router.patch('/students/:id/status', requireAdminSession, (req, res, next) => { try { return res.json(studentAdmin.changeAccountStatus(req.params.id, req.body, req.admin)); } catch (err) { return next(err); } });

// ---- Stage 07: certificate approval + automation (administrator only) ----
// The list of internships an administrator can decide on, newest decisions last. A certificate is only ever generated for "Approved".
router.get('/certificate-approvals', (_req, res) => res.json({ internships: enrollments.listForCertificateReview().map(enrollmentView) }));
router.patch('/internships/:id/certificate-decision', (req, res, next) => {
  if (!ENROLLMENT_ID_RE.test(req.params.id)) return next(notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'));
  try {
    const e = decideCertificate(req.params.id, parseCertificateDecision(req.body));
    audit({ admin: req.admin, action: 'certificate.decision', targetType: 'internship', targetId: req.params.id, reason: e.certificateReview.decision });
    if (e.certificateReview.decision === 'Approved' && config.automation.enabled) kick();
    return res.json({ internship: enrollmentView(e) });
  } catch (err) { return next(err); }
});
router.get('/automation', (_req, res) => res.json({ automation: automationStatus() }));
router.post('/automation/run', asyncHandler(async (req, res) => {
  const r = await runNow({ force: true });
  audit({ admin: req.admin, action: 'automation.run', targetType: 'automation', targetId: 'worker', reason: 'Manual run' });
  res.json({ result: { ...r, failures: r.failures.length }, automation: automationStatus() });
}));

// ---- Stage 05C ----
// Attach an OFFICIALLY ISSUED PDF (offer letter or certificate) to an internship. The platform never generates these (Stage 06).
// Body: the raw PDF (Content-Type: application/pdf). Query: type=offer_letter|certificate, optional title.
router.post('/internships/:id/documents', express.raw({ type: 'application/pdf', limit: config.maxDocumentBytes }), (req, res, next) => {
  if (!ENROLLMENT_ID_RE.test(req.params.id)) return next(notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'));
  try {
    const d = issueDocument(req.params.id, req.query, req.body, req.admin);
    return res.status(201).json({ document: { id: d.id, type: d.type, title: d.title, issuedAt: d.issuedAt, enrollmentId: d.enrollmentId } });
  } catch (err) { return next(err); }
});

// ---- Stage 06A: document system (administrator only; nothing here issues a document) ----
// Previews are full HTML pages meant for an iframe/new tab. Strict CSP: no scripts, no network, only inline styles and data: images.
const html = (res, body) => res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" }).send(body);
router.get('/document-templates', (_req, res) => res.json({ templates: documentSystem.templateSummary() }));
router.get('/document-templates/:type/preview', (req, res, next) => {
  try { return html(res, documentSystem.previewSample(req.params.type, { stress: req.query.stress === '1' })); } catch (err) { return next(err); }
});
router.get('/internships/:id/documents/:type/eligibility', (req, res, next) => {
  if (!ENROLLMENT_ID_RE.test(req.params.id)) return next(notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'));
  try { const { enrollment: _e, ...report } = documentSystem.eligibility(req.params.id, req.params.type); return res.json({ eligibility: report }); } catch (err) { return next(err); }
});
router.get('/internships/:id/documents/:type/preview', (req, res, next) => {
  if (!ENROLLMENT_ID_RE.test(req.params.id)) return next(notFound('Internship not found', 'ENROLLMENT_NOT_FOUND'));
  try { return html(res, documentSystem.previewForEnrollment(req.params.id, req.params.type)); } catch (err) { return next(err); }
});

// ---- Stage 06B: generate + issue PDFs, list/read records, download, revoke. Administrator only. ----
// The body names ONLY the internship; student, dates and title are always read from backend records.
const issueRoute = (type) => asyncHandler(async (req, res) => {
  const { internshipId, issuedBy } = parseIssueRequest(req.body);
  if (!ENROLLMENT_ID_RE.test(internshipId)) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  // A signed-in administrator is recorded under their own account name; only the shared key falls back to the self-declared label.
  const d = await issueGenerated({ type, enrollmentId: internshipId, issuedBy: req.admin?.fullName ?? issuedBy, admin: req.admin });
  res.status(201).json({ document: toAdminDocument(d, { events: true }) });
});
router.post('/documents/offer-letter', issueRoute('offer_letter'));
router.post('/documents/certificate', issueRoute('certificate'));

// ---- Instant offer letter: create/choose an internship for a student and issue the offer letter immediately. Administrator SESSION required. ----
router.get('/instant-offer/internships', requireAdminSession, (_req, res) => res.json({ internships: pickableListings(), categories: CATEGORIES.map(({ slug, label }) => ({ slug, label })), durations: DURATIONS }));
router.post('/instant-offer', requireAdminSession, asyncHandler(async (req, res) => {
  const result = await issueInstantOffer(req.body, req.admin);
  res.status(result.alreadyIssued ? 200 : 201).json(result);
}));

router.get('/documents', (req, res, next) => { try { return res.json(adminDocuments.listDocuments(req.query)); } catch (err) { return next(err); } });
const docId = (req) => { if (!DOCUMENT_ID_RE.test(req.params.id)) throw notFound('Document not found', 'DOCUMENT_NOT_FOUND'); return req.params.id; };
router.get('/documents/:id', (req, res, next) => {
  try { const d = documentRecords.findAny(docId(req)); if (!d) throw notFound('Document not found', 'DOCUMENT_NOT_FOUND'); return res.json({ document: toAdminDocument(d, { events: true }) }); } catch (err) { return next(err); }
});
router.get('/documents/:id/verify', (req, res, next) => { try { return res.json({ verification: adminDocuments.verifyDocument(docId(req)) }); } catch (err) { return next(err); } });
router.get('/documents/:id/history', (req, res, next) => { try { return res.json(adminDocuments.documentHistory(docId(req))); } catch (err) { return next(err); } });
router.get('/documents/:id/file', (req, res, next) => {
  let file;
  try { file = adminFile(docId(req)); } catch (err) { return next(err); }
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(file.path, { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) next(notFound('The stored file is missing.', 'DOCUMENT_FILE_MISSING')); });
});
router.patch('/documents/:id/revoke', (req, res, next) => {
  try { const r = parseRevokeRequest(req.body); const d = revokeDocument(docId(req), { ...r, revokedBy: req.admin?.fullName ?? r.revokedBy }, req.admin); return res.json({ document: toAdminDocument(d, { events: true }) }); } catch (err) { return next(err); }
});

// ---- Stage 07C: announcements, audit log, settings. ADMINISTRATOR SESSION required (the shared key can't send mass messages or change settings),
// so every record names a real administrator account. ----
// Announcement flow: POST /announcements/preview (recipient COUNT only) then POST /announcements with confirm:true and that count.
router.get('/announcements', requireAdminSession, (req, res, next) => { try { return res.json(announcementService.list(req.query)); } catch (err) { return next(err); } });
router.post('/announcements/preview', requireAdminSession, (req, res, next) => { try { return res.json(announcementService.preview(req.body)); } catch (err) { return next(err); } });
router.post('/announcements', requireAdminSession, (req, res, next) => { try { return res.status(201).json(announcementService.send(req.body, req.admin)); } catch (err) { return next(err); } });
router.get('/announcements/:id', requireAdminSession, (req, res, next) => { try { return res.json(announcementService.get(req.params.id)); } catch (err) { return next(err); } });
router.patch('/announcements/:id/withdraw', requireAdminSession, (req, res, next) => { try { return res.json({ announcement: announcementService.withdraw(req.params.id, req.body, req.admin) }); } catch (err) { return next(err); } });

// Audit log: read-only. There is no route that creates, edits or deletes an audit entry.
router.get('/audit-logs', requireAdminSession, (req, res, next) => { try { return res.json(listAuditLogs(req.query)); } catch (err) { return next(err); } });

router.get('/settings', requireAdminSession, (_req, res, next) => { try { return res.json({ settings: settingsService.view() }); } catch (err) { return next(err); } });
router.patch('/settings', requireAdminSession, (req, res, next) => { try { return res.json({ settings: settingsService.update(req.body, req.admin) }); } catch (err) { return next(err); } });
router.put('/settings/logo', requireAdminSession, express.raw({ type: ['image/png', 'image/jpeg'], limit: 600 * 1024 }), (req, res, next) => { try { return res.json({ settings: settingsService.setLogo(req.body, req.admin) }); } catch (err) { return next(err); } });
router.delete('/settings/logo', requireAdminSession, (req, res, next) => { try { return res.json({ settings: settingsService.removeLogo(req.admin) }); } catch (err) { return next(err); } });

export default router;
