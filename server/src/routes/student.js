import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { applicationReadLimiter, passwordChangeLimiter, unreadPollLimiter, taskSubmitLimiter } from '../auth/rateLimit.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { notFound, HttpError } from '../utils/errors.js';
import { DOCUMENT_ID_RE } from '../utils/documentId.js';
import { parseProfilePatch, parsePasswordChange, parseNotificationsQuery } from '../utils/validation.js';
import { toPublicStudent } from '../utils/profile.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { currentTokenHash } from '../auth/session.js';
import { listStudentDocuments, getOwnedDocument, toStudentDocument, resolveFile } from '../services/documents.js';
import * as students from '../db/students.js';
import * as sessions from '../db/sessions.js';
import * as notifications from '../db/notifications.js';
import { buildDashboard } from '../services/dashboard.js';
import { listStudentInternships } from '../services/enrollments.js';
import * as taskView from '../services/internshipTasks.js';
import studentGithub from './studentGithub.js';

// Student-only area. requireAuth only accepts a valid student session cookie (admins use X-Admin-Key and have no
// session), so other callers get 401. There is no :id or query parameter: the student is always req.student.
const router = Router();
// Stage 09C: GitHub routes are mounted BEFORE the shared guard because the OAuth callback does its own sign-in handling (redirect, not JSON 401).
router.use('/github', studentGithub);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(requireAuth);

router.get('/dashboard', applicationReadLimiter, (req, res) => res.json(buildDashboard(req.student)));

// The student's own approved internships (with progress timeline). Read-only: students cannot activate, complete,
// suspend or cancel an internship; those are administrator actions (routes/admin.js). No parameters, so there is no ID to tamper with.
router.get('/internships', applicationReadLimiter, (req, res) => res.json({ internships: listStudentInternships(req.student) }));

// ---- Stage 09B: the student's assigned tasks and the full instructions for each (read-only; the student is always req.student) ----
router.get('/tasks', applicationReadLimiter, (req, res) => res.json(taskView.listForStudent(req.student)));
router.get('/tasks/:id', applicationReadLimiter, (req, res, next) => { try { res.json(taskView.studentTaskView(req.student, req.params.id)); } catch (err) { next(err); } });

// Stage 09B Part 2A: start a task and submit (or resubmit) its work. The student is always req.student; the task ID in the path is looked
// up WITHIN that student's own assignments, so another student's task is a plain 404. Only the documented fields of the body are read.
router.post('/tasks/:id/start', applicationReadLimiter, (req, res, next) => { try { taskView.startTask(req.student, req.params.id); res.json(taskView.studentTaskView(req.student, req.params.id)); } catch (err) { next(err); } });
// The saved submission wins in the response; the live task state stays available as submissionState.
router.post('/tasks/:id/submissions', taskSubmitLimiter, (req, res, next) => {
  try { const r = taskView.submitWork(req.student, req.params.id, req.body); const view = taskView.studentTaskView(req.student, req.params.id); res.status(201).json({ ...view, submission: r.submission, submissionState: view.submission }); } catch (err) { next(err); }
});

// ---- Stage 05C ----
// Documents: only officially issued documents of the signed-in student. A wrong, foreign or malformed ID is always the same 404.
router.get('/documents', applicationReadLimiter, (req, res) => res.json({ documents: listStudentDocuments(req.student) }));
const ownedId = (req) => { if (!DOCUMENT_ID_RE.test(req.params.id)) throw notFound('Document not found', 'DOCUMENT_NOT_FOUND'); return req.params.id; };
router.get('/documents/:id', applicationReadLimiter, (req, res) => res.json({ document: toStudentDocument(getOwnedDocument(ownedId(req), req.student)) }));
// Authenticated file endpoint (cookie session). ?download=1 forces a download; otherwise the PDF is shown inline for preview.
router.get('/documents/:id/file', applicationReadLimiter, (req, res, next) => {
  let file;
  try { file = resolveFile(ownedId(req), req.student); } catch (err) { return next(err); }
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  });
  res.sendFile(file.path, { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) next(notFound('This document’s file is not available right now. Please contact ELVORA support.', 'DOCUMENT_FILE_MISSING')); });
});

// Notifications. The two fixed paths are declared before /:id so "read-all" is never read as an ID.
router.get('/notifications', applicationReadLimiter, (req, res) => {
  const { unreadOnly, page, pageSize } = parseNotificationsQuery(req.query);
  const probe = notifications.pageForStudent(req.student.id, { unreadOnly, limit: 1, offset: 0 });
  const totalPages = Math.max(1, Math.ceil(probe.total / pageSize));
  const current = Math.min(page, totalPages);
  const { total, rows } = notifications.pageForStudent(req.student.id, { unreadOnly, limit: pageSize, offset: (current - 1) * pageSize });
  res.json({ notifications: rows, pagination: { page: current, pageSize, total, totalPages }, unreadCount: notifications.unreadCount(req.student.id) });
});
router.get('/notifications/unread-count', unreadPollLimiter, (req, res) => res.json({ unreadCount: notifications.unreadCount(req.student.id) }));
router.patch('/notifications/read-all', applicationReadLimiter, (req, res) => {
  const updated = notifications.markAllRead(req.student.id);
  res.json({ updated, unreadCount: 0 });
});
router.patch('/notifications/:id/read', applicationReadLimiter, (req, res, next) => {
  const found = /^[0-9a-f-]{36}$/i.test(req.params.id) ? notifications.markRead(req.params.id, req.student.id) : null;
  if (!found) return next(notFound('Notification not found', 'NOTIFICATION_NOT_FOUND'));
  res.json({ notification: found, unreadCount: notifications.unreadCount(req.student.id) });
});

// Profile. Same record and rules as the Stage 04A /students/me routes; PATCH accepts a subset of fields.
router.get('/profile', applicationReadLimiter, (req, res) => res.json({ profile: toPublicStudent(req.student) }));
router.patch('/profile', applicationReadLimiter, (req, res) => {
  const data = parseProfilePatch(req.body, req.student);
  res.json({ profile: toPublicStudent(students.updateProfile(req.student.id, data)) });
});

// Password change. The current password is verified on the server; other devices are signed out, this one stays signed in.
router.patch('/change-password', passwordChangeLimiter, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = parsePasswordChange(req.body, req.student);
  if (!(await verifyPassword(currentPassword, req.student.passwordHash))) {
    res.locals.wrongPassword = true; // counted by passwordChangeLimiter
    throw new HttpError(400, 'Your current password is incorrect', { code: 'INVALID_CURRENT_PASSWORD', fields: { currentPassword: 'Your current password is incorrect' } });
  }
  students.setPasswordHash(req.student.id, await hashPassword(newPassword));
  const keep = currentTokenHash(req);
  if (keep) sessions.deleteOtherSessions(req.student.id, keep); else sessions.deleteSessionsForStudent(req.student.id);
  res.json({ ok: true, message: 'Password updated. Other devices have been signed out.' });
}));

export default router;
