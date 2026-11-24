import crypto from 'node:crypto';
import { db } from './index.js';

// Stage 10A Part 1 — all SQL for the private Priority Certificate Processing feature. Every student read is scoped by student_id.
const now = () => new Date().toISOString();
export const isConstraint = (err) => String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT');

// ---- pricing ----
const toPrice = (r) => r && ({ id: r.id, durationDays: r.duration_days, months: r.months, amountPaise: r.amount_paise, currency: r.currency, taxNote: r.tax_note, active: r.active === 1 });
export const activePrices = () => db.prepare('SELECT * FROM priority_pricing WHERE active = 1 ORDER BY duration_days').all().map(toPrice);
export const activePriceFor = (days) => toPrice(db.prepare('SELECT * FROM priority_pricing WHERE active = 1 AND duration_days = ?').get(days));
// Replace the active price for a duration. The old row is kept (retired), so requests that snapshot it stay valid.
export function setPrice({ durationDays, months, amountPaise, taxNote }) {
  return db.transaction(() => {
    const t = now();
    db.prepare('UPDATE priority_pricing SET active = 0, retired_at = ? WHERE duration_days = ? AND active = 1').run(t, durationDays);
    const id = `PRC-${durationDays}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    db.prepare('INSERT INTO priority_pricing (id, duration_days, months, amount_paise, currency, tax_note, active, created_at) VALUES (?, ?, ?, ?, \'INR\', ?, 1, ?)').run(id, durationDays, months, amountPaise, taxNote, t);
    return id;
  })();
}

// ---- invitations ----
const toInvite = (r) => r && ({ id: r.id, studentId: r.student_id, maxUses: r.max_uses, useCount: r.use_count, redeemedBy: r.redeemed_by, redeemedAt: r.redeemed_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, createdAt: r.created_at });
export function insertInvitation({ tokenHash, studentId, maxUses, expiresAt, createdBy }) {
  const id = `PINV-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  db.prepare('INSERT INTO priority_invitations (id, token_hash, student_id, max_uses, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, tokenHash, studentId, maxUses, expiresAt, createdBy, now());
  return id;
}
export const findInvitationByHash = (h) => toInvite(db.prepare('SELECT * FROM priority_invitations WHERE token_hash = ?').get(h));
export const findInvitationById = (id) => toInvite(db.prepare('SELECT * FROM priority_invitations WHERE id = ?').get(id));
export const invitationsRedeemedBy = (studentId) => db.prepare('SELECT * FROM priority_invitations WHERE redeemed_by = ? ORDER BY redeemed_at DESC').all(studentId).map(toInvite);
export const revokeInvitation = (id) => db.prepare('UPDATE priority_invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id).changes;
// Atomic redemption: the WHERE clause re-checks every rule, so two simultaneous redemptions can't exceed max_uses.
export const redeemInvitation = (id, studentId) => db.prepare(`UPDATE priority_invitations SET use_count = use_count + 1, redeemed_by = ?, redeemed_at = ?
  WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND use_count < max_uses AND (student_id IS NULL OR student_id = ?)`).run(studentId, now(), id, now(), studentId).changes;

// ---- the student's own applications / internship records ----
export const applicationsForStudent = (studentId) => db.prepare(`SELECT a.id, a.internship_id, a.internship_title, a.internship_category, a.internship_duration_days, a.status AS application_status,
    e.id AS enrollment_id FROM applications a LEFT JOIN enrollments e ON e.application_id = a.id AND e.student_id = a.student_id
    WHERE a.student_id = ? ORDER BY a.submitted_at DESC, a.id`).all(studentId)
  .map((r) => ({ applicationId: r.id, internshipId: r.internship_id, title: r.internship_title, category: r.internship_category, durationDays: r.internship_duration_days, applicationStatus: r.application_status, enrollmentId: r.enrollment_id }));
export const applicationOwned = (applicationId, studentId) => applicationsForStudent(studentId).find((a) => a.applicationId === applicationId) ?? null;

// ---- eligibility checks (append-only) ----
export function insertCheck({ studentId, applicationId, enrollmentId, state, eligible, reasons, checks }) {
  const id = `PEC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  db.prepare('INSERT INTO priority_eligibility_checks (id, student_id, application_id, enrollment_id, state, eligible, reasons, checks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, studentId, applicationId, enrollmentId, state, eligible ? 1 : 0, JSON.stringify(reasons), JSON.stringify(checks), now());
  return id;
}

// ---- requests ----
const toRequest = (r) => r && ({
  id: r.id, status: r.status, applicationId: r.application_id, enrollmentId: r.enrollment_id, durationDays: r.duration_days,
  price: { priceId: r.price_id, amountPaise: r.amount_paise, currency: r.currency, taxNote: r.tax_note },
  personalConfirmedAt: r.personal_confirmed_at, academicConfirmedAt: r.academic_confirmed_at, createdAt: r.created_at, updatedAt: r.updated_at,
  instant: r.instant === 1, documentId: r.document_id ?? null, studentId: r.student_id,
});
export const requestsForStudent = (studentId) => db.prepare('SELECT * FROM priority_requests WHERE student_id = ? ORDER BY created_at DESC, id').all(studentId).map(toRequest);
export const requestOwned = (id, studentId) => toRequest(db.prepare('SELECT * FROM priority_requests WHERE id = ? AND student_id = ?').get(id, studentId));
export const openRequestForEnrollment = (enrollmentId, studentId) => toRequest(db.prepare(
  "SELECT * FROM priority_requests WHERE enrollment_id = ? AND student_id = ? AND status NOT IN ('Rejected', 'Cancelled', 'Refunded', 'Certificate Issued')").get(enrollmentId, studentId));
export const addHistory = (requestId, { from = null, to, note = null, actor }) =>
  db.prepare('INSERT INTO priority_request_history (request_id, from_status, to_status, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, from, to, note, actor, now());
export const historyOwned = (requestId, studentId) => db.prepare(`SELECT h.* FROM priority_request_history h JOIN priority_requests r ON r.id = h.request_id
  WHERE h.request_id = ? AND r.student_id = ? ORDER BY h.id`).all(requestId, studentId).map((h) => ({ from: h.from_status, to: h.to_status, note: h.note, actor: h.actor, at: h.created_at }));
export function insertDraft({ studentId, application, enrollmentId, price, checkId, personal, academic, instant = false }) {
  const id = `PRQ-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; const t = now();
  db.prepare(`INSERT INTO priority_requests (id, student_id, application_id, enrollment_id, status, duration_days, price_id, amount_paise, currency, tax_note,
    personal_confirmed_at, academic_confirmed_at, last_check_id, created_at, updated_at, instant) VALUES (?, ?, ?, ?, 'Draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, studentId, application.applicationId, enrollmentId, price.durationDays, price.id, price.amountPaise, price.currency, price.taxNote, personal ? t : null, academic ? t : null, checkId, t, t, instant ? 1 : 0);
  addHistory(id, { to: 'Draft', note: instant ? 'Draft saved for a paid certificate plan.' : 'Draft saved after a passing eligibility check.', actor: 'student' });
  return id;
}
export const updateDraftConfirmations = (id, studentId, { personal, academic, checkId }) => db.prepare(`UPDATE priority_requests SET personal_confirmed_at = ?, academic_confirmed_at = ?, last_check_id = ?, updated_at = ?
  WHERE id = ? AND student_id = ? AND status = 'Draft'`).run(personal ? now() : null, academic ? now() : null, checkId, now(), id, studentId).changes;

// ---- instant-certificate plans ----
export const requestById = (id) => toRequest(db.prepare('SELECT * FROM priority_requests WHERE id = ?').get(id));
// Verified instant requests whose certificate has not been issued yet (self-healing: retried when the student opens the page).
export const instantVerifiedForStudent = (studentId) => db.prepare("SELECT * FROM priority_requests WHERE student_id = ? AND instant = 1 AND status = 'Payment Verified' ORDER BY created_at").all(studentId).map(toRequest);
export const instantVerifiedAll = () => db.prepare("SELECT * FROM priority_requests WHERE instant = 1 AND status = 'Payment Verified' ORDER BY created_at").all().map(toRequest);
export const instantRequestsForStudent = (studentId) => db.prepare('SELECT * FROM priority_requests WHERE student_id = ? AND instant = 1 ORDER BY created_at DESC, id').all(studentId).map(toRequest);
