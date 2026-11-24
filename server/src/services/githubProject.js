import { HttpError, notFound } from '../utils/errors.js';
import { STUDENT_TASK_ID_RE } from '../tasks/constants.js';
import { requiresRepository } from '../tasks/githubSubmission.js';
import { parseSubmission } from '../utils/taskValidation.js';
import * as taskDb from '../db/tasks.js';
import * as gh from '../db/github.js';
import * as evalDb from '../db/projectEvaluations.js';
import { record as audit } from '../db/audit.js';
import * as repos from '../github/repositories.js';
import { inspect, snapshotView, canCallGitHub } from '../github/inspect.js';
import { verificationFor, ACADEMIC_NOTE } from '../github/verification.js';
import { notifyGithub } from '../github/notify.js';
import { asHttp } from '../github/errors.js';

// Stage 09C Part 2A — GitHub project submission (student) and repository evidence (administrator).
// Reuses the Stage 09B submission table, status rules, evaluation and notifications. Nothing here approves, scores or rejects anything:
// repository evidence is shown to a human reviewer, and counts (commits, files) are never used as a decision rule.
const OUTAGE = new Set(['GITHUB_UNAVAILABLE', 'GITHUB_RATE_LIMITED', 'GITHUB_ERROR', 'GITHUB_NOT_CONFIGURED', 'GITHUB_INSTALLATION_MISSING', 'GITHUB_INTERNAL']);
const conflict = (message, code, fields) => new HttpError(409, message, { code, ...(fields ? { fields } : {}) });
const norm = (u) => String(u ?? '').toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
const actor = { actorName: 'Student (GitHub)' };

// ---------------------------------------------------------------------------------------------------------------------------------
// Student: submit / resubmit a GitHub project
// ---------------------------------------------------------------------------------------------------------------------------------
export async function submitGithubProject(student, studentTaskId, body) {
  if (!STUDENT_TASK_ID_RE.test(String(studentTaskId))) throw notFound('Task not found', 'TASK_NOT_FOUND');
  const owned = taskDb.findOwnedStudentTask(studentTaskId, student.id);
  const task = owned ? taskDb.findTask(owned.taskId) : null;
  if (!owned || !task) throw notFound('Task not found', 'TASK_NOT_FOUND');
  if (!requiresRepository(task)) throw conflict('This task does not use a GitHub repository.', 'NOT_A_REPOSITORY_TASK');

  const values = parseSubmission(body, task); // throws 400 with field messages
  const missing = {};
  for (const [k, label] of [['implementedFeatures', 'Describe the features you implemented'], ['testingPerformed', 'Describe the testing you performed'], ['challengesEncountered', 'Describe the challenges you met']]) if (!values[k]) missing[k] = label;
  if (Object.keys(missing).length) throw new HttpError(400, 'Please fix the highlighted fields', { fields: missing });

  // Cheap status checks BEFORE any network call; taskDb.submit() re-checks them atomically.
  if (owned.projectStatus === 'Rejected') throw conflict('This project was rejected, so it can’t be resubmitted. Please contact your reviewer.', 'TASK_REJECTED');
  if (owned.status === 'Approved') throw conflict('This task has already been approved.', 'TASK_APPROVED');
  if (!['Assigned', 'In Progress', 'Changes Requested'].includes(owned.status)) throw conflict('Your submission is waiting for review.', 'AWAITING_REVIEW');

  // 1. Which repository? It must be the one linked to THIS task for THIS student (linking checks existence, owner and duplicates).
  let repo = gh.findRepoForTask(owned.id); let pending = null;
  if (!repo || norm(repo.url) !== norm(values.repositoryUrl)) {
    if (repo?.source === 'organization' && repo.state !== 'unavailable') throw conflict('ELVORA created a repository for this task. Submit that repository.', 'REPOSITORY_MISMATCH', { repositoryUrl: 'This is not the repository linked to your task' });
    try { repo = (await repos.linkRepository(student, owned.id, { repositoryUrl: values.repositoryUrl })).repository; }
    catch (err) { if (!OUTAGE.has(err.code)) throw err; repo = (await repos.linkRepository(student, owned.id, { repositoryUrl: values.repositoryUrl }, { offline: true })).repository; pending = 'GitHub could not be reached, so the repository has not been checked yet.'; }
  }
  // 2. Ownership / access, from GitHub's own answers only.
  if (!pending && canCallGitHub() && repo.ownershipStatus !== 'verified') {
    const account = gh.findAccount(student.id);
    if (!account || account.verificationStatus !== 'verified') throw conflict('Connect your GitHub account so we can confirm this repository is yours.', 'GITHUB_NOT_CONNECTED', { repositoryUrl: 'Connect your GitHub account first' });
    try {
      const r = await repos.verifyOwnership(student, owned.id); repo = r.repository;
      if (r.ownership.status === 'not_owner') throw new HttpError(403, 'This repository does not belong to your connected GitHub account. Submit a repository you own.', { code: 'REPOSITORY_NOT_OWNED', fields: { repositoryUrl: 'This repository is not yours' } });
      if (r.ownership.status !== 'verified') throw conflict(r.ownership.detail, 'ACCESS_NOT_CONFIRMED', { repositoryUrl: 'Access not confirmed yet' });
    } catch (err) { if (!OUTAGE.has(err.code)) throw err; pending = 'GitHub could not be reached, so ownership has not been confirmed yet.'; }
  } else if (!pending && !canCallGitHub()) pending = 'GitHub integration is not set up, so the repository has not been checked yet.';
  repo = gh.findRepoById(repo.id) ?? repo;

  // 3. Append the new version (never overwrites an earlier one) and record what was confirmed at this moment.
  const r = taskDb.submit({ studentTaskId: owned.id, studentId: student.id, values: { ...values, repositoryUrl: repo.url } });
  if (!r) throw notFound('Task not found', 'TASK_NOT_FOUND');
  const state = repo.ownershipStatus === 'verified' && !pending ? 'verified' : 'pending_verification';
  gh.insertCheck({ submissionId: r.submission.id, studentTaskId: owned.id, repositoryId: repo.id, repositoryUrl: repo.url, state, reason: pending, ownershipStatus: repo.ownershipStatus, visibility: repo.visibility });
  notifyGithub('project_submitted', { studentId: student.id, studentTaskId: owned.id, version: r.submission.version, key: r.submission.id });
  notifyGithub(state === 'verified' ? 'submission_verified' : 'github_verification_pending', { studentId: student.id, studentTaskId: owned.id, detail: pending ?? undefined, key: `sub:${r.submission.id}` });
  audit({ ...actor, action: 'github.submission', targetType: 'student_task', targetId: owned.id, reason: `Submitted version ${r.submission.version} of ${repo.owner}/${repo.name} (${state})` });

  // 4. Refresh the evidence for the reviewer (best effort: a GitHub failure never undoes a valid submission).
  if (canCallGitHub()) { try { await inspect(gh.findRepoById(repo.id), { requestedBy: student.id, studentActor: true }); } catch { /* recorded as a snapshot; reviewer can refresh */ } }
  return { submission: r.submission, verification: verificationFor(gh.findRepoById(repo.id)), checkedWithGitHub: !pending, pendingReason: pending };
}

