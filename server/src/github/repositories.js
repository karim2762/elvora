import { notifyGithub } from './notify.js';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import { HttpError, notFound, badRequest } from '../utils/errors.js';
import { parseGitHubRepoUrl } from '../utils/github.js';
import { STUDENT_TASK_ID_RE } from '../tasks/constants.js';
import { requiresRepository } from '../tasks/githubSubmission.js';
import { record as audit } from '../db/audit.js';
import * as gh from '../db/github.js';
import * as taskDb from '../db/tasks.js';
import { github, GitHubError } from './client.js';
import { withInstallation } from './app.js';
import { isAppReady } from './config.js';
import { repositoryName } from './naming.js';
import { buildStarterFiles } from './starter.js';
import { fetchRepositoryMeta, canCallGitHub, withReadAccess } from './inspect.js';
import { asHttp } from './errors.js';
import { verificationFor } from './verification.js';

// Stage 09C — repository creation (ELVORA organisation), linking (student-owned / manual URL) and ownership verification.
// Nothing here approves, scores or submits a project.
const enc = encodeURIComponent;
const conflict = (message, code) => new HttpError(409, message, { code });
const inFlight = new Set(); // single-process guard against two simultaneous creates of the same task's repository
const asStudentActor = { actorName: 'Student (GitHub)' };
const OPEN_ENROLLMENT = ['Awaiting Start', 'Active'];
const CAN_WORK = ['Assigned', 'In Progress', 'Changes Requested'];

// Loads the assignment and checks WHO is asking. A student only ever reaches their own task (a foreign ID is the same 404 as a missing one).
function load(studentTaskId, student) {
  const ctx = STUDENT_TASK_ID_RE.test(String(studentTaskId)) ? gh.taskContext(studentTaskId) : null;
  if (!ctx || (student && ctx.studentId !== student.id)) throw notFound('Task not found', 'TASK_NOT_FOUND');
  return { ctx, task: taskDb.findTask(ctx.taskId) };
}
export function eligibility({ ctx, task }) {
  if (!requiresRepository(task)) return { eligible: false, reason: 'This task does not use a GitHub repository.' };
  if (!OPEN_ENROLLMENT.includes(ctx.enrollmentStatus)) return { eligible: false, reason: 'This internship is not active, so a repository cannot be created.' };
  // A rejected project is stored as 'Changes Requested' + project_status 'Rejected' (see services/projectEvaluation.js); it is final, so its repository must not change.
  if (ctx.projectStatus === 'Rejected') return { eligible: false, reason: 'This project was rejected, so its repository can no longer be changed.' };
  if (!CAN_WORK.includes(ctx.taskStatus)) return { eligible: false, reason: 'This task is already submitted or finished.' };
  return { eligible: true };
}

