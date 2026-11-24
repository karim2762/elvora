import { db } from '../db/index.js';
import { config } from '../config/index.js';
import * as applications from '../db/applications.js';
import * as repo from '../db/evaluations.js';
import { computeEvaluation } from './applicationEvaluation.js';

// Stage 10D — automatic APPLICATION approval (not task approval). OFF unless AUTO_APPROVE_APPLICATIONS=true.
//
// An application is approved automatically only when EVERY condition below holds. If any one fails, nothing happens to it:
// it stays "Submitted" for an administrator exactly as before. Nothing is ever rejected, put "Under Review" or changed otherwise.
//   1. It is still "Submitted" (an administrator who moved it to "Under Review", rejected or reopened it keeps full control).
//   2. No administrator has written a note on it.
//   3. It was submitted at least AUTO_APPROVE_DELAY_MINUTES ago.
//   4. Its internship is allowed (AUTO_APPROVE_INTERNSHIPS, default every listing) and not longer than AUTO_APPROVE_MAX_DURATION_DAYS (0 = no limit).
//   5. The existing transparent evaluation (Stage 09A, using the listing's own criteria) recommends approval: profile complete, required skills
//      declared, seat available, inside the application window, account active, no duplicate application.
//   6. If the listing has free-text prerequisites a computer cannot check, they only block when AUTO_APPROVE_ALLOW_MANUAL_CHECKS=false.
//   7. The student holds fewer than AUTO_APPROVE_MAX_ACTIVE unfinished internships (awaiting start or active).
// Every approval goes through the normal applications.changeStatus(): same history row, student notification and audit entry,
// recorded under the name "Automation" with the reason shown. The evaluation that justified it is stored next to the application.
const ACTOR = { id: null, fullName: 'Automation' };
// Unfinished internships = approved applications that have no internship record yet, plus internships awaiting start or active.
const unfinishedInternships = (studentId) => db.prepare("SELECT COUNT(*) AS n FROM applications a LEFT JOIN enrollments e ON e.application_id = a.id WHERE a.student_id = ? AND a.status = 'Approved' AND (e.id IS NULL OR e.status IN ('Awaiting Start', 'Active'))").get(studentId).n;
const hasAdminNote = (id) => Boolean(db.prepare('SELECT 1 FROM application_notes WHERE application_id = ? LIMIT 1').get(id));

// Pure check of the cheap conditions (1–4) so they are easy to test. Returns null when allowed, or the reason it must wait.
export function holdReason(app, { now = new Date(), cfg = config.automation.autoApproveApplications } = {}) {
  if (app.status !== 'Submitted') return 'not in Submitted status';
  if (now.getTime() - Date.parse(app.submittedAt) < cfg.delayMinutes * 60_000) return 'waiting period not over';
  if (!cfg.internships.includes('*') && !cfg.internships.includes(app.internship.id)) return 'internship is not on the auto-approve list';
  if (cfg.maxDurationDays > 0 && Number(app.internship.durationDays) > cfg.maxDurationDays) return 'internship is longer than the auto-approve limit';
  return null;
}

export function autoApproveApplications({ now = new Date(), cfg = config.automation.autoApproveApplications } = {}) {
  const result = { approved: 0, waiting: 0 };
  if (!cfg.enabled) return result;
  for (const id of repo.openApplicationIds({ limit: 200 })) {
    const app = applications.findById(id);
    if (!app || holdReason(app, { now, cfg }) || hasAdminNote(id)) { result.waiting += 1; continue; }
    const c = computeEvaluation(app, now);
    if (c.recommendation !== 'recommend_approval' || (!cfg.allowManualChecks && c.summary.manual > 0) || unfinishedInternships(c.studentId) >= cfg.maxActivePerStudent) { result.waiting += 1; continue; }
    const note = `Automatically approved: ${c.summary.met} criteria met, none unmet${c.summary.manual ? `, ${c.summary.manual} prerequisite(s) not machine-checkable` : ''}.`;
    db.transaction(() => {
      repo.insertEvaluation({ application: app, recommendation: c.recommendation, criteria: c.criteria, config: { auto: true }, admin: ACTOR });
      applications.changeStatus(id, 'Approved', { admin: ACTOR, note });
    })();
    result.approved += 1;
  }
  return result;
}
