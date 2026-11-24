import crypto from 'node:crypto';
import { db } from './index.js';

// Stage 10A Part 2 — SQL for administrator priority-request management and free corrections. Student-facing reads here are scoped by student_id.
const now = () => new Date().toISOString();
const esc = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
export const REQUEST_STATUSES = ['Draft', 'Eligibility Check', 'Awaiting Payment', 'Payment Pending', 'Payment Verified', 'Under Review', 'Approved for Issuance', 'Certificate Issued', 'Rejected', 'Correction Required', 'Cancelled', 'Refunded'];

// ---------- priority requests ----------
const toRow = (r) => r && ({
  id: r.id, status: r.status, studentId: r.student_id, studentName: r.full_name, applicationId: r.application_id, enrollmentId: r.enrollment_id,
  internshipTitle: r.internship_title, durationDays: r.duration_days, amountPaise: r.amount_paise, currency: r.currency,
  paid: r.paid_flag > 0 && ['Payment Verified', 'Under Review', 'Approved for Issuance', 'Certificate Issued'].includes(r.status),
  documentId: r.document_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});
const BASE = `FROM priority_requests r JOIN students s ON s.id = r.student_id JOIN applications a ON a.id = r.application_id`;
const COLS = `r.*, s.full_name, a.internship_title, (SELECT COUNT(*) FROM priority_request_history h WHERE h.request_id = r.id AND h.to_status = 'Payment Verified') AS paid_flag`;

