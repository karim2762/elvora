import fs from 'node:fs';
import { config } from '../config/index.js';
import { todayIST, addDays } from '../utils/dates.js';
import * as applications from '../db/applications.js';
import * as enrollments from '../db/enrollments.js';
import * as students from '../db/students.js';
import * as docs from '../db/documents.js';
import * as state from '../db/automation.js';
import { createEnrollment, changeEnrollmentStatus } from '../services/enrollments.js';
import { issueGenerated, adminFile } from '../documents/issuance.js';
import { sendDocumentEmail, isEmailConfigured } from '../utils/mailer.js';
import { verificationUrl } from '../documents/verification.js';
import * as taskRepo from '../db/tasks.js';
import { assignPlan } from '../services/internshipTasks.js';
import { sweepOverdue } from '../services/paymentOverdue.js';
import { taskGate } from '../services/completionEligibility.js';
import { autoApproveApplications } from '../services/autoApproval.js';
import { fulfilAllDue } from '../services/instantCertificate.js';

// Background automation (Stage 07). One cycle does, in order:
//   1. approved application without an internship  -> create the internship (start date = approval day + AUTO_START_DELAY_DAYS)
//   2. internship whose start date has arrived      -> Active
//   3. Active internship the admin approved a certificate for, end date passed -> Completed
//   4. approved internship without an offer letter  -> generate + issue the offer letter       (target: within OFFER_SLA_HOURS)
//   5. Completed internship with certificate "Approved" by an administrator -> generate + issue the certificate
//   6. issued documents not yet e-mailed            -> e-mail the PDF (only when SMTP is configured)
// Safe to run any number of times: every step looks at stored records, issuance is guarded by the database, and failures
// are remembered with a back-off so one broken record never blocks the others. A certificate is NEVER issued without the
// administrator's approval (documents/eligibility.js enforces that again at issuance).
const ACTOR = 'Automation';
const log = (...a) => console.log('[automation]', ...a);
const retryAt = (attempts, now) => new Date(now.getTime() + Math.min(60, 5 * 2 ** attempts) * 60_000).toISOString(); // 5, 10, 20, 40, 60 … minutes
const reason = (err) => `${err?.code ? `${err.code}: ` : ''}${err?.message ?? err}`.slice(0, 300);
const due = (s, now) => !s?.nextAttemptAt || s.nextAttemptAt <= now.toISOString();

let running = null;
let last = null;

async function issueIfDue(type, id, now, force, summary) {
  const s = state.get(id, type);
  if (!force && !due(s, now)) return;
  try {
    await issueGenerated({ type, enrollmentId: id, issuedBy: ACTOR });
    state.recordIssued(id, type, now);
    summary[type === 'certificate' ? 'certificatesIssued' : 'offerLettersIssued'] += 1;
  } catch (err) {
    if (err?.code === 'DOCUMENT_EXISTS') return; // someone else issued it a moment ago
    state.recordFailure(id, type, reason(err), retryAt((s?.attempts ?? 0) + 1, now), now);
    summary.failures.push({ enrollmentId: id, type, error: reason(err) });
  }
}

export async function runCycle({ now = new Date(), force = false } = {}) {
  const summary = { at: now.toISOString(), enrolled: 0, started: 0, tasksAssigned: 0, completed: 0, offerLettersIssued: 0, certificatesIssued: 0, emailsSent: 0, failures: [], overdueOffers: 0, applicationsApproved: 0 };
  const a = config.automation;
  const today = todayIST(now);
  const guard = (label, fn) => { try { return fn(); } catch (err) { summary.failures.push({ step: label, error: reason(err) }); return undefined; } };

  guard('payment-overdue', () => { summary.overduePayments = sweepOverdue().overdue; }); // Stage 10B: notify reviewers once; never decides a payment
  // Stage 10D: approve applications that meet every configured condition (OFF by default), so the internship record below is created in the same cycle.
  guard('auto-approve-applications', () => { summary.applicationsApproved = autoApproveApplications({ now }).approved; });
  if (a.autoEnroll) {
    for (const app of applications.listApprovedWithoutEnrollment()) {
      guard('auto-enroll', () => { const planned = addDays(todayIST(new Date(app.approvedAt ?? now)), a.autoStartDelayDays); createEnrollment(app.id, { startDate: planned < today ? today : planned }); summary.enrolled += 1; });
    }
  }
  if (a.autoActivate) {
    for (const id of enrollments.listDueToStart(today)) guard('auto-activate', () => { changeEnrollmentStatus(id, { status: 'Active' }, now); summary.started += 1; });
  }
  // Stage 09A: an Active internship that has tasks configured but was never given its plan (activation hook failed, or tasks were published afterwards)
  // gets it now. Idempotent. Students who already have a plan are never topped up here: that is an explicit administrator action.
  for (const id of [...new Set([...taskRepo.enrollmentsWithoutPlan(), ...taskRepo.openEnrollmentsWithoutAnyTask()])]) guard('task-plan', () => { summary.tasksAssigned += assignPlan(id).assigned; });
  // An internship whose student has required tasks that are not all approved is NEVER completed automatically, whatever the date says.
  for (const id of enrollments.listDueToComplete(today)) guard('auto-complete', () => {
    if (taskGate(enrollments.findById(id)).blocking) return;
    changeEnrollmentStatus(id, { status: 'Completed' }, now); summary.completed += 1;
  });

  for (const id of enrollments.listNeedingOffer()) await issueIfDue('offer_letter', id, now, force, summary);
  for (const id of enrollments.listNeedingCertificate()) await issueIfDue('certificate', id, now, force, summary);

  // Paid 1/2/3-month plans: offer letter right after approval, request marked finished once the certificate exists.
  try { await fulfilAllDue(); } catch (err) { summary.failures.push({ step: 'paid-plans', error: reason(err) }); }

  summary.emailsSent = await sendPendingEmails(now, summary);

  // SLA: approved applications still without an offer letter after OFFER_SLA_HOURS.
  const limit = now.getTime() - a.offerSlaHours * 3600_000;
  const waiting = [...applications.listApprovedWithoutEnrollment().map((x) => x.approvedAt),
    ...enrollments.listNeedingOffer().map((id) => applications.approvedAt(enrollments.findById(id).applicationId))];
  summary.overdueOffers = waiting.filter((t) => t && new Date(t).getTime() < limit).length;
  if (summary.overdueOffers) console.warn(`[automation] ${summary.overdueOffers} offer letter(s) are later than ${a.offerSlaHours}h. See Admin → Automation for the reasons.`);
  if (summary.enrolled || summary.started || summary.tasksAssigned || summary.completed || summary.offerLettersIssued || summary.certificatesIssued || summary.emailsSent) {
    log(`enrolled ${summary.enrolled}, started ${summary.started}, completed ${summary.completed}, offer letters ${summary.offerLettersIssued}, certificates ${summary.certificatesIssued}, e-mails ${summary.emailsSent}`);
  }
  last = summary;
  return summary;
}

