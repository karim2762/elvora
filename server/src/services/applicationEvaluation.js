import { HttpError, notFound } from '../utils/errors.js';
import { db } from '../db/index.js';
import { todayIST } from '../utils/dates.js';
import * as applications from '../db/applications.js';
import * as students from '../db/students.js';
import * as listings from '../db/internshipListings.js';
import * as repo from '../db/evaluations.js';
import * as taskRepo from '../db/tasks.js';
import { record as audit } from '../db/audit.js';
import { APPLICATION_ID_RE } from '../utils/applicationId.js';
import { parseApplicationCriteria, parseEvaluationReview, APPLICATION_CRITERION_KEYS } from '../utils/taskValidation.js';

// Stage 09A — transparent application evaluation.
//
// WHAT THIS IS: for one application it lists, criterion by criterion, what is met, what is not met and what only a person can judge,
// and ends with a RECOMMENDATION. WHAT IT IS NOT: a decision. Hard rules, enforced by the shape of this file:
//   - It never writes applications.status. Approving or rejecting stays exactly as before (PATCH /admin/applications/:id/status).
//   - The recommendation has two values only: "recommend_approval" or "needs_review". There is no "reject" and no score, so no application
//     can be turned away by this code. Unmet criteria are reported so a person can look; they are never held against the student automatically.
//   - It reads an ALLOW-LIST of facts (profile completeness, the skills the student themselves declared, seats, the application window and
//     the account being active). Name, e-mail, gender, age, religion, caste, disability, location, college and anything else personal are never read.
//   - Nothing is inferred or invented: a skill counts only if the student listed it; requirements that are free text (a listing's "knowledge"
//     prerequisites) are shown as MANUAL checks for an administrator instead of being guessed.
//   - Every run is stored (append-only) with the exact configuration used, and an administrator's response (accepted / overridden / more
//     information requested, with a reason) is stored next to it and audited.
export const DEFAULT_APPLICATION_CRITERIA = Object.freeze({
  profile_complete: { enabled: true },
  skills_prerequisite: { enabled: false, requiredSkills: [], minMatches: 1 },
  seats_available: { enabled: true },
  application_window: { enabled: true },
  account_active: { enabled: true },
});
const LABELS = {
  profile_complete: 'Profile complete', skills_prerequisite: 'Required skills declared', seats_available: 'Seats available', application_window: 'Applied within the application window',
  account_active: 'Student account active', duplicate_application: 'No duplicate application', listing_requirements_manual: 'Listing’s own prerequisites',
};
const PLACEHOLDER = /^(not provided|n\/a|na|none|-+)$/i;
const filled = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && !PLACEHOLDER.test(v.trim()));
const norm = (s) => String(s).trim().toLowerCase();

export const effectiveConfig = (listingId) => {
  const stored = taskRepo.getCriteria(listingId, 'application')?.config ?? {};
  return Object.fromEntries(APPLICATION_CRITERION_KEYS.map((k) => [k, { ...DEFAULT_APPLICATION_CRITERIA[k], ...(stored[k] ?? {}) }]));
};

const r = (key, result, detail) => ({ key, label: LABELS[key], result, detail });