export function pageRequests({ student, applicationId, requestId, durationDays, status, from, to, limit, offset }) {
  const where = []; const args = [];
  if (student) { where.push("s.full_name LIKE ? ESCAPE '\\'"); args.push(esc(student)); }
  if (applicationId) { where.push("r.application_id LIKE ? ESCAPE '\\'"); args.push(esc(applicationId)); }
  if (requestId) { where.push("r.id LIKE ? ESCAPE '\\'"); args.push(esc(requestId)); }
  if (durationDays) { where.push('r.duration_days = ?'); args.push(durationDays); }
  if (status) { where.push('r.status = ?'); args.push(status); }
  if (from) { where.push('r.created_at >= ?'); args.push(`${from}T00:00:00.000Z`); }
  if (to) { where.push('r.created_at <= ?'); args.push(`${to}T23:59:59.999Z`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n ${BASE} ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT ${COLS} ${BASE} ${w} ORDER BY r.created_at DESC, r.id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(toRow);
  return { total, rows };
}
export const requestById = (id) => toRow(db.prepare(`SELECT ${COLS} ${BASE} WHERE r.id = ?`).get(id));
export const countsByStatus = () => Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM priority_requests GROUP BY status').all().map((r) => [r.status, r.n]));
export const historyFor = (requestId) => db.prepare('SELECT * FROM priority_request_history WHERE request_id = ? ORDER BY id').all(requestId)
  .map((h) => ({ from: h.from_status, to: h.to_status, note: h.note, actor: h.actor, at: h.created_at }));
export const notesFor = (requestId) => db.prepare('SELECT * FROM priority_request_notes WHERE request_id = ? ORDER BY id').all(requestId)
  .map((n) => ({ id: n.id, adminName: n.admin_name, note: n.note, at: n.created_at }));
export const addNote = (requestId, { adminId, adminName, note }) =>
  db.prepare('INSERT INTO priority_request_notes (request_id, admin_id, admin_name, note, created_at) VALUES (?, ?, ?, ?, ?)').run(requestId, adminId ?? null, adminName, note, now());
export const lastChecks = (requestId, studentId, enrollmentId) => db.prepare('SELECT id, state, eligible, reasons, created_at FROM priority_eligibility_checks WHERE student_id = ? AND enrollment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5')
  .all(studentId, enrollmentId).map((c) => ({ id: c.id, state: c.state, eligible: c.eligible === 1, reasons: JSON.parse(c.reasons), at: c.created_at }));

// Compare-and-set: only changes the row if it is still in `from`, so two administrators can't both apply a transition. Returns true if applied.
export function setStatus(id, { from, to, note = null, actor = 'admin', documentId = null }) {
  const r = db.prepare('UPDATE priority_requests SET status = ?, updated_at = ?, document_id = COALESCE(?, document_id) WHERE id = ? AND status = ?').run(to, now(), documentId, id, from);
  if (!r.changes) return false;
  db.prepare('INSERT INTO priority_request_history (request_id, from_status, to_status, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, from, to, note, actor, now());
  return true;
}

// ---------- document replacements ----------
export const replacementReferenceFor = (oldDocumentId) => db.prepare(`SELECT d.verification_code AS code FROM document_replacements r JOIN documents d ON d.id = r.new_document_id WHERE r.old_document_id = ? AND d.status = 'Issued'`).get(oldDocumentId)?.code ?? null;
export const replacementOf = (oldDocumentId) => db.prepare('SELECT new_document_id AS id, correction_id FROM document_replacements WHERE old_document_id = ?').get(oldDocumentId) ?? null;
export const replacedFrom = (newDocumentId) => db.prepare('SELECT old_document_id AS id, correction_id FROM document_replacements WHERE new_document_id = ?').get(newDocumentId) ?? null;

// ---------- free corrections ----------
const J = (v) => (v ? JSON.parse(v) : null);
const toCorrection = (r) => r && ({
  id: r.id, studentId: r.student_id, studentName: r.full_name ?? null, enrollmentId: r.enrollment_id, documentId: r.document_id, category: r.category, status: r.status,
  free: r.fee_paise === 0, feePaise: r.fee_paise, reason: r.reason, evidence: r.evidence, originalValues: J(r.original_values), correctedValues: J(r.corrected_values),
  originalSnapshot: J(r.original_snapshot), newSnapshot: J(r.new_snapshot), replacementDocumentId: r.replacement_document_id, reservedNumber: r.reserved_number,
  reservedCode: r.reserved_code, failureCode: r.failure_code, createdBy: r.created_by, createdByName: r.created_by_name, approvedBy: r.approved_by,
  approvedByName: r.approved_by_name ?? null, approvedAt: r.approved_at ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at,
});
const CSEL = 'SELECT c.*, s.full_name FROM free_corrections c JOIN students s ON s.id = c.student_id';
export const correctionById = (id) => toCorrection(db.prepare(`${CSEL} WHERE c.id = ?`).get(id));
export const openCorrectionForDocument = (documentId) => toCorrection(db.prepare(`${CSEL} WHERE c.document_id = ? AND c.status IN ('Pending Approval', 'Processing', 'Failed')`).get(documentId));
export function pageCorrections({ status, student, from, to, limit, offset }) {
  const where = []; const args = [];
  if (status) { where.push('c.status = ?'); args.push(status); }
  if (student) { where.push("s.full_name LIKE ? ESCAPE '\\'"); args.push(esc(student)); }
  if (from) { where.push('c.created_at >= ?'); args.push(`${from}T00:00:00.000Z`); }
  if (to) { where.push('c.created_at <= ?'); args.push(`${to}T23:59:59.999Z`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM free_corrections c JOIN students s ON s.id = c.student_id ${w}`).get(...args).n;
  return { total, rows: db.prepare(`${CSEL} ${w} ORDER BY c.created_at DESC, c.id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(toCorrection) };
}
export const correctionHistory = (id) => db.prepare('SELECT * FROM free_correction_history WHERE correction_id = ? ORDER BY id').all(id)
  .map((h) => ({ from: h.from_status, to: h.to_status, note: h.note, actor: h.actor, at: h.created_at }));
export const addCorrectionHistory = (id, { from = null, to, note = null, actor = 'admin' }) =>
  db.prepare('INSERT INTO free_correction_history (correction_id, from_status, to_status, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, from, to, note, actor, now());
export function insertCorrection(c) {
  const id = `COR-${crypto.randomBytes(5).toString('hex').toUpperCase()}`; const t = now();
  db.prepare(`INSERT INTO free_corrections (id, student_id, enrollment_id, document_id, category, status, fee_paise, reason, evidence, original_values, corrected_values, original_snapshot,
      created_by, created_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Pending Approval', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, c.studentId, c.enrollmentId, c.documentId, c.category, c.reason, c.evidence, JSON.stringify(c.originalValues), JSON.stringify(c.correctedValues), JSON.stringify(c.originalSnapshot), c.adminId ?? null, c.adminName, t, t);
  addCorrectionHistory(id, { to: 'Pending Approval', note: 'Free correction created.' });
  return id;
}
// Compare-and-set status change for a correction. Returns true if applied.
export function setCorrectionStatus(id, froms, to, { note = null, failureCode = null, approvedBy = undefined, approvedByName = null, resolved = false } = {}) {
  const list = [].concat(froms); const t = now();
  const row = db.prepare(`SELECT status FROM free_corrections WHERE id = ? AND status IN (${list.map(() => '?').join(',')})`).get(id, ...list);
  if (!row) return false;
  // Stage 10C Part 2: an approval also records who approved and when (the latest approval wins on a retry); other status changes leave those fields alone.
  db.prepare(`UPDATE free_corrections SET status = ?, failure_code = ?, updated_at = ?, resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END,
      approved_by = COALESCE(?, approved_by), approved_at = CASE WHEN ? IS NULL THEN approved_at ELSE ? END, approved_by_name = CASE WHEN ? IS NULL THEN approved_by_name ELSE ? END WHERE id = ?`)
    .run(to, failureCode, t, resolved ? 1 : 0, t, approvedBy ?? null, approvedBy ?? null, t, approvedBy ?? null, approvedByName ?? 'Administrator', id);
  addCorrectionHistory(id, { from: row.status, to, note });
  return true;
}
// A reserved number/code is allocated once per correction and reused by retries, so a failed attempt never burns a second number.
export const reserve = (id, number, code) => db.prepare('UPDATE free_corrections SET reserved_number = ?, reserved_code = ? WHERE id = ? AND reserved_number IS NULL').run(number, code, id).changes;
export const forStudent = (studentId) => db.prepare(`${CSEL} WHERE c.student_id = ? ORDER BY c.created_at DESC, c.id`).all(studentId).map(toCorrection);
