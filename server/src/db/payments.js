import crypto from 'node:crypto';
import { db } from './index.js';

// Stage 10B Part 1 — all SQL for manual UPI payments, pricing versions and payment configuration. Student reads are always scoped by student_id.
const now = () => new Date().toISOString();
export const isConstraint = (err) => String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT');
const rid = (p, n = 6) => `${p}-${crypto.randomBytes(n).toString('hex').toUpperCase()}`;

// ---- permissions ----
export const hasPermission = (adminId, permission) => Boolean(db.prepare('SELECT 1 FROM admin_permissions WHERE admin_id = ? AND permission = ?').get(adminId, permission));
export const grantPermission = (adminId, permission, grantedBy) => db.prepare('INSERT OR IGNORE INTO admin_permissions (admin_id, permission, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(adminId, permission, grantedBy, now()).changes;

export const revokePermission = (adminId, permission) => db.prepare('DELETE FROM admin_permissions WHERE admin_id = ? AND permission = ?').run(adminId, permission).changes;
export const permissionHolders = (permission) => db.prepare("SELECT p.admin_id AS id, s.email FROM admin_permissions p JOIN students s ON s.id = p.admin_id WHERE p.permission = ? AND s.role = 'admin'").all(permission);

// ---- configuration (single row) ----
const toConfig = (r) => ({ upiId: r.upi_id, payeeName: r.payee_name, instructions: r.instructions, supportContact: r.support_contact, verificationHours: r.verification_hours,
  manualEnabled: r.manual_enabled === 1, submissionsEnabled: r.submissions_enabled === 1, updatedAt: r.updated_at, updatedBy: r.updated_by, updatedByName: r.updated_by_name, qrFile: r.qr_file ?? null, qrUpdatedAt: r.qr_updated_at ?? null });
export const getConfig = () => toConfig(db.prepare('SELECT * FROM payment_config WHERE id = 1').get());
export const setQrFile = (file, admin) => db.prepare('UPDATE payment_config SET qr_file = ?, qr_updated_at = ?, updated_at = ?, updated_by = ?, updated_by_name = ? WHERE id = 1').run(file, now(), now(), admin.id ?? null, admin.fullName ?? 'Administrator');
export function saveConfig(c, admin) {
  db.prepare(`UPDATE payment_config SET upi_id = ?, payee_name = ?, instructions = ?, support_contact = ?, verification_hours = ?, manual_enabled = ?, submissions_enabled = ?,
    updated_at = ?, updated_by = ?, updated_by_name = ? WHERE id = 1`)
    .run(c.upiId, c.payeeName, c.instructions, c.supportContact, c.verificationHours, c.manualEnabled ? 1 : 0, c.submissionsEnabled ? 1 : 0, now(), admin.id ?? null, admin.fullName ?? 'Administrator');
}

// ---- pricing versions ----
const toPrice = (r) => ({ id: r.id, durationDays: r.duration_days, months: r.months, amountPaise: r.amount_paise, currency: r.currency, taxNote: r.tax_note, version: r.version, active: r.active === 1 });
export const currentVersion = () => db.prepare('SELECT * FROM priority_pricing_versions ORDER BY version DESC LIMIT 1').get();
export const versionRows = (version) => db.prepare('SELECT * FROM priority_pricing WHERE version = ? ORDER BY duration_days').all(version).map(toPrice);
export const allVersions = () => db.prepare('SELECT * FROM priority_pricing_versions ORDER BY version DESC').all().map((v) => ({ version: v.version, createdAt: v.created_at, createdBy: v.created_by, createdByName: v.created_by_name, prices: versionRows(v.version) }));
export const changesFor = (limit = 100) => db.prepare('SELECT * FROM priority_pricing_changes ORDER BY id DESC LIMIT ?').all(limit)
  .map((c) => ({ version: c.version, durationDays: c.duration_days, previousPaise: c.previous_paise, newPaise: c.new_paise, adminId: c.admin_id, adminName: c.admin_name, at: c.created_at }));
// Creates version N+1: the three active rows are retired (kept for existing requests) and three new active rows are written. Caller wraps this in audit + transaction.
export function publishVersion(amounts, admin) {
  return db.transaction(() => {
    const t = now(); const cur = currentVersion(); const next = cur.version + 1;
    const old = db.prepare('SELECT * FROM priority_pricing WHERE active = 1').all();
    db.prepare('INSERT INTO priority_pricing_versions (version, created_at, created_by, created_by_name) VALUES (?, ?, ?, ?)').run(next, t, admin.id ?? null, admin.fullName ?? 'Administrator');
    db.prepare('UPDATE priority_pricing SET active = 0, retired_at = ? WHERE active = 1').run(t);
    for (const o of old) {
      const paise = amounts[o.duration_days] ?? o.amount_paise;
      db.prepare("INSERT INTO priority_pricing (id, duration_days, months, amount_paise, currency, tax_note, active, created_at, version) VALUES (?, ?, ?, ?, 'INR', ?, 1, ?, ?)")
        .run(`PRC-${o.duration_days}-V${next}`, o.duration_days, o.months, paise, o.tax_note, t, next);
      if (paise !== o.amount_paise) db.prepare('INSERT INTO priority_pricing_changes (version, duration_days, previous_paise, new_paise, admin_id, admin_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(next, o.duration_days, o.amount_paise, paise, admin.id ?? null, admin.fullName ?? 'Administrator', t);
    }
    return next;
  })();
}

// ---- payments ----
const toPayment = (r) => r && ({ id: r.id, internalReference: r.internal_reference, requestId: r.request_id, studentId: r.student_id, applicationId: r.application_id, enrollmentId: r.enrollment_id,
  durationDays: r.duration_days, expectedPaise: r.expected_paise, currency: r.currency, priceId: r.price_id, pricingVersion: r.pricing_version, payeeUpiId: r.payee_upi_id, payeeName: r.payee_name,
  status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, submittedAt: r.submitted_at, verificationDeadline: r.verification_deadline, updatedAt: r.updated_at,
  verifiedAt: r.verified_at, verifiedBy: r.verified_by, verifiedByName: r.verified_by_name, rejectionCode: r.rejection_code, rejectionNote: r.rejection_note, reviewedAt: r.reviewed_at, reviewedBy: r.reviewed_by });
export const paymentOwned = (id, studentId) => toPayment(db.prepare('SELECT * FROM priority_payments WHERE id = ? AND student_id = ?').get(id, studentId));
export const paymentById = (id) => toPayment(db.prepare('SELECT * FROM priority_payments WHERE id = ?').get(id));
export const paymentsForStudent = (studentId) => db.prepare('SELECT * FROM priority_payments WHERE student_id = ? ORDER BY created_at DESC, id').all(studentId).map(toPayment);
export const liveForRequest = (requestId) => toPayment(db.prepare("SELECT * FROM priority_payments WHERE request_id = ? AND status IN ('NOT_STARTED','AWAITING_PAYMENT','PENDING_VERIFICATION','VERIFIED','REFUND_PENDING')").get(requestId));
export const expiredAwaiting = (studentId) => db.prepare("SELECT id FROM priority_payments WHERE student_id = ? AND status = 'AWAITING_PAYMENT' AND expires_at <= ?").all(studentId, now()).map((r) => r.id);
export function insertPayment(p) {
  const id = rid('PAY'); const t = now();
  db.prepare(`INSERT INTO priority_payments (id, request_id, student_id, application_id, enrollment_id, duration_days, expected_paise, currency, price_id, pricing_version, payee_upi_id, payee_name,
    status, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, 'AWAITING_PAYMENT', ?, ?, ?)`)
    .run(id, p.requestId, p.studentId, p.applicationId, p.enrollmentId, p.durationDays, p.expectedPaise, p.priceId, p.pricingVersion, p.payeeUpiId, p.payeeName, t, p.expiresAt, t);
  return id;
}
export const setPaymentStatus = (id, from, to) => db.prepare('UPDATE priority_payments SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, now(), id, from).changes;
export const addEvent = (paymentId, { event, from = null, to = null, actor, note = null }) =>
  db.prepare('INSERT INTO priority_payment_events (payment_id, event, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(paymentId, event, from, to, actor, note, now());
export const eventsFor = (paymentId) => db.prepare('SELECT * FROM priority_payment_events WHERE payment_id = ? ORDER BY id').all(paymentId)
  .map((e) => ({ event: e.event, from: e.from_status, to: e.to_status, actor: e.actor, note: e.note, at: e.created_at }));

// ---- submissions & proofs ----
const toSub = (s) => s && ({ id: s.id, paymentId: s.payment_id, studentId: s.student_id, utr: s.utr, amountPaise: s.amount_paise, paymentDate: s.payment_date, paymentTime: s.payment_time, upiApp: s.upi_app, note: s.note, proofId: s.proof_id, submittedAt: s.submitted_at,
  revision: s.revision, previousSubmissionId: s.previous_submission_id, replacementReason: s.replacement_reason });
// The CURRENT submission of a payment is its highest revision; earlier revisions are history and are never edited.
export const submissionFor = (paymentId) => toSub(db.prepare('SELECT * FROM priority_payment_submissions WHERE payment_id = ? ORDER BY revision DESC LIMIT 1').get(paymentId));
export const submissionsFor = (paymentId) => db.prepare('SELECT * FROM priority_payment_submissions WHERE payment_id = ? ORDER BY revision').all(paymentId).map(toSub);
export const submissionById = (paymentId, id) => toSub(db.prepare('SELECT * FROM priority_payment_submissions WHERE id = ? AND payment_id = ?').get(id, paymentId));
export const revisionCount = (paymentId) => db.prepare('SELECT COUNT(*) AS n FROM priority_payment_submissions WHERE payment_id = ?').get(paymentId).n;
// A UTR is "taken" while it is on a submission that no administrator has rejected (on any payment other than `exceptPaymentId`) or is confirmed anywhere.
export const confirmedUtr = (utr) => db.prepare('SELECT payment_id FROM confirmed_payment_utrs WHERE utr = ?').get(utr)?.payment_id ?? null;
export const utrTaken = (utr, exceptPaymentId = '') => Boolean(confirmedUtr(utr)) || Boolean(db.prepare(`SELECT 1 FROM priority_payment_submissions s WHERE s.utr = ? AND s.payment_id <> ?
  AND NOT EXISTS (SELECT 1 FROM priority_payment_reviews r WHERE r.submission_id = s.id AND r.decision = 'REJECTED')`).get(utr, exceptPaymentId));
export const utrExists = (utr) => Boolean(db.prepare('SELECT 1 FROM priority_payment_submissions WHERE utr = ?').get(utr));
// Every other submission carrying the same reference, with who sent it and how it was decided. A warning for the administrator, not proof of fraud.
export const sameUtr = (utr, exceptSubmissionId) => db.prepare(`SELECT s.id, s.payment_id, s.student_id, st.full_name, s.revision, s.submitted_at, p.status AS payment_status, p.request_id,
    (SELECT decision FROM priority_payment_reviews r WHERE r.submission_id = s.id) AS decision, (SELECT reason_code FROM priority_payment_reviews r WHERE r.submission_id = s.id) AS reason_code
  FROM priority_payment_submissions s JOIN priority_payments p ON p.id = s.payment_id JOIN students st ON st.id = s.student_id WHERE s.utr = ? AND s.id <> ? ORDER BY s.submitted_at`).all(utr, exceptSubmissionId)
  .map((r) => ({ submissionId: r.id, paymentId: r.payment_id, requestId: r.request_id, studentId: r.student_id, studentName: r.full_name, revision: r.revision, submittedAt: r.submitted_at, paymentStatus: r.payment_status, decision: r.decision, reasonCode: r.reason_code }));
export function insertSubmission(s) {
  const id = rid('PSB'); const t = now();
  db.prepare('INSERT INTO priority_payment_submissions (id, payment_id, student_id, utr, amount_paise, payment_date, payment_time, upi_app, note, proof_id, submitted_at, revision, previous_submission_id, replacement_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, s.paymentId, s.studentId, s.utr, s.amountPaise, s.paymentDate, s.paymentTime, s.upiApp, s.note, s.proofId, t, s.revision ?? 1, s.previousSubmissionId ?? null, s.replacementReason ?? null);
  return { id, submittedAt: t };
}
export const markSubmitted = (id, reference, submittedAt, deadline) => db.prepare("UPDATE priority_payments SET status = 'PENDING_VERIFICATION', internal_reference = ?, submitted_at = ?, verification_deadline = ?, updated_at = ? WHERE id = ? AND status = 'AWAITING_PAYMENT'")
  .run(reference, submittedAt, deadline, now(), id).changes;
// Re-opens a REJECTED payment for review with a new revision. The internal reference and the order stay the same.
export const markResubmitted = (id, submittedAt, deadline) => db.prepare("UPDATE priority_payments SET status = 'PENDING_VERIFICATION', submitted_at = ?, verification_deadline = ?, rejection_code = NULL, rejection_note = NULL, updated_at = ? WHERE id = ? AND status = 'REJECTED'")
  .run(submittedAt, deadline, now(), id).changes;

// ---- administrator decisions (append-only reviews; the confirmed-UTR row is the uniqueness guarantee) ----
const toReview = (r) => r && ({ id: r.id, paymentId: r.payment_id, submissionId: r.submission_id, decision: r.decision, reasonCode: r.reason_code, note: r.note, adminId: r.admin_id, adminName: r.admin_name, at: r.created_at });
export const reviewsFor = (paymentId) => db.prepare('SELECT * FROM priority_payment_reviews WHERE payment_id = ? ORDER BY created_at, rowid').all(paymentId).map(toReview);
export const reviewOf = (submissionId) => toReview(db.prepare('SELECT * FROM priority_payment_reviews WHERE submission_id = ?').get(submissionId));
export function insertReview(r) {
  const id = rid('PRV'); db.prepare('INSERT INTO priority_payment_reviews (id, payment_id, submission_id, decision, reason_code, note, acknowledgements, admin_id, admin_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, r.paymentId, r.submissionId, r.decision, r.reasonCode ?? null, r.note ?? null, r.acknowledgements ? JSON.stringify(r.acknowledgements) : null, r.adminId, r.adminName, now());
  return id;
}
export const insertConfirmedUtr = ({ utr, paymentId, submissionId, adminId }) => db.prepare('INSERT INTO confirmed_payment_utrs (utr, payment_id, submission_id, admin_id, confirmed_at) VALUES (?, ?, ?, ?, ?)').run(utr, paymentId, submissionId, adminId, now());
export const markVerified = (id, admin) => db.prepare("UPDATE priority_payments SET status = 'VERIFIED', verified_at = ?, verified_by = ?, verified_by_name = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_VERIFICATION'")
  .run(now(), admin.id, admin.fullName ?? 'Administrator', now(), admin.id, now(), id).changes;
export const markRejected = (id, admin, code, note) => db.prepare("UPDATE priority_payments SET status = 'REJECTED', rejection_code = ?, rejection_note = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_VERIFICATION'")
  .run(code, note ?? null, now(), admin.id, now(), id).changes;
export const decisionColumns = (id) => db.prepare('SELECT verified_at, verified_by, verified_by_name, rejection_code, rejection_note, reviewed_at, reviewed_by FROM priority_payments WHERE id = ?').get(id);

// ---- admin queue ----
const QSTATUS = { awaiting_payment: "p.status = 'AWAITING_PAYMENT'", pending: "p.status = 'PENDING_VERIFICATION'", verified: "p.status = 'VERIFIED'", rejected: "p.status = 'REJECTED'", overdue: "p.status = 'PENDING_VERIFICATION' AND p.verification_deadline < @now",
  refund_pending: "p.status IN ('VERIFIED', 'REFUND_PENDING') AND EXISTS (SELECT 1 FROM payment_refunds r WHERE r.payment_id = p.id AND r.status IN ('REFUND_REQUESTED', 'REFUND_PENDING'))",
  refunded: "EXISTS (SELECT 1 FROM payment_refunds r WHERE r.payment_id = p.id AND r.status = 'REFUNDED')" };
export const QUEUE_FILTERS = Object.keys(QSTATUS);
const escLike = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const LATEST = '(SELECT s2.id FROM priority_payment_submissions s2 WHERE s2.payment_id = p.id ORDER BY s2.revision DESC LIMIT 1)';
const only = (sql, args) => Object.fromEntries(Object.entries(args).filter(([k]) => new RegExp(`@${k}\\b`).test(sql))); // node:sqlite rejects named parameters the SQL does not use
export function pageQueue({ filter, durationDays, from, to, q, limit, offset }) {
  // Awaiting-payment orders have no submission yet, so they appear only when that filter is chosen; every other view lists submitted payments exactly as before.
  const where = [filter === 'awaiting_payment' ? "p.submitted_at IS NULL" : "p.submitted_at IS NOT NULL"]; const args = { now: now() };
  if (filter && QSTATUS[filter]) where.push(`(${QSTATUS[filter]})`);
  if (durationDays) { where.push('p.duration_days = @dur'); args.dur = durationDays; }
  if (from) { where.push('p.submitted_at >= @from'); args.from = `${from}T00:00:00.000Z`; }
  if (to) { where.push('p.submitted_at <= @to'); args.to = `${to}T23:59:59.999Z`; }
  if (q) { args.q = escLike(q); args.qu = escLike(String(q).normalize('NFKC').replace(/\s+/g, '').toUpperCase());
    where.push(`(st.full_name LIKE @q ESCAPE '\\' OR st.id LIKE @q ESCAPE '\\' OR p.internal_reference LIKE @q ESCAPE '\\' OR p.request_id LIKE @q ESCAPE '\\' OR p.id LIKE @q ESCAPE '\\' OR s.utr LIKE @qu ESCAPE '\\')`); }
  const from_ = `FROM priority_payments p JOIN students st ON st.id = p.student_id LEFT JOIN priority_payment_submissions s ON s.id = ${LATEST} JOIN applications a ON a.id = p.application_id`;
  const w = `WHERE ${where.join(' AND ')}`;
  const countSql = `SELECT COUNT(*) AS n ${from_} ${w}`; const total = db.prepare(countSql).get(only(countSql, args)).n;
  const rowsSql = `SELECT p.*, st.full_name, a.internship_title, s.id AS sid, s.utr, s.payment_date, s.payment_time, s.upi_app, s.proof_id, s.submitted_at AS sub_at, s.revision,
      (p.status = 'PENDING_VERIFICATION' AND p.verification_deadline < @now) AS overdue,
      (SELECT COUNT(*) FROM priority_payment_submissions o WHERE o.utr = s.utr AND o.id <> s.id) AS dup_count
    ${from_} ${w} ORDER BY overdue DESC, (p.status = 'PENDING_VERIFICATION') DESC, p.verification_deadline ASC, p.submitted_at DESC, p.id LIMIT @limit OFFSET @offset`;
  const rows = db.prepare(rowsSql).all(only(rowsSql, { ...args, limit, offset }));
  return { total, rows: rows.map((r) => ({ paymentId: r.id, studentId: r.student_id, studentName: r.full_name, requestId: r.request_id, applicationId: r.application_id, internshipTitle: r.internship_title,
    durationDays: r.duration_days, expectedPaise: r.expected_paise, utr: r.utr, internalReference: r.internal_reference, paymentDate: r.payment_date, paymentTime: r.payment_time, upiApp: r.upi_app,
    hasProof: Boolean(r.proof_id), proofId: r.proof_id, submissionId: r.sid, revision: r.revision, submittedAt: r.sub_at, createdAt: r.created_at, expiresAt: r.expires_at, verificationDeadline: r.verification_deadline, status: r.status, overdue: r.overdue === 1, duplicateWarning: r.dup_count > 0 })) };
}
export function queueCounts() {
  const n = now(); const out = {};
  for (const [k, cond] of Object.entries(QSTATUS)) out[k] = db.prepare(`SELECT COUNT(*) AS n FROM priority_payments p WHERE ${k === 'awaiting_payment' ? 'p.submitted_at IS NULL' : 'p.submitted_at IS NOT NULL'} AND (${cond})`).get(...(cond.includes('@now') ? [{ now: n }] : [])).n;
  return out;
}
export const studentBrief = (id) => db.prepare('SELECT id, full_name, role FROM students WHERE id = ?').get(id);

export function insertProof({ paymentId, studentId, fileName, mime, size }) {
  const id = rid('PPF', 8);
  db.prepare('INSERT INTO priority_payment_proofs (id, payment_id, student_id, file_name, mime, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, paymentId, studentId, fileName, mime, size, now());
  return id;
}
const toProof = (p) => p && ({ id: p.id, paymentId: p.payment_id, studentId: p.student_id, fileName: p.file_name, mime: p.mime, size: p.size_bytes, linked: p.linked === 1, createdAt: p.created_at });
export const proofFor = (paymentId, proofId) => toProof(db.prepare('SELECT * FROM priority_payment_proofs WHERE id = ? AND payment_id = ?').get(proofId, paymentId));
export const linkProof = (id) => db.prepare('UPDATE priority_payment_proofs SET linked = 1 WHERE id = ?').run(id);
export const stagedProofCount = (paymentId) => db.prepare('SELECT COUNT(*) AS n FROM priority_payment_proofs WHERE payment_id = ?').get(paymentId).n;

// ---- request helpers (status moves are written here so the existing history table stays the single source) ----
export const requestRow = (id, studentId) => db.prepare('SELECT * FROM priority_requests WHERE id = ? AND student_id = ?').get(id, studentId);
export const moveRequest = (id, from, to, note, actor) => {
  const n = db.prepare('UPDATE priority_requests SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, now(), id, from).changes;
  if (n) db.prepare('INSERT INTO priority_request_history (request_id, from_status, to_status, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, from, to, note, actor, now());
  return n;
};
export const resnapshotRequestPrice = (id, price) => db.prepare("UPDATE priority_requests SET price_id = ?, amount_paise = ?, currency = ?, tax_note = ?, updated_at = ? WHERE id = ? AND status = 'Draft'")
  .run(price.id, price.amountPaise, price.currency, price.taxNote, now(), id).changes;
export const adminIds = () => db.prepare("SELECT id FROM students WHERE role = 'admin'").all().map((r) => r.id);


// ---- Stage 10B Part 2B: overdue sweep and refunds ----
// Payments waiting for verification whose configured target has passed. Reported and notified only: nothing is decided automatically.
export const overduePending = (limit = 500) => db.prepare("SELECT id, internal_reference, student_id, verification_deadline, expected_paise FROM priority_payments WHERE status = 'PENDING_VERIFICATION' AND verification_deadline < ? ORDER BY verification_deadline LIMIT ?").all(now(), limit)
  .map((r) => ({ id: r.id, internalReference: r.internal_reference, studentId: r.student_id, deadline: r.verification_deadline, expectedPaise: r.expected_paise }));
export const overdueCount = () => db.prepare("SELECT COUNT(*) AS n FROM priority_payments WHERE status = 'PENDING_VERIFICATION' AND verification_deadline < ?").get(now()).n;

const toRefund = (r) => r && ({ id: r.id, paymentId: r.payment_id, studentId: r.student_id, amountPaise: r.amount_paise, reason: r.reason, destination: r.destination, notes: r.notes, status: r.status,
  refundUtr: r.refund_utr, refundDate: r.refund_date, rejectionReason: r.rejection_reason, requestedBy: r.requested_by, requestedByName: r.requested_by_name, requestedAt: r.requested_at, pendingAt: r.pending_at,
  completedBy: r.completed_by, completedByName: r.completed_by_name, completedAt: r.completed_at, rejectedBy: r.rejected_by, rejectedByName: r.rejected_by_name, rejectedAt: r.rejected_at, updatedAt: r.updated_at });
export const refundById = (id) => toRefund(db.prepare('SELECT * FROM payment_refunds WHERE id = ?').get(id));
export const refundsFor = (paymentId) => db.prepare('SELECT * FROM payment_refunds WHERE payment_id = ? ORDER BY requested_at, rowid').all(paymentId).map(toRefund);
export const refundsForStudentPayment = (paymentId, studentId) => db.prepare('SELECT * FROM payment_refunds WHERE payment_id = ? AND student_id = ? ORDER BY requested_at, rowid').all(paymentId, studentId).map(toRefund);
// Reserved = requested + pending + completed. A rejected refund releases its share.
export const refundReserved = (paymentId) => db.prepare("SELECT COALESCE(SUM(amount_paise), 0) AS n FROM payment_refunds WHERE payment_id = ? AND status <> 'REFUND_REJECTED'").get(paymentId).n;
export const refundCompleted = (paymentId) => db.prepare("SELECT COALESCE(SUM(amount_paise), 0) AS n FROM payment_refunds WHERE payment_id = ? AND status = 'REFUNDED'").get(paymentId).n;
export function insertRefund(r) {
  const id = rid('RFD'); const t = now();
  db.prepare('INSERT INTO payment_refunds (id, payment_id, student_id, amount_paise, reason, destination, notes, status, requested_by, requested_by_name, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, r.paymentId, r.studentId, r.amountPaise, r.reason, r.destination, r.notes ?? null, 'REFUND_REQUESTED', r.adminId, r.adminName, t, t);
  return id;
}
export const refundToPending = (id, notes) => db.prepare("UPDATE payment_refunds SET status = 'REFUND_PENDING', pending_at = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ? AND status = 'REFUND_REQUESTED'").run(now(), notes ?? null, now(), id).changes;
export const refundToDone = (id, { utr, date, notes }, admin) => db.prepare("UPDATE payment_refunds SET status = 'REFUNDED', refund_utr = ?, refund_date = ?, notes = COALESCE(?, notes), completed_by = ?, completed_by_name = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'REFUND_PENDING'")
  .run(utr, date ?? null, notes ?? null, admin.id, admin.fullName ?? 'Administrator', now(), now(), id).changes;
export const refundToRejected = (id, reason, admin) => db.prepare("UPDATE payment_refunds SET status = 'REFUND_REJECTED', rejection_reason = ?, rejected_by = ?, rejected_by_name = ?, rejected_at = ?, updated_at = ? WHERE id = ? AND status IN ('REFUND_REQUESTED', 'REFUND_PENDING')")
  .run(reason, admin.id, admin.fullName ?? 'Administrator', now(), now(), id).changes;
export const refundUtrUsed = (utr) => Boolean(db.prepare('SELECT 1 FROM payment_refunds WHERE refund_utr = ?').get(utr));
export const addRefundEvent = (refundId, paymentId, { event, from = null, to = null, admin, note = null }) =>
  db.prepare('INSERT INTO payment_refund_events (refund_id, payment_id, event, from_status, to_status, actor, actor_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(refundId, paymentId, event, from, to, admin ? `admin:${admin.id}` : 'system', admin?.fullName ?? null, note, now());
export const refundEvents = (refundId) => db.prepare('SELECT * FROM payment_refund_events WHERE refund_id = ? ORDER BY id').all(refundId)
  .map((e) => ({ event: e.event, from: e.from_status, to: e.to_status, actor: e.actor, actorName: e.actor_name, note: e.note, at: e.created_at }));
export const refundCounts = () => Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM payment_refunds GROUP BY status').all().map((r) => [r.status, r.n]));
export const confirmedUtrOf = (paymentId) => db.prepare('SELECT utr FROM confirmed_payment_utrs WHERE payment_id = ?').get(paymentId)?.utr ?? null;
export const allAdmins = () => db.prepare("SELECT id, email FROM students WHERE role = 'admin'").all();


// ---- Stage 10C Part 1: transaction records and financial aggregates ----
// One row per CONFIRMED payment. The database (UNIQUE keys + a consistency trigger) refuses a second record, a record for a different amount/UTR/student, and any later edit.
const toTxn = (t) => t && ({ id: t.id, paymentId: t.payment_id, requestId: t.request_id, studentId: t.student_id, submissionId: t.submission_id, confirmedPaise: t.confirmed_amount_paise, currency: t.currency,
  confirmedUtr: t.confirmed_utr, verifiedBy: t.verified_by, verifiedByName: t.verified_by_name, verifiedAt: t.verified_at, createdAt: t.created_at });
export const insertTransaction = ({ payment, submission, admin }) => {
  const id = rid('TXN'); const t = now();
  const verifiedAt = db.prepare('SELECT verified_at FROM priority_payments WHERE id = ?').get(payment.id)?.verified_at ?? t; // the transaction carries the payment's own verification timestamp, so the two records can never disagree
  db.prepare('INSERT INTO payment_transactions (id, payment_id, request_id, student_id, submission_id, confirmed_amount_paise, currency, confirmed_utr, verified_by, verified_by_name, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, payment.id, payment.requestId, payment.studentId, submission.id, payment.expectedPaise, payment.currency, submission.utr, admin.id, admin.fullName ?? 'Administrator', verifiedAt, t);
  return id;
};
export const transactionFor = (paymentId) => toTxn(db.prepare('SELECT * FROM payment_transactions WHERE payment_id = ?').get(paymentId));
export const transactionById = (id) => toTxn(db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(id));
export const reviewCount = (paymentId) => db.prepare('SELECT COUNT(*) AS n FROM priority_payment_reviews WHERE payment_id = ?').get(paymentId).n;
export const lastReview = (paymentId) => toReview(db.prepare('SELECT * FROM priority_payment_reviews WHERE payment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(paymentId));
export const refundSplit = (paymentId) => { const r = db.prepare("SELECT COALESCE(SUM(CASE WHEN status = 'REFUND_REQUESTED' THEN amount_paise END), 0) AS requested, COALESCE(SUM(CASE WHEN status = 'REFUND_PENDING' THEN amount_paise END), 0) AS approved, COALESCE(SUM(CASE WHEN status = 'REFUNDED' THEN amount_paise END), 0) AS completed FROM payment_refunds WHERE payment_id = ?").get(paymentId); return { requestedPaise: r.requested, approvedPaise: r.approved, completedPaise: r.completed }; };

const dayStart = (d) => `${d}T00:00:00.000Z`; const dayEnd = (d) => `${d}T23:59:59.999Z`;
const range = (col, from, to, args) => { const w = []; if (from) { w.push(`${col} >= ?`); args.push(dayStart(from)); } if (to) { w.push(`${col} <= ?`); args.push(dayEnd(to)); } return w.length ? ` AND ${w.join(' AND ')}` : ''; };
// Every figure is integer paise, computed by SQL from the authoritative tables. Period filters use the date each kind of event happened (submitted / verified / refunded).
export function financialTotals({ from = null, to = null } = {}) {
  const one = (sql, args = []) => db.prepare(sql).get(...args);
  let a = [];
  const submissions = one(`SELECT COUNT(*) AS n, COUNT(DISTINCT payment_id) AS payments FROM priority_payment_submissions WHERE 1 = 1${range('submitted_at', from, to, a)}`, a);
  a = []; const pending = one(`SELECT COUNT(*) AS n, COALESCE(SUM(expected_paise), 0) AS paise FROM priority_payments WHERE status = 'PENDING_VERIFICATION'${range('submitted_at', from, to, a)}`, a);
  a = []; const overdue = one(`SELECT COUNT(*) AS n FROM priority_payments WHERE status = 'PENDING_VERIFICATION' AND verification_deadline < ?${range('submitted_at', from, to, a)}`, [now(), ...a]);
  a = []; const awaiting = one(`SELECT COUNT(*) AS n, COALESCE(SUM(expected_paise), 0) AS paise FROM priority_payments WHERE status = 'AWAITING_PAYMENT'${range('created_at', from, to, a)}`, a);
  a = []; const gross = one(`SELECT COUNT(*) AS n, COALESCE(SUM(confirmed_amount_paise), 0) AS paise FROM payment_transactions WHERE 1 = 1${range('verified_at', from, to, a)}`, a);
  a = []; const rejectedDecisions = one(`SELECT COUNT(*) AS n FROM priority_payment_reviews WHERE decision = 'REJECTED'${range('created_at', from, to, a)}`, a);
  a = []; const rejectedNow = one(`SELECT COUNT(*) AS n, COALESCE(SUM(expected_paise), 0) AS paise FROM priority_payments WHERE status = 'REJECTED'${range('submitted_at', from, to, a)}`, a);
  a = []; const rfOpen = one(`SELECT COALESCE(SUM(CASE WHEN status = 'REFUND_REQUESTED' THEN amount_paise END), 0) AS requested, COALESCE(SUM(CASE WHEN status = 'REFUND_PENDING' THEN amount_paise END), 0) AS approved, COUNT(CASE WHEN status IN ('REFUND_REQUESTED', 'REFUND_PENDING') THEN 1 END) AS n FROM payment_refunds WHERE 1 = 1${range('requested_at', from, to, a)}`, a);
  a = []; const rfDone = one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_paise), 0) AS paise FROM payment_refunds WHERE status = 'REFUNDED'${range('completed_at', from, to, a)}`, a);
  a = []; const rfRejected = one(`SELECT COUNT(*) AS n FROM payment_refunds WHERE status = 'REFUND_REJECTED'${range('requested_at', from, to, a)}`, a);
  a = []; const free = one(`SELECT COUNT(*) AS n, COALESCE(SUM(fee_paise), 0) AS fees FROM free_corrections WHERE 1 = 1${range('created_at', from, to, a)}`, a);
  return { submissions, pending, overdue: overdue.n, awaiting, gross, rejectedDecisions: rejectedDecisions.n, rejectedNow, refundOpen: { requestedPaise: rfOpen.requested, approvedPaise: rfOpen.approved, count: rfOpen.n }, refundDone: rfDone, refundRejected: rfRejected.n, free };
}
// Integrity checks over ALL data (never period-filtered): a confirmed payment must have exactly one matching transaction record and the reverse.
export function financialIntegrity() {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    verifiedWithoutTransaction: n("SELECT COUNT(*) AS n FROM priority_payments p WHERE p.status IN ('VERIFIED', 'REFUND_PENDING', 'REFUNDED') AND NOT EXISTS (SELECT 1 FROM payment_transactions t WHERE t.payment_id = p.id)"),
    transactionWithoutVerifiedPayment: n("SELECT COUNT(*) AS n FROM payment_transactions t JOIN priority_payments p ON p.id = t.payment_id WHERE p.status NOT IN ('VERIFIED', 'REFUND_PENDING', 'REFUNDED')"),
    amountMismatch: n('SELECT COUNT(*) AS n FROM payment_transactions t JOIN priority_payments p ON p.id = t.payment_id WHERE p.expected_paise <> t.confirmed_amount_paise'),
    utrMismatch: n('SELECT COUNT(*) AS n FROM payment_transactions t LEFT JOIN confirmed_payment_utrs c ON c.payment_id = t.payment_id WHERE c.utr IS NULL OR c.utr <> t.confirmed_utr'),
    refundsOverPayment: n("SELECT COUNT(*) AS n FROM (SELECT t.id FROM payment_transactions t JOIN payment_refunds r ON r.payment_id = t.payment_id AND r.status <> 'REFUND_REJECTED' GROUP BY t.id HAVING SUM(r.amount_paise) > MAX(t.confirmed_amount_paise))"),
    refundsWithoutTransaction: n("SELECT COUNT(*) AS n FROM payment_refunds r WHERE NOT EXISTS (SELECT 1 FROM payment_transactions t WHERE t.payment_id = r.payment_id)"),
    freeCorrectionsWithFee: n('SELECT COUNT(*) AS n FROM free_corrections WHERE fee_paise <> 0'),
  };
}
const TXN_STATUS = { all: '1 = 1', refund_pending: "r.open > 0", refunded: 'r.done > 0', not_refunded: 'r.done = 0 AND r.open = 0' };
export const TRANSACTION_STATUSES = Object.keys(TXN_STATUS);
export function transactionRows({ from = null, to = null, status = 'all', limit = 200, offset = 0 } = {}) {
  const a = []; const w = range('t.verified_at', from, to, a);
  const base = `FROM payment_transactions t JOIN priority_payments p ON p.id = t.payment_id
    JOIN (SELECT t2.id AS tid, COALESCE((SELECT SUM(amount_paise) FROM payment_refunds x WHERE x.payment_id = t2.payment_id AND x.status = 'REFUNDED'), 0) AS done,
                 COALESCE((SELECT SUM(amount_paise) FROM payment_refunds x WHERE x.payment_id = t2.payment_id AND x.status IN ('REFUND_REQUESTED', 'REFUND_PENDING')), 0) AS open FROM payment_transactions t2) r ON r.tid = t.id
    WHERE ${TXN_STATUS[status] ?? TXN_STATUS.all}${w}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...a).n;
  const rows = db.prepare(`SELECT t.*, p.internal_reference, p.duration_days, p.pricing_version, p.status AS payment_status, r.done, r.open ${base} ORDER BY t.verified_at DESC, t.id LIMIT ? OFFSET ?`).all(...a, limit, offset)
    .map((x) => ({ ...toTxn(x), paymentReference: x.internal_reference, durationDays: x.duration_days, pricingVersion: x.pricing_version, paymentStatus: x.payment_status, refundedPaise: x.done, refundPendingPaise: x.open }));
  return { total, rows };
}
