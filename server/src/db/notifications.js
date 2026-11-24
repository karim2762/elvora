import crypto from 'node:crypto';
import { db } from './index.js';

// All notification SQL lives here. Every student read/write is scoped by student_id, so a notification ID from
// another account behaves exactly like a missing one.
const toNotification = (r) => r && ({
  id: r.id, type: r.type, title: r.title, message: r.message,
  applicationId: r.application_id, enrollmentId: r.enrollment_id, documentId: r.document_id, studentTaskId: r.student_task_id ?? null,
  createdAt: r.created_at, read: r.read_at !== null, readAt: r.read_at,
});

// Called by other db modules inside their own transactions, so an event and its notification commit together.
// Optional dedupeKey makes the insert idempotent per student (INSERT OR IGNORE on a partial unique index); returns true when a row was created.
export function insert(n) {
  return db.prepare(`INSERT OR IGNORE INTO notifications (id, student_id, type, title, message, application_id, enrollment_id, document_id, announcement_id, student_task_id, dedupe_key, created_at)
    VALUES (@id, @studentId, @type, @title, @message, @applicationId, @enrollmentId, @documentId, @announcementId, @studentTaskId, @dedupeKey, @now)`)
    .run({ applicationId: null, enrollmentId: null, documentId: null, announcementId: null, studentTaskId: null, dedupeKey: null, ...n, id: crypto.randomUUID(), now: new Date().toISOString() }).changes > 0;
}
// For side-effect notifications (GitHub events): a failure here must never undo or fail the operation that caused it.
export function insertSafe(n) { try { return insert(n); } catch { return false; } }

// Admin announcement: one row per student (or just one student when studentId is given). Returns the number created.
export function broadcast({ title, message, studentId = null }) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const ids = studentId ? [studentId] : db.prepare("SELECT id FROM students WHERE role = 'student'").all().map((r) => r.id);
    for (const sid of ids) insert({ studentId: sid, type: 'announcement', title, message, now });
    return ids.length;
  })();
}

export function pageForStudent(studentId, { unreadOnly = false, limit, offset }) {
  const where = unreadOnly ? 'student_id = ? AND read_at IS NULL' : 'student_id = ?';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`).get(studentId).n;
  const rows = db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(studentId, limit, offset).map(toNotification);
  return { total, rows };
}
export const unreadCount = (studentId) =>
  db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE student_id = ? AND read_at IS NULL').get(studentId).n;

export function markRead(id, studentId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND student_id = ? AND read_at IS NULL').run(now, id, studentId);
  return toNotification(db.prepare('SELECT * FROM notifications WHERE id = ? AND student_id = ?').get(id, studentId));
}
export const markAllRead = (studentId) =>
  db.prepare('UPDATE notifications SET read_at = ? WHERE student_id = ? AND read_at IS NULL').run(new Date().toISOString(), studentId).changes;
