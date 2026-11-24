import crypto from 'node:crypto';
import { db } from './index.js';
import { config } from '../config/index.js';

// Stage 07C — administrative audit log. Rows are only ever INSERTED (database triggers reject UPDATE and DELETE).
// record() runs synchronously and THROWS if the row can't be written. Critical operations call it inside the same transaction
// as the change itself, so a change can never commit without its audit row (and vice versa).
export const AUDIT_ACTIONS = [
  'admin.login', 'admin.logout',
  'listing.create', 'listing.update', 'listing.publish', 'listing.unpublish', 'listing.activate', 'listing.deactivate', 'listing.archive', 'listing.restore', 'listing.delete',
  'application.status_change', 'application.note_add',
  'student.suspend', 'student.reactivate',
  'internship.create', 'internship.update', 'certificate.decision', 'automation.run', 'admin.access_denied',
  'internship.activate', 'internship.resume', 'internship.suspend', 'internship.complete', 'internship.cancel',
  'offer_letter.issue', 'offer_letter.instant', 'certificate.issue', 'document.revoke',
  'announcement.create', 'announcement.send', 'announcement.withdraw',
  'settings.update', 'settings.logo_update',
  // Stage 09A: task management, criteria and application evaluation
  'task_template.create', 'task_template.update', 'task_template.publish', 'task_template.unpublish', 'task_template.archive',
  'internship_task.attach', 'internship_task.update', 'internship_task.publish', 'internship_task.unpublish', 'internship_task.delete', 'internship_task.reorder',
  'task_plan.assign', 'task.review', 'criteria.update', 'application.evaluate', 'application.evaluation_review',
  // Stage 09B Part 2B: project evaluation
  'project.review_start', 'project.evaluation_save', 'project.decision',
  // Stage 09C Part 1: GitHub integration (student-initiated events are written with the system actor; the student is the target)
  'github.connect', 'github.disconnect', 'github.repository_create', 'github.repository_link', 'github.repository_unlink', 'github.ownership_verify', 'github.inspect',
  // Stage 09C Part 2A: GitHub project submission and evidence review
  'github.submission', 'project.evidence_refresh', 'project.note_add',
  // Stage 10A Part 1: private priority certificate processing
  'priority.invite_create', 'priority.invite_redeem', 'priority.invite_revoke', 'priority.request_create', 'priority.plan_choose', 'priority.plan_offer', 'priority.plan_issue',
  // Stage 10A Part 2: admin request management, free corrections, document supersession
  'priority.eligibility_review', 'priority.status_change', 'priority.note_add', 'priority.approve', 'priority.reject', 'priority.issue', 'priority.notify',
  // Stage 10B Part 1: manual UPI payments, pricing, payment configuration
  'pricing.update', 'payment.config_update', 'payment.order_create', 'payment.order_expire', 'payment.submit', 'payment.duplicate_attempt', 'payment.proof_upload', 'permission.grant', 'permission.revoke',
  // Stage 10B Part 2A: administrator verification, duplicate flags, audited resubmission
  'payment.verify', 'refund.request', 'refund.pending', 'refund.complete', 'refund.reject', 'payment.reject', 'payment.resubmit', 'payment.duplicate_flag', 'payment.review_view', 'payment.proof_view',
  // Stage 10C Part 1: financial records, reports, export, destination refresh
  'payment.transaction_record', 'payment.report_view', 'payment.export',
  'correction.create', 'correction.approve', 'correction.cancel', 'correction.reissue', 'document.supersede',
];
export const AUDIT_RESULTS = ['success', 'failure'];
const keyFingerprint = () => (config.adminApiKey ? crypto.createHash('sha256').update(config.adminApiKey).digest('hex').slice(0, 8) : 'none');

// `admin` is the req.admin object (session or key) or nothing (the automation worker). Only an ID and a display name are kept.
export function actorOf(admin) {
  if (admin?.via === 'session' && admin.id) return { id: admin.id, name: String(admin.fullName ?? 'Administrator').slice(0, 80), type: 'admin' };
  if (admin?.via === 'key') return { id: `key:${keyFingerprint()}`, name: 'Admin API key', type: 'key' };
  return { id: null, name: 'Automation', type: 'system' };
}

export function record({ admin, action, targetType = null, targetId = null, result = 'success', reason = null, actorName = null }) {
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`Unknown audit action: ${action}`);
  if (!AUDIT_RESULTS.includes(result)) throw new Error(`Unknown audit result: ${result}`);
  const who = actorOf(admin);
  if (actorName && who.type === 'system') who.name = String(actorName).slice(0, 80); // e.g. 'Student (GitHub)': a label, never a person's name or e-mail
  const id = `AUD-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const text = (v, n) => (v === null || v === undefined || v === '' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) || null);
  db.prepare(`INSERT INTO audit_logs (id, admin_id, admin_name, actor_type, action, target_type, target_id, result, reason, created_at)
    VALUES (@id, @adminId, @adminName, @type, @action, @targetType, @targetId, @result, @reason, @now)`)
    .run({ id, adminId: who.id, adminName: who.name, type: who.type, action, targetType: text(targetType, 40), targetId: text(targetId, 80), result, reason: text(reason, 300), now: new Date().toISOString() });
  return id;
}

const toEntry = (r) => ({
  id: r.id, adminId: r.admin_id, adminName: r.admin_name, actorType: r.actor_type, action: r.action,
  relatedType: r.target_type, relatedId: r.target_id, result: r.result, reason: r.reason, timestamp: r.created_at,
});
const day = (d, end) => `${d}T${end ? '23:59:59.999' : '00:00:00.000'}Z`;

export function page({ action = null, from = null, to = null, adminId = null, result = null, targetType = null, targetId = null, limit, offset }) {
  const where = []; const args = [];
  if (action) { where.push('action = ?'); args.push(action); }
  if (from) { where.push('created_at >= ?'); args.push(day(from, false)); }
  if (to) { where.push('created_at <= ?'); args.push(day(to, true)); }
  if (adminId) { where.push('admin_id = ?'); args.push(adminId); }
  if (result) { where.push('result = ?'); args.push(result); }
  if (targetType) { where.push('target_type = ?'); args.push(targetType); }
  if (targetId) { where.push('target_id = ?'); args.push(targetId); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM audit_logs ${w} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(toEntry);
  return { total, rows };
}
export const forTarget = (targetType, targetId, limit = 50) =>
  db.prepare('SELECT * FROM audit_logs WHERE target_type = ? AND target_id = ? ORDER BY seq DESC LIMIT ?').all(targetType, targetId, limit).map(toEntry);
// Administrators that appear in the log, for the "filter by admin" control. Names only; no e-mail.
export const adminsInLog = () => db.prepare('SELECT admin_id, MAX(admin_name) AS admin_name FROM audit_logs WHERE admin_id IS NOT NULL GROUP BY admin_id ORDER BY admin_name').all()
  .map((r) => ({ id: r.admin_id, name: r.admin_name }));
