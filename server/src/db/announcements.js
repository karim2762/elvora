import crypto from 'node:crypto';
import { db } from './index.js';
import { insert as notify } from './notifications.js';

// Stage 07C — announcement history. Recipients are always computed on the server from the students table; the request only names an audience.
export const CATEGORY_TYPE = { general: 'announcement', important: 'platform_notice', application: 'application_update', internship: 'internship_update', document: 'document_update' };
export const newAnnouncementId = () => `ANN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

// Eligible = student accounts (never administrators) that are not suspended.
export function recipientIds(audience) {
  const where = ["s.role = 'student'", "s.account_status = 'active'"]; const args = [];
  if (audience.type === 'student') { where.push('s.id = ?'); args.push(audience.studentId); }
  if (audience.type === 'group') {
    if (audience.degree) { where.push('s.degree = ?'); args.push(audience.degree); }
    if (audience.academicYear) { where.push('s.academic_year = ?'); args.push(audience.academicYear); }
    if (audience.internshipStatus) { where.push('EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.status = ?)'); args.push(audience.internshipStatus); }
  }
  return db.prepare(`SELECT s.id FROM students s WHERE ${where.join(' AND ')} ORDER BY s.id`).all(...args).map((r) => r.id);
}

const toAnnouncement = (r) => r && ({
  id: r.id, title: r.title, message: r.message, category: r.category, audience: JSON.parse(r.audience), status: r.status,
  recipientCount: r.recipient_count, createdBy: r.created_by_name, createdAt: r.created_at, sentAt: r.sent_at,
  withdrawnAt: r.withdrawn_at, withdrawnBy: r.withdrawn_by_name, withdrawReason: r.withdraw_reason,
});
// Delivery is COUNTED from the notification rows that exist, never assumed. Channel is in-app only (announcements are not e-mailed).
const withDelivery = (a) => {
  const c = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS r FROM notifications WHERE announcement_id = ?').get(a.id);
  return { ...a, delivery: { channel: 'in-app', delivered: c.n, read: c.r ?? 0, emailed: 0, note: 'Delivered to student notification inboxes. Announcements are not sent by e-mail.' } };
};

export function insertAndDeliver({ id, title, message, category, audience, ids, admin, now }) {
  db.prepare(`INSERT INTO announcements (id, title, message, category, audience, status, recipient_count, created_by, created_by_name, created_at, sent_at)
    VALUES (?, ?, ?, ?, ?, 'Sent', ?, ?, ?, ?, ?)`).run(id, title, message, category, JSON.stringify(audience), ids.length, admin.id, admin.name, now, now);
  for (const studentId of ids) {
    notify({ studentId, type: CATEGORY_TYPE[category], title, message, now, announcementId: id });
  }
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE announcement_id = ?').get(id).n; // what was really written
}
export const find = (id) => { const r = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id); return r ? withDelivery(toAnnouncement(r)) : null; };
export function page({ status = null, limit, offset }) {
  const w = status ? 'WHERE status = ?' : ''; const a = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM announcements ${w}`).get(...a).n;
  const rows = db.prepare(`SELECT * FROM announcements ${w} ORDER BY sent_at DESC, id LIMIT ? OFFSET ?`).all(...a, limit, offset).map((r) => withDelivery(toAnnouncement(r)));
  return { total, rows };
}
export const recentDuplicate = ({ title, message, audience, sinceIso }) =>
  db.prepare("SELECT id FROM announcements WHERE title = ? AND message = ? AND audience = ? AND status = 'Sent' AND sent_at >= ?").get(title, message, JSON.stringify(audience), sinceIso)?.id ?? null;
export function withdraw(id, { reason, adminName }) {
  const now = new Date().toISOString();
  const r = db.prepare("UPDATE announcements SET status = 'Withdrawn', withdrawn_at = ?, withdrawn_by_name = ?, withdraw_reason = ? WHERE id = ? AND status = 'Sent'").run(now, adminName, reason, id);
  if (!r.changes) return null;
  db.prepare('DELETE FROM notifications WHERE announcement_id = ?').run(id); // students no longer see it; the announcement record itself stays
  return find(id);
}
