import { HttpError, notFound } from '../utils/errors.js';
import { db } from '../db/index.js';
import * as enrollments from '../db/enrollments.js';
import * as tasks from '../db/tasks.js';
import * as listings from '../db/internshipListings.js';
import { record as audit } from '../db/audit.js';
import { parseCompletionCriteria } from '../utils/taskValidation.js';

// Stage 09A — "has this student actually done the work?". The ONE place that answers it. It is called by:
//   - the administrator's Complete action (services/internshipLifecycle.js),
//   - every status change to Completed (services/enrollments.js), which also covers the background worker and the legacy console,
//   - certificate eligibility (documents/eligibility.js, through taskGate), so a certificate can't be issued around an unfinished plan.
//
// Rules (they only ever ADD a requirement for a student who was actually given tasks; internships without tasks behave exactly as before):
//   - no tasks configured for the listing                          → not applicable (nothing changes)
//   - tasks configured, student has NO assignments yet             → "attention" (visible, not blocking: the plan can be assigned; the worker does it)
//   - student has assignments                                      → required tasks must be Approved (percentage configurable, default 100%)
//   - optional "final project" requirement                         → every required Final Project task must be Approved
// An administrator's approval of a submission is the ONLY thing that counts. A deadline passing, or a submission waiting for review, never does.
export const DEFAULT_COMPLETION_CRITERIA = Object.freeze({ requiredTasksApprovedPercent: 100, requireFinalProject: false });

export const effectiveCriteria = (internshipId) => ({ ...DEFAULT_COMPLETION_CRITERIA, ...(tasks.getCriteria(internshipId, 'completion')?.config ?? {}) });

export function evaluateTasks(enrollment) {
  const criteria = effectiveCriteria(enrollment.internship.id);
  const p = tasks.progressFor(enrollment.id);
  const listingHasTasks = tasks.hasPublishedRequiredTasks(enrollment.internship.id);
  const planAssigned = p.total > 0;
  const checks = [];
  if (!planAssigned && !listingHasTasks) {
    checks.push({ key: 'tasks', label: 'Internship tasks', status: 'not_applicable', blocking: false, detail: 'This internship has no required tasks configured.' });
  } else if (!planAssigned) {
    checks.push({ key: 'tasks_assigned', label: 'Task plan assigned', status: 'attention', blocking: false,
      detail: 'This internship now has required tasks, but none were assigned to this student yet. Assign the task plan so their work can be reviewed.' });
  } else {
    const pct = p.requiredTotal === 0 ? 100 : Math.floor((p.requiredApproved * 100) / p.requiredTotal);
    const ok = pct >= criteria.requiredTasksApprovedPercent;
    checks.push({ key: 'required_tasks_approved', label: 'Required tasks approved', status: ok ? 'met' : 'not_met', blocking: !ok,
      detail: `${p.requiredApproved} of ${p.requiredTotal} required task${p.requiredTotal === 1 ? '' : 's'} approved (${pct}%; ${criteria.requiredTasksApprovedPercent}% needed).${p.awaitingReview ? ` ${p.awaitingReview} submission${p.awaitingReview === 1 ? ' is' : 's are'} waiting for review.` : ''}` });
    if (criteria.requireFinalProject) {
      const finalOk = p.finalProjectTotal > 0 && p.finalProjectApproved === p.finalProjectTotal;
      checks.push({ key: 'final_project_approved', label: 'Final project approved', status: finalOk ? 'met' : 'not_met', blocking: !finalOk,
        detail: p.finalProjectTotal === 0 ? 'A final project is required, but no required Final Project task is assigned.' : `${p.finalProjectApproved} of ${p.finalProjectTotal} final project task${p.finalProjectTotal === 1 ? '' : 's'} approved.` });
    }
  }
  return { criteria, progress: p, planAssigned, checks, blocking: checks.some((c) => c.blocking) };
}

// Used by lifecycle.completionChecks: same shape as the existing checks ({ key, label, need, passed }) so the Complete action and its UI list need no change.
export const asLifecycleChecks = (enrollment) => evaluateTasks(enrollment).checks
  .filter((c) => c.status !== 'not_applicable')
  .map((c) => ({ key: c.key, label: c.label, need: c.status === 'not_met' ? c.detail : undefined, passed: !c.blocking, detail: c.detail }));

// { blocking, message, code } — what the other paths need. Never throws.
export function taskGate(enrollment) {
  const r = evaluateTasks(enrollment);
  const failed = r.checks.filter((c) => c.blocking);
  return { blocking: r.blocking, code: 'TASKS_INCOMPLETE', message: failed.map((c) => c.detail).join(' ') || null, evaluation: r };
}
export function assertTasksSatisfied(enrollment) {
  const g = taskGate(enrollment);
  if (g.blocking) throw new HttpError(409, `Can’t complete yet. ${g.message}`, { code: 'TASKS_INCOMPLETE', details: { checks: g.evaluation.checks } });
}

// Full report for the admin API.
export function completionEvaluation(enrollmentId) {
  const e = enrollments.findById(enrollmentId);
  if (!e) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  const t = evaluateTasks(e);
  const certificate = e.certificateReview.decision;
  return {
    internshipRecordId: e.id, internshipId: e.internship.id, status: e.status, criteria: t.criteria, planAssigned: t.planAssigned, taskProgress: t.progress, checks: t.checks,
    taskRequirementsMet: !t.blocking, certificateDecision: certificate,
    note: 'Completion and certificates still need the administrator’s own confirmation. Meeting the task requirements never completes an internship or issues a certificate by itself.',
  };
}

// ---- per-listing configuration (admin) ----
const loadListing = (id) => { const l = listings.findById(id); if (!l) throw notFound('Internship not found', 'LISTING_NOT_FOUND'); return l; };
export function getCompletionCriteria(listingId) {
  const l = loadListing(listingId); const stored = tasks.getCriteria(l.id, 'completion');
  return { internshipId: l.id, criteria: effectiveCriteria(l.id), defaults: DEFAULT_COMPLETION_CRITERIA, customized: Boolean(stored), updatedAt: stored?.updatedAt ?? null };
}
export function setCompletionCriteria(listingId, body, admin) {
  const l = loadListing(listingId); const v = parseCompletionCriteria(body);
  const next = { ...effectiveCriteria(l.id), ...v };
  const out = db.transaction(() => {
    const saved = tasks.setCriteria(l.id, 'completion', next, admin);
    audit({ admin, action: 'criteria.update', targetType: 'listing', targetId: l.id, reason: `completion: ${Object.entries(v).map(([k, x]) => `${k}=${x}`).join(', ')}` });
    return saved;
  })();
  return { internshipId: l.id, criteria: out.config, customized: true, updatedAt: out.updatedAt };
}
