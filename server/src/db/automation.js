import { db } from './index.js';

// Background-worker bookkeeping (migration 7). One row per internship and document type.
const toState = (r) => r && ({
  enrollmentId: r.enrollment_id, type: r.type, attempts: r.attempts, lastError: r.last_error, lastAttemptAt: r.last_attempt_at,
  nextAttemptAt: r.next_attempt_at, emailedAt: r.emailed_at, emailAttempts: r.email_attempts, emailError: r.email_error,
});
export const get = (enrollmentId, type) => toState(db.prepare('SELECT * FROM automation_state WHERE enrollment_id = ? AND type = ?').get(enrollmentId, type));
const ensure = (enrollmentId, type) => db.prepare('INSERT INTO automation_state (enrollment_id, type) VALUES (?, ?) ON CONFLICT DO NOTHING').run(enrollmentId, type);

export function recordFailure(enrollmentId, type, error, nextAttemptAt, now = new Date()) {
  ensure(enrollmentId, type);
  db.prepare('UPDATE automation_state SET attempts = attempts + 1, last_error = ?, last_attempt_at = ?, next_attempt_at = ? WHERE enrollment_id = ? AND type = ?')
    .run(String(error).slice(0, 300), now.toISOString(), nextAttemptAt, enrollmentId, type);
}
export function recordIssued(enrollmentId, type, now = new Date()) {
  ensure(enrollmentId, type);
  db.prepare('UPDATE automation_state SET last_error = NULL, last_attempt_at = ?, next_attempt_at = NULL WHERE enrollment_id = ? AND type = ?').run(now.toISOString(), enrollmentId, type);
}
export function recordEmail(enrollmentId, type, { ok, error = null, nextAttemptAt = null }, now = new Date()) {
  ensure(enrollmentId, type);
  if (ok) db.prepare('UPDATE automation_state SET emailed_at = ?, email_error = NULL WHERE enrollment_id = ? AND type = ?').run(now.toISOString(), enrollmentId, type);
  else db.prepare('UPDATE automation_state SET email_attempts = email_attempts + 1, email_error = ?, next_attempt_at = ? WHERE enrollment_id = ? AND type = ?')
    .run(String(error).slice(0, 300), nextAttemptAt, enrollmentId, type);
}
// Issued documents the worker created (state row exists) whose e-mail has not gone out yet.
export const pendingEmails = (limit = 50) =>
  db.prepare(`SELECT s.enrollment_id, s.type, s.email_attempts, s.next_attempt_at, d.id AS document_id FROM automation_state s
    JOIN documents d ON d.enrollment_id = s.enrollment_id AND d.type = s.type AND d.status = 'Issued'
    WHERE s.emailed_at IS NULL ORDER BY d.issued_at LIMIT ?`).all(limit);
// Problems an administrator should see: failed automatic attempts that are still unresolved.
export const failing = () =>
  db.prepare(`SELECT s.*, st.full_name AS student_name FROM automation_state s JOIN enrollments e ON e.id = s.enrollment_id JOIN students st ON st.id = e.student_id
    WHERE s.last_error IS NOT NULL ORDER BY s.last_attempt_at DESC LIMIT 100`).all().map((r) => ({ ...toState(r), studentName: r.student_name }));