// Student: every version with what was confirmed for it. Reviewer notes are internal and never included.
export function submissionHistory(student, studentTaskId) {
  const owned = STUDENT_TASK_ID_RE.test(String(studentTaskId)) ? taskDb.findOwnedStudentTask(studentTaskId, student.id) : null;
  if (!owned) throw notFound('Task not found', 'TASK_NOT_FOUND');
  const checks = gh.checksFor(owned.id);
  const repo = gh.findRepoForTask(owned.id);
  return { submissions: taskDb.submissionsFor(owned.id).map((s) => ({ ...s, verification: checks[s.id] ? { state: checks[s.id].state, checkedAt: checks[s.id].checkedAt, message: checks[s.id].state === 'verified' ? 'Repository confirmed when you submitted.' : 'Repository was not confirmed yet when you submitted.' } : null })),
    reviews: taskDb.reviewsFor(owned.id), verification: verificationFor(repo), academicNote: ACADEMIC_NOTE };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Administrator: evidence, refresh, internal notes
// ---------------------------------------------------------------------------------------------------------------------------------
// README is untrusted. It leaves here as PLAIN TEXT only: control characters removed, length capped, never HTML. The client must render it as text.
export function safeReadme(readme) {
  if (!readme?.present) return { present: false, format: 'plain_text', text: '', truncated: false };
  const text = String(readme.content ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  return { present: true, format: 'plain_text', text: text.slice(0, 6000), truncated: text.length > 6000 || !!readme.truncated };
}
const safeUrl = (u) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(String(u ?? '')) ? u : null);

export function githubEvidence(studentTaskId) {
  const repo = gh.findRepoForTask(studentTaskId);
  const checks = gh.checksFor(studentTaskId);
  const subs = taskDb.submissionsFor(studentTaskId).map((s) => ({ version: s.version, submittedAt: s.submittedAt, repositoryUrl: s.repositoryUrl, liveUrl: s.liveUrl, description: s.description, implementedFeatures: s.implementedFeatures, testingPerformed: s.testingPerformed,
    challengesEncountered: s.challengesEncountered, submissionNotes: s.submissionNotes, check: checks[s.id] ?? null }));
  const latest = subs.at(-1) ?? null;
  const out = { configured: canCallGitHub(), repository: null, verification: verificationFor(null), submittedUrlMatchesLinked: null, evidence: null, lastInspection: null, submissions: subs, notes: gh.notesFor(studentTaskId),
    notice: 'Commit and file counts are evidence of activity, not of quality. Tests were not executed. ELVORA never runs repository code. You decide the outcome using the evaluation rubric.' };
  if (!repo) return out;
  const view = repos.repositoryView(repo, { admin: true });
  const snap = gh.latestSnapshot(repo.id); const ok = snap?.status === 'ok' ? snap : gh.latestOkSnapshot(repo.id);
  out.repository = { ...view, openUrl: safeUrl(repo.url) };
  out.verification = view.verification;
  out.submittedUrlMatchesLinked = latest?.repositoryUrl ? norm(latest.repositoryUrl) === norm(repo.url) : null;
  out.lastInspection = snap ? { status: snap.status, inspectedAt: snap.inspectedAt, error: snap.status === 'ok' ? null : snapshotView(snap).error } : null;
  if (ok) {
    const d = ok.data.verifiedFromGitHub; const total = Object.values(d.languages ?? {}).reduce((a, b) => a + Number(b || 0), 0);
    out.evidence = {
      inspectedAt: ok.inspectedAt, stale: snap?.id !== ok.id,
      metadata: { name: d.repository.fullName, owner: d.repository.owner?.login, visibility: d.repository.visibility, createdAt: d.repository.createdAt, updatedAt: d.repository.updatedAt, pushedAt: d.repository.pushedAt, defaultBranch: d.repository.defaultBranch, archived: d.repository.archived },
      readme: safeReadme(d.readme),
      languages: Object.entries(d.languages ?? {}).map(([name, bytes]) => ({ name: String(name).slice(0, 40), bytes: Number(bytes), percent: total ? Math.round((Number(bytes) / total) * 1000) / 10 : 0 })).sort((a, b) => b.bytes - a.bytes),
      files: { total: d.files.total, topLevel: d.files.topLevel, paths: d.files.paths.slice(0, 200), truncated: d.files.truncated, hasTestFiles: d.files.hasTestFiles, testFiles: d.files.testFiles },
      commits: { shown: d.commits.latest.length, countIsExact: false, latest: d.commits.latest },
      branches: d.branches,
    };
  }
  return out;
}

const guard = (row, admin) => {
  if (!admin?.id || admin.via !== 'session') throw new HttpError(403, 'Only a signed-in administrator can do this.', { code: 'ADMIN_REQUIRED' });
  if (admin.id === row.student_id) throw new HttpError(403, 'You cannot review your own project.', { code: 'SELF_REVIEW' });
};
const loadRow = (id) => { const row = STUDENT_TASK_ID_RE.test(String(id)) ? evalDb.gate(id) : null; if (!row) throw notFound('Project submission not found', 'SUBMISSION_NOT_FOUND'); return row; };

export async function refreshEvidence(id, admin) {
  const row = loadRow(id); guard(row, admin);
  const repo = gh.findRepoForTask(row.id);
  if (!repo) throw notFound('No repository is linked to this project.', 'REPOSITORY_NOT_FOUND');
  if (!canCallGitHub()) throw new HttpError(503, 'GitHub integration is not set up yet.', { code: 'GITHUB_NOT_CONFIGURED' });
  try { await inspect(repo, { requestedBy: admin.id, admin }); } catch (err) { audit({ admin, action: 'project.evidence_refresh', targetType: 'student_task', targetId: row.id, result: 'failure', reason: `Refresh failed: ${err.code ?? 'ERROR'}` }); throw asHttp(err); }
  audit({ admin, action: 'project.evidence_refresh', targetType: 'student_task', targetId: row.id, reason: `Evidence refreshed for ${repo.owner}/${repo.name}` });
  return githubEvidence(row.id);
}

export function addReviewNote(id, body, admin) {
  const row = loadRow(id); guard(row, admin);
  const note = typeof body?.note === 'string' ? body.note.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
  if (note.length < 3 || note.length > 2000) throw new HttpError(400, 'Please fix the highlighted fields', { code: 'VALIDATION', fields: { note: 'Write a note of 3 to 2000 characters' } });
  const sub = evalDb.latestSubmission(row.id);
  gh.addNote({ studentTaskId: row.id, submissionId: sub?.id, submissionVersion: sub?.version, admin, note });
  audit({ admin, action: 'project.note_add', targetType: 'student_task', targetId: row.id, reason: `Internal note added${sub ? ` (submission v${sub.version})` : ''}` });
  return { notes: gh.notesFor(row.id) };
}
export const reviewNotes = (id) => ({ notes: gh.notesFor(loadRow(id).id) });
export const evidenceFor = (id) => githubEvidence(loadRow(id).id);