// Pure: the same inputs always give the same answer.
export function evaluate({ application, student, listing, config, approvedCount, otherApplications, now = new Date() }) {
  const out = [];
  if (config.profile_complete.enabled) {
    const missing = [['phone', 'phone number'], ['college', 'college'], ['degree', 'degree'], ['branch', 'branch'], ['academicYear', 'academic year'], ['graduationYear', 'graduation year'], ['skills', 'at least one skill']]
      .filter(([k]) => !filled(student?.[k])).map(([, label]) => label);
    out.push(missing.length ? r('profile_complete', 'not_met', `Missing from the profile: ${missing.join(', ')}.`) : r('profile_complete', 'met', 'All required profile fields are filled in.'));
  } else out.push(r('profile_complete', 'not_applicable', 'Not checked for this internship.'));

  const sp = config.skills_prerequisite;
  if (sp.enabled && sp.requiredSkills?.length) {
    const declared = new Set([...(application.responses?.skills ?? []), ...(student?.skills ?? [])].map(norm)); // only what the student themselves listed
    const matched = sp.requiredSkills.filter((s) => declared.has(norm(s))); const need = Math.min(sp.minMatches ?? 1, sp.requiredSkills.length);
    out.push(matched.length >= need ? r('skills_prerequisite', 'met', `Declared ${matched.length} of the ${sp.requiredSkills.length} listed skills (${matched.join(', ')}).`)
      : r('skills_prerequisite', 'not_met', `Declared ${matched.length} of the ${sp.requiredSkills.length} listed skills; ${need} needed. Not declared: ${sp.requiredSkills.filter((s) => !declared.has(norm(s))).join(', ')}.`));
  } else out.push(r('skills_prerequisite', 'not_applicable', 'No required skills are configured for this internship.'));

  if (config.seats_available.enabled) {
    if (!listing) out.push(r('seats_available', 'not_met', 'The internship listing could not be found.'));
    else if (listing.seats == null) out.push(r('seats_available', 'met', 'This internship has no seat limit.'));
    else out.push(approvedCount < listing.seats ? r('seats_available', 'met', `${approvedCount} of ${listing.seats} seats are taken.`) : r('seats_available', 'not_met', `All ${listing.seats} seats are already taken by approved applications.`));
  } else out.push(r('seats_available', 'not_applicable', 'Not checked for this internship.'));

  if (config.application_window.enabled) {
    if (!listing) out.push(r('application_window', 'not_met', 'The internship listing could not be found.'));
    else {
      const appliedOn = todayIST(new Date(application.submittedAt)); const problems = [];
      if (listing.archivedAt) problems.push('the listing is archived');
      if (listing.deadline && appliedOn > listing.deadline) problems.push(`it was submitted on ${appliedOn}, after the ${listing.deadline} deadline`);
      out.push(problems.length ? r('application_window', 'not_met', `Check: ${problems.join('; ')}.`) : r('application_window', 'met', listing.deadline ? `Submitted on ${appliedOn}, on or before the ${listing.deadline} deadline.` : 'The internship has no deadline.'));
    }
  } else out.push(r('application_window', 'not_applicable', 'Not checked for this internship.'));

  if (config.account_active.enabled) {
    out.push(student && student.role !== 'admin' && student.accountStatus === 'active' ? r('account_active', 'met', 'The student account is active.') : r('account_active', 'not_met', 'The student account is not active.'));
  } else out.push(r('account_active', 'not_applicable', 'Not checked for this internship.'));

  out.push(otherApplications === 0 ? r('duplicate_application', 'met', 'This is the only application from this student for this internship.') : r('duplicate_application', 'not_met', 'This student has another application for the same internship.'));

  const knowledge = listing?.eligibility?.knowledge ?? [];
  if (knowledge.length) out.push(r('listing_requirements_manual', 'manual', `The listing asks for: ${knowledge.join('; ')}. These can’t be checked automatically. An administrator should confirm them from the application.`));

  const notMet = out.filter((c) => c.result === 'not_met');
  const manual = out.filter((c) => c.result === 'manual');
  return {
    recommendation: notMet.length ? 'needs_review' : 'recommend_approval',
    criteria: out,
    summary: { met: out.filter((c) => c.result === 'met').length, notMet: notMet.length, manual: manual.length, notApplicable: out.filter((c) => c.result === 'not_applicable').length },
    explanation: notMet.length
      ? `${notMet.length} criteri${notMet.length === 1 ? 'on is' : 'a are'} not met (${notMet.map((c) => c.label).join(', ')}). This needs an administrator’s review. It is not a rejection.`
      : `Every automatic criterion that applies is met${manual.length ? `; ${manual.length} check${manual.length === 1 ? '' : 's'} need${manual.length === 1 ? 's' : ''} a person` : ''}. This is a recommendation only. An administrator decides.`,
  };
}

const load = (id) => {
  if (!APPLICATION_ID_RE.test(String(id))) throw notFound('Application not found', 'APPLICATION_NOT_FOUND');
  const app = applications.findById(id); if (!app) throw notFound('Application not found', 'APPLICATION_NOT_FOUND');
  return app;
};
function compute(app, now = new Date()) {
  const studentId = applications.ownerOf(app.id);
  return { studentId, ...evaluate({
    application: app, student: students.findById(studentId), listing: listings.findById(app.internship.id), config: effectiveConfig(app.internship.id),
    approvedCount: repo.approvedCount(app.internship.id, app.id), otherApplications: repo.otherApplicationsCount(studentId, app.internship.id, app.id), now,
  }) };
}

// Latest stored evaluation + the administrator's responses. `stale` tells the admin the application changed after the evaluation ran.
export function getEvaluation(applicationId) {
  const app = load(applicationId); const latest = repo.latestFor(app.id);
  const reviews = repo.reviewsFor(app.id); const lastReview = reviews[reviews.length - 1] ?? null;
  return {
    applicationId: app.id, applicationStatus: app.status, evaluation: latest, evaluationCount: repo.countFor(app.id), reviews,
    reviewState: lastReview && latest && lastReview.evaluationId === latest.id ? ({ accepted: 'Recommendation accepted', overridden: 'Recommendation overridden', information_requested: 'Additional Information Required' })[lastReview.action] : null,
    stale: latest ? (latest.statusAtTime !== app.status || app.updatedAt > latest.evaluatedAt) : false,
    note: 'An evaluation is a recommendation. The application’s status only changes when an administrator changes it.',
  };
}