async function sendPendingEmails(now, summary) {
  if (!config.automation.emailDocuments || !isEmailConfigured()) return 0;
  let sent = 0;
  for (const p of state.pendingEmails()) {
    if (p.email_attempts >= 8 || (p.next_attempt_at && p.next_attempt_at > now.toISOString())) continue;
    try {
      const d = docs.findAny(p.document_id);
      const student = students.findById(d.studentId);
      const file = adminFile(d.id);
      await sendDocumentEmail({
        to: student.email, name: student.fullName, type: d.type, internshipTitle: d.internship.title, documentNumber: d.documentNumber,
        verifyUrl: verificationUrl(d.verificationCode), documentsUrl: `${config.clientUrl}/student/documents`, fileName: d.fileName, pdf: fs.readFileSync(file.path),
      });
      state.recordEmail(p.enrollment_id, p.type, { ok: true }, now);
      sent += 1;
    } catch (err) {
      state.recordEmail(p.enrollment_id, p.type, { ok: false, error: reason(err), nextAttemptAt: retryAt(p.email_attempts + 1, now) }, now);
      summary.failures.push({ enrollmentId: p.enrollment_id, type: p.type, error: `email: ${reason(err)}` });
    }
  }
  return sent;
}

// One cycle at a time. Callers that arrive while one is running share its result.
export function runNow(opts) {
  if (!running) running = runCycle(opts).finally(() => { running = null; });
  return running;
}
// Fire-and-forget: used right after an administrator action so the student does not wait for the next timer tick.
export const kick = () => { setImmediate(() => runNow({ force: true }).catch((err) => console.error('[automation] cycle failed:', err))); };

let timer = null;
export function startAutomation() {
  if (!config.automation.enabled || timer) return false;
  timer = setInterval(() => runNow().catch((err) => console.error('[automation] cycle failed:', err)), config.automation.intervalMs);
  timer.unref?.();
  setTimeout(() => runNow().catch((err) => console.error('[automation] cycle failed:', err)), 3000).unref?.();
  log(`started: every ${Math.round(config.automation.intervalMs / 60000)} min, offer-letter target ${config.automation.offerSlaHours}h`);
  return true;
}
export const stopAutomation = () => { if (timer) clearInterval(timer); timer = null; };

// For the admin "Automation" card.
export function status() {
  const a = config.automation;
  return {
    enabled: a.enabled, running: timer !== null, intervalMinutes: Math.round(a.intervalMs / 60000), offerSlaHours: a.offerSlaHours,
    autoEnroll: a.autoEnroll, autoStartDelayDays: a.autoStartDelayDays, autoActivate: a.autoActivate,
    emailConfigured: a.emailDocuments && isEmailConfigured(),
    waiting: { offerLetters: enrollments.listNeedingOffer().length + applications.listApprovedWithoutEnrollment().length, certificates: enrollments.listNeedingCertificate().length },
    lastRun: last ? { at: last.at, enrolled: last.enrolled, started: last.started, completed: last.completed, offerLettersIssued: last.offerLettersIssued,
      certificatesIssued: last.certificatesIssued, emailsSent: last.emailsSent, overdueOffers: last.overdueOffers, failures: last.failures.length } : null,
    problems: state.failing().map((f) => ({ enrollmentId: f.enrollmentId, studentName: f.studentName, type: f.type, attempts: f.attempts, error: f.lastError, lastAttemptAt: f.lastAttemptAt, nextAttemptAt: f.nextAttemptAt })),
  };
}
