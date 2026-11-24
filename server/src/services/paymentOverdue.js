import * as Pay from '../db/payments.js';
import { insert as notify } from '../db/notifications.js';
import { adminsWith } from './payments.js';
import { formatInr } from './priorityCertificate.js';

// Stage 10B Part 2B — verification deadlines. The deadline is the configured verification TARGET (a goal, not a guarantee). A payment past it is reported and the
// reviewers are told once; it is never approved, rejected or otherwise changed because time passed.
export const OVERDUE_NOTICE = 'The verification target is an internal goal. Overdue payments are highlighted and reviewers are notified, but nothing is approved or rejected automatically.';
export function overdueReport() {
  const rows = Pay.overduePending();
  return { notice: OVERDUE_NOTICE, count: rows.length, payments: rows.map((r) => ({ ...r, expectedDisplay: formatInr(r.expectedPaise) })) };
}
// Idempotent: the notification key contains the payment and the deadline, and notifications are unique per (administrator, key), so running this any number of
// times creates each reviewer's notification once. A corrected resubmission gets a new deadline and therefore (if it too becomes overdue) a new notice.
export function sweepOverdue() {
  const rows = Pay.overduePending(); const reviewers = rows.length ? adminsWith('payment.review') : []; let created = 0;
  for (const r of rows) for (const adminId of reviewers) {
    if (adminId === r.studentId) continue;
    if (notify({ studentId: adminId, type: 'payment_overdue_admin', title: 'Payment verification overdue', message: `Payment ${r.internalReference ?? r.id} (${formatInr(r.expectedPaise)}) passed its verification target (${r.deadline.slice(0, 16).replace('T', ' ')} UTC) and is still waiting for review.`, dedupeKey: `pay:${r.id}:overdue:${r.deadline}` })) created += 1;
  }
  return { overdue: rows.length, notificationsCreated: created };
}