// Runs and STORES a new evaluation (administrator action). Cancelled applications are closed and are not evaluated.
export function runEvaluation(applicationId, admin) {
  const app = load(applicationId);
  if (app.status === 'Cancelled') throw new HttpError(409, 'A cancelled application can’t be evaluated.', { code: 'APPLICATION_CLOSED' });
  const c = compute(app);
  return db.transaction(() => {
    const saved = repo.insertEvaluation({ application: app, recommendation: c.recommendation, criteria: c.criteria, config: effectiveConfig(app.internship.id), admin });
    audit({ admin, action: 'application.evaluate', targetType: 'application', targetId: app.id, reason: `${c.recommendation}: ${c.summary.met} met, ${c.summary.notMet} not met, ${c.summary.manual} manual` });
    return { ...getEvaluation(app.id), evaluation: saved, explanation: c.explanation, summary: c.summary };
  })();
}

// The administrator's response to the latest evaluation. It never changes the application; it records WHAT the administrator did with the advice.
export function reviewEvaluation(applicationId, body, admin) {
  const app = load(applicationId); const v = parseEvaluationReview(body);
  const target = v.evaluationId ? repo.findById(v.evaluationId) : repo.latestFor(app.id);
  if (!target || target.applicationId !== app.id) throw notFound('Evaluation not found. Run an evaluation first.', 'EVALUATION_NOT_FOUND');
  return db.transaction(() => {
    repo.insertReview({ evaluationId: target.id, applicationId: app.id, action: v.action, reason: v.reason, admin });
    audit({ admin, action: 'application.evaluation_review', targetType: 'application', targetId: app.id, reason: `${v.action} (${target.recommendation})${v.reason ? ` — ${v.reason}` : ''}` });
    return getEvaluation(app.id);
  })();
}

// Read-only worklist: open applications (Submitted / Under Review) evaluated NOW, without storing anything, so an administrator can see who the
// system would recommend. Sorted with recommendations first; every row says exactly what was not met.
export function recommendations({ internshipId = null, limit = 100 } = {}) {
  const rows = repo.openApplicationIds({ internshipId, limit: Math.min(limit, 200) }).map((id) => {
    const app = applications.findById(id); const c = compute(app);
    return { applicationId: app.id, status: app.status, internshipId: app.internship.id, internshipTitle: app.internship.title, studentName: app.responses.fullName, submittedAt: app.submittedAt,
      recommendation: c.recommendation, notMet: c.criteria.filter((x) => x.result === 'not_met').map((x) => ({ key: x.key, label: x.label, detail: x.detail })), manualChecks: c.summary.manual };
  });
  rows.sort((a, b) => (a.recommendation === b.recommendation ? a.submittedAt.localeCompare(b.submittedAt) : a.recommendation === 'recommend_approval' ? -1 : 1));
  return { applications: rows, counts: { recommendApproval: rows.filter((x) => x.recommendation === 'recommend_approval').length, needsReview: rows.filter((x) => x.recommendation === 'needs_review').length },
    note: 'These are recommendations computed just now and not stored. Nothing here approves or rejects anyone.' };
}

// ---- per-listing configuration (admin) ----
const loadListing = (id) => { const l = listings.findById(id); if (!l) throw notFound('Internship not found', 'LISTING_NOT_FOUND'); return l; };
export function getApplicationCriteria(listingId) {
  const l = loadListing(listingId); const stored = taskRepo.getCriteria(l.id, 'application');
  return { internshipId: l.id, criteria: effectiveConfig(l.id), defaults: DEFAULT_APPLICATION_CRITERIA, customized: Boolean(stored), updatedAt: stored?.updatedAt ?? null,
    note: 'Only these criteria exist. Personal or sensitive attributes can’t be used.' };
}
export function setApplicationCriteria(listingId, body, admin) {
  const l = loadListing(listingId); const { criteria } = parseApplicationCriteria(body);
  const next = effectiveConfig(l.id);
  for (const [k, v] of Object.entries(criteria)) next[k] = { ...next[k], ...v };
  return db.transaction(() => {
    const saved = taskRepo.setCriteria(l.id, 'application', next, admin);
    audit({ admin, action: 'criteria.update', targetType: 'listing', targetId: l.id, reason: `application: ${Object.keys(criteria).join(', ')}` });
    return { internshipId: l.id, criteria: saved.config, customized: true, updatedAt: saved.updatedAt };
  })();
}

// Stage 10D: the same pure evaluation, exposed read-only for services/autoApproval.js (it stores nothing by itself).
export const computeEvaluation = compute;