export function repositoryView(repo, { admin = false } = {}) {
  if (!repo) return null;
  const snap = gh.latestSnapshot(repo.id);
  return {
    id: repo.id, source: repo.source, owner: repo.owner, name: repo.name, url: repo.url, visibility: repo.visibility, state: repo.state,
    ...(repo.state === 'failed' ? { setupMessage: 'Repository setup did not finish. Try again; nothing is duplicated.', ...(admin ? { setupError: repo.setupError } : {}) } : {}),
    ownership: { status: repo.ownershipStatus, verifiedAt: repo.ownershipVerifiedAt, verifiedByGitHub: repo.ownershipStatus === 'verified' },
    createdAt: repo.createdAt, updatedAt: repo.updatedAt,
    lastInspection: snap ? { status: snap.status, inspectedAt: snap.inspectedAt } : null,
    verification: verificationFor(repo, snap),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Create in the ELVORA organisation (idempotent and retryable)
// ---------------------------------------------------------------------------------------------------------------------------------
export async function createOrganizationRepository(studentTaskId, { student = null, admin = null } = {}) {
  const loaded = load(studentTaskId, admin ? null : student);
  const { ctx, task } = loaded;
  const ok = eligibility(loaded);
  if (!ok.eligible) throw conflict(ok.reason, 'REPOSITORY_NOT_ELIGIBLE');
  if (!isAppReady()) throw new HttpError(503, 'Automatic repository creation is not set up yet. You can connect an existing repository instead.', { code: 'GITHUB_NOT_CONFIGURED' });
  const account = gh.findAccount(ctx.studentId);
  if (!account || account.verificationStatus !== 'verified') throw conflict('Connect your GitHub account first, so you can be given access to the new repository.', 'GITHUB_NOT_CONNECTED');

  let repo = gh.findRepoForTask(ctx.studentTaskId);
  if (repo && repo.source !== 'organization') throw conflict('A repository is already linked to this task. Unlink it first if you want ELVORA to create one.', 'REPOSITORY_ALREADY_LINKED');
  if (repo?.state === 'active') return { repository: repo, created: false };
  if (repo?.state === 'unavailable') throw conflict('This repository is no longer available on GitHub. Please contact ELVORA support.', 'REPOSITORY_UNAVAILABLE');
  if (inFlight.has(ctx.studentTaskId)) throw conflict('This repository is being created right now. Please wait a moment.', 'REPOSITORY_IN_PROGRESS');
  inFlight.add(ctx.studentTaskId);
  try {
    if (!repo) {
      const base = { internshipId: ctx.internshipId, enrollmentId: ctx.enrollmentId, title: task.title, studentTaskId: ctx.studentTaskId };
      let name = repositoryName(base);
      if (gh.findRepoByName(config.github.organization, name)) name = repositoryName({ ...base, disambiguate: true });
      try {
        repo = gh.insertRepo({ studentTaskId: ctx.studentTaskId, studentId: ctx.studentId, enrollmentId: ctx.enrollmentId, internshipId: ctx.internshipId, source: 'organization', owner: config.github.organization, name, url: `https://github.com/${config.github.organization}/${name}`, state: 'creating', createdBy: admin?.id ?? student?.id ?? null });
      } catch (err) { if (!gh.isConstraint(err)) throw err; repo = gh.findRepoForTask(ctx.studentTaskId); if (!repo) throw conflict('A repository with that name already exists. Please contact ELVORA support.', 'REPOSITORY_EXISTS'); }
    }
    try { repo = await runSetup(repo, { task, login: account.login }); }
    catch (err) {
      gh.updateRepo(repo.id, { state: 'failed', setupError: String(err.code ?? 'ERROR').slice(0, 60) });
      audit({ admin, ...(admin ? {} : asStudentActor), action: 'github.repository_create', targetType: 'student_task', targetId: ctx.studentTaskId, result: 'failure', reason: `Repository setup failed: ${err.code ?? 'ERROR'}` });
      notifyGithub('github_repo_failed', { studentId: ctx.studentId, studentTaskId: ctx.studentTaskId });
      throw asHttp(err);
    }
    notifyGithub('github_repo_created', { studentId: ctx.studentId, studentTaskId: ctx.studentTaskId, key: repo.id });
    audit({ admin, ...(admin ? {} : asStudentActor), action: 'github.repository_create', targetType: 'student_task', targetId: ctx.studentTaskId, reason: `Created ${repo.owner}/${repo.name}` });
    return { repository: repo, created: true };
  } finally { inFlight.delete(ctx.studentTaskId); }
}

// Every step is safe to repeat: an existing repository is adopted only if it carries OUR marker for THIS task.
async function runSetup(repo, { task, login }) {
  const org = config.github.organization; const marker = `[elvora:${repo.studentTaskId}]`;
  return withInstallation(async (token) => {
    let meta;
    try {
      meta = (await github({ method: 'POST', path: `/orgs/${enc(org)}/repos`, token, body: { name: repo.name, description: `ELVORA internship assignment ${marker}`, private: config.github.visibility !== 'public', visibility: config.github.visibility, auto_init: false, has_wiki: false, has_projects: false } })).data;
    } catch (err) {
      if (err.code !== 'GITHUB_CONFLICT') throw err;
      const existing = await github({ path: `/repos/${enc(org)}/${enc(repo.name)}`, token }).then((r) => r.data).catch(() => null);
      if (!existing || !String(existing.description ?? '').includes(marker)) throw Object.assign(new GitHubError('GITHUB_CONFLICT', 'exists'), { code: 'REPOSITORY_EXISTS' });
      meta = existing; // our own earlier attempt: continue where it stopped
    }
    const updated = gh.updateRepo(repo.id, { githubRepoId: meta.id, url: meta.html_url, owner: meta.owner?.login ?? org, name: meta.name ?? repo.name, visibility: meta.visibility ?? (meta.private ? 'private' : 'public') });
    for (const f of buildStarterFiles({ task, repoName: updated.name })) {
      try { await github({ method: 'PUT', path: `/repos/${enc(updated.owner)}/${enc(updated.name)}/contents/${f.path.split('/').map(enc).join('/')}`, token, body: { message: `Add ${f.path} (ELVORA starter)`, content: Buffer.from(f.content).toString('base64') } }); }
      catch (err) { if (err.code !== 'GITHUB_CONFLICT') throw err; } // 422: the file is already there from an earlier attempt
    }
    await github({ method: 'PUT', path: `/repos/${enc(updated.owner)}/${enc(updated.name)}/collaborators/${enc(login)}`, token, body: { permission: config.github.defaultPermission } });
    if (config.github.reviewTeam) await github({ method: 'PUT', path: `/orgs/${enc(org)}/teams/${enc(config.github.reviewTeam)}/repos/${enc(updated.owner)}/${enc(updated.name)}`, token, body: { permission: 'pull' } });
    return gh.updateRepo(repo.id, { state: 'active', setupError: null });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Link an existing repository (student-owned or typed URL)
// ---------------------------------------------------------------------------------------------------------------------------------
export async function linkRepository(student, studentTaskId, input, { offline = false } = {}) {
  const loaded = load(studentTaskId, student); const { ctx } = loaded;
  const ok = eligibility(loaded);
  if (!ok.eligible) throw conflict(ok.reason, 'REPOSITORY_NOT_ELIGIBLE');
  const parsed = parseGitHubRepoUrl(input?.repositoryUrl);
  if (parsed.error || !parsed.value) throw badRequest('Please fix the highlighted fields', { repositoryUrl: parsed.error ?? 'Enter your GitHub repository link' });
  const { owner, repo: name } = parsed.value;
  if (config.github.organization && owner.toLowerCase() === config.github.organization.toLowerCase()) throw new HttpError(403, 'Repositories in the ELVORA organization are created by ELVORA. Use “Create repository” instead.', { code: 'ORG_REPOSITORY_NOT_LINKABLE' });
  const current = gh.findRepoForTask(ctx.studentTaskId);
  if (current?.source === 'organization' && current.state !== 'unavailable') throw conflict('ELVORA already created a repository for this task.', 'REPOSITORY_ALREADY_LINKED');
  const sameName = gh.findRepoByName(owner, name);
  if (sameName && sameName.studentTaskId !== ctx.studentTaskId) throw conflict('This repository is already linked to another project.', 'DUPLICATE_REPOSITORY');

  let meta = null; let source = 'manual_url'; let ownership = {};
  const account = gh.findAccount(ctx.studentId);
  if (canCallGitHub() && !offline) {
    try { meta = await fetchRepositoryMeta(ctx.studentId, owner, name); }
    catch (err) {
      if (err.code === 'GITHUB_NOT_FOUND') throw new HttpError(404, 'GitHub could not find this repository, or it is private. Check the link, make it public, or connect your GitHub account.', { code: 'REPOSITORY_NOT_FOUND', fields: { repositoryUrl: 'Repository not found or not accessible' } });
      throw asHttp(err);
    }
    if (meta.archived) throw conflict('This repository is archived on GitHub, so work cannot be pushed to it.', 'REPOSITORY_ARCHIVED');
    if (account?.verificationStatus === 'verified' && meta.owner?.id === account.githubUserId && meta.owner?.type === 'User') { source = 'student_owned'; ownership = { ownershipStatus: 'verified', ownershipVerifiedAt: new Date().toISOString() }; }
  }
  const values = { studentTaskId: ctx.studentTaskId, studentId: ctx.studentId, enrollmentId: ctx.enrollmentId, internshipId: ctx.internshipId, source,
    githubRepoId: meta?.id ?? null, owner: meta?.owner?.login ?? owner, name: meta?.name ?? name, url: meta?.html_url ?? parsed.value.url, visibility: meta ? (meta.visibility ?? (meta.private ? 'private' : 'public')) : null, state: 'active', createdBy: student.id, ...ownership };
  let saved;
  try {
    saved = db.transaction(() => {
      if (current) { gh.unlinkRepo(current.id); audit({ ...asStudentActor, action: 'github.repository_unlink', targetType: 'student_task', targetId: ctx.studentTaskId, reason: `Replaced ${current.owner}/${current.name}` }); }
      const row = gh.insertRepo(values);
      audit({ ...asStudentActor, action: 'github.repository_link', targetType: 'student_task', targetId: ctx.studentTaskId, reason: `Linked ${row.owner}/${row.name} (${source}${meta ? '' : ', not checked with GitHub'})` });
      return row;
    })();
  } catch (err) { if (gh.isConstraint(err)) throw conflict('This repository is already linked to another project.', 'DUPLICATE_REPOSITORY'); throw err; }
  notifyGithub('github_repo_linked', { studentId: ctx.studentId, studentTaskId: ctx.studentTaskId, repo: `${saved.owner}/${saved.name}`, key: saved.id });
  return { repository: saved, checkedWithGitHub: !!meta };
}

export function unlinkRepository(student, studentTaskId) {
  const { ctx } = load(studentTaskId, student);
  const repo = gh.findRepoForTask(ctx.studentTaskId);
  if (!repo) throw notFound('No repository is linked to this task.', 'REPOSITORY_NOT_FOUND');
  if (repo.source === 'organization') throw conflict('The repository created by ELVORA cannot be unlinked.', 'REPOSITORY_NOT_UNLINKABLE');
  if (ctx.projectStatus === 'Rejected' || !CAN_WORK.includes(ctx.taskStatus)) throw conflict(ctx.projectStatus === 'Rejected' ? 'This project was rejected, so its repository can no longer be changed.' : 'This task is already submitted or finished.', 'REPOSITORY_NOT_ELIGIBLE');
  db.transaction(() => { gh.unlinkRepo(repo.id); audit({ ...asStudentActor, action: 'github.repository_unlink', targetType: 'student_task', targetId: ctx.studentTaskId, reason: `Unlinked ${repo.owner}/${repo.name}` }); })();
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Ownership verification: only GitHub's own answers count (repository owner id vs the verified account id, or the account's permission).
// ---------------------------------------------------------------------------------------------------------------------------------
export async function verifyOwnership(student, studentTaskId) {
  const { ctx } = load(studentTaskId, student);
  const repo = gh.findRepoForTask(ctx.studentTaskId);
  if (!repo) throw notFound('No repository is linked to this task.', 'REPOSITORY_NOT_FOUND');
  if (!canCallGitHub()) throw new HttpError(503, 'GitHub verification is not set up yet.', { code: 'GITHUB_NOT_CONFIGURED' });
  const account = gh.findAccount(student.id);
  if (!account || account.verificationStatus !== 'verified') throw conflict('Connect your GitHub account first.', 'GITHUB_NOT_CONNECTED');
  let status; let detail;
  try {
    if (repo.source === 'organization') {
      const r = await withInstallation((token) => github({ path: `/repos/${enc(repo.owner)}/${enc(repo.name)}/collaborators/${enc(account.login)}/permission`, token }));
      const level = String(r.data?.permission ?? 'none');
      if (['admin', 'write'].includes(level) || ['maintain', 'push'].includes(String(r.data?.role_name))) { status = 'verified'; detail = 'Your GitHub account has write access to this repository.'; }
      else { status = 'unverified'; detail = 'Your GitHub account does not have write access yet. Accept the invitation GitHub sent you, then check again.'; }
    } else {
      const { value: meta } = await withReadAccess(repo, (token) => github({ path: `/repos/${enc(repo.owner)}/${enc(repo.name)}`, token }).then((r) => r.data));
      if (meta.owner?.id === account.githubUserId && meta.owner?.type === 'User') { status = 'verified'; detail = 'This repository belongs to your verified GitHub account.'; }
      else { status = 'not_owner'; detail = 'This repository does not belong to your connected GitHub account, so ownership cannot be confirmed.'; }
      gh.updateRepo(repo.id, { githubRepoId: meta.id, visibility: meta.visibility ?? (meta.private ? 'private' : 'public') });
    }
  } catch (err) {
    if (err.code === 'GITHUB_NOT_FOUND') { gh.updateRepo(repo.id, { state: 'unavailable' }); throw new HttpError(404, 'This repository was not found on GitHub. It may have been deleted, renamed or made private.', { code: 'REPOSITORY_NOT_FOUND' }); }
    throw asHttp(err);
  }
  const updated = gh.updateRepo(repo.id, { ownershipStatus: status, ownershipVerifiedAt: status === 'verified' ? new Date().toISOString() : null, state: repo.state === 'unavailable' ? 'active' : repo.state });
  if (status === 'not_owner') notifyGithub('github_verification_failed', { studentId: ctx.studentId, studentTaskId: ctx.studentTaskId, key: `${repo.id}:${new Date().toISOString().slice(0, 10)}` });
  else if (status === 'unverified') notifyGithub('github_verification_pending', { studentId: ctx.studentId, studentTaskId: ctx.studentTaskId, detail: detail, key: `${repo.id}:${new Date().toISOString().slice(0, 10)}` });
  audit({ ...asStudentActor, action: 'github.ownership_verify', targetType: 'student_task', targetId: ctx.studentTaskId, reason: `Ownership ${status}` });
  return { repository: updated, ownership: { status, detail } };
}

export function repositoryForTask(studentTaskId, student) { const { ctx } = load(studentTaskId, student); return gh.findRepoForTask(ctx.studentTaskId); }
export const eligibilityFor = (studentTaskId, student) => eligibility(load(studentTaskId, student));
