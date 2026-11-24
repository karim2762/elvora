import crypto from 'node:crypto';
import { db } from './index.js';

// Stage 09C — all GitHub-integration SQL. Every value is bound as a parameter. Token columns are returned ONLY by the *WithTokens
// reader, which only the github/ services call; nothing here is ever serialised to a client.
const newId = () => `GHR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const now = () => new Date().toISOString();
export const isConstraint = (err) => String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT');

const toAccount = (r) => r && ({ studentId: r.student_id, githubUserId: r.github_user_id, login: r.login, accountType: r.account_type, verificationStatus: r.verification_status, verifiedAt: r.verified_at, connectedAt: r.connected_at });
export const findAccount = (studentId) => toAccount(db.prepare('SELECT * FROM github_accounts WHERE student_id = ?').get(studentId));
export const findAccountWithTokens = (studentId) => { const r = db.prepare('SELECT * FROM github_accounts WHERE student_id = ?').get(studentId); return r && { ...toAccount(r), accessTokenEnc: r.access_token_enc, refreshTokenEnc: r.refresh_token_enc, tokenExpiresAt: r.token_expires_at }; };
export const accountByGithubId = (githubUserId) => toAccount(db.prepare('SELECT * FROM github_accounts WHERE github_user_id = ?').get(githubUserId));
export function saveAccount({ studentId, githubUserId, login, accountType, accessTokenEnc, refreshTokenEnc, tokenExpiresAt }) {
  const t = now();
  db.prepare(`INSERT INTO github_accounts (student_id, github_user_id, login, account_type, verification_status, access_token_enc, refresh_token_enc, token_expires_at, verified_at, connected_at, updated_at)
    VALUES (@studentId, @githubUserId, @login, @accountType, 'verified', @accessTokenEnc, @refreshTokenEnc, @tokenExpiresAt, @t, @t, @t)`)
    .run({ studentId, githubUserId, login, accountType, accessTokenEnc, refreshTokenEnc: refreshTokenEnc ?? null, tokenExpiresAt: tokenExpiresAt ?? null, t });
}
export const updateTokens = (studentId, { accessTokenEnc, refreshTokenEnc, tokenExpiresAt }) =>
  db.prepare('UPDATE github_accounts SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, updated_at = ? WHERE student_id = ?').run(accessTokenEnc, refreshTokenEnc ?? null, tokenExpiresAt ?? null, now(), studentId);
// Authorization revoked on GitHub: keep the identity row (history) but drop every token.
export const markRevoked = (githubUserId) => db.prepare("UPDATE github_accounts SET verification_status = 'revoked', access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL, updated_at = ? WHERE github_user_id = ?").run(now(), githubUserId).changes;
export const deleteAccount = (studentId) => db.prepare('DELETE FROM github_accounts WHERE student_id = ?').run(studentId).changes;

export const insertState = ({ stateHash, studentId, verifierEnc, expiresAt }) => db.transaction(() => {
  db.prepare('DELETE FROM github_oauth_states WHERE student_id = ? OR expires_at < ?').run(studentId, Date.now());
  db.prepare('INSERT INTO github_oauth_states (state_hash, student_id, verifier_enc, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(stateHash, studentId, verifierEnc, expiresAt, now());
})();
// Single use: the row is removed as it is read, so a replayed callback finds nothing.
export const consumeState = (stateHash) => db.transaction(() => {
  const r = db.prepare('SELECT * FROM github_oauth_states WHERE state_hash = ?').get(stateHash);
  if (r) db.prepare('DELETE FROM github_oauth_states WHERE state_hash = ?').run(stateHash);
  return r ? { studentId: r.student_id, verifierEnc: r.verifier_enc, expiresAt: r.expires_at } : null;
})();

const toRepo = (r) => r && ({
  id: r.id, studentTaskId: r.student_task_id, studentId: r.student_id, enrollmentId: r.enrollment_id, internshipId: r.internship_id, source: r.source,
  githubRepoId: r.github_repo_id, owner: r.owner, name: r.name, url: r.url, visibility: r.visibility, state: r.state, setupError: r.setup_error,
  ownershipStatus: r.ownership_status, ownershipVerifiedAt: r.ownership_verified_at, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, evidenceStaleAt: r.evidence_stale_at ?? null,
});
export const findRepoForTask = (studentTaskId) => toRepo(db.prepare("SELECT * FROM github_repositories WHERE student_task_id = ? AND state <> 'unlinked'").get(studentTaskId));
export const findRepoByName = (owner, name) => toRepo(db.prepare("SELECT * FROM github_repositories WHERE lower(owner) = lower(?) AND lower(name) = lower(?) AND state <> 'unlinked'").get(owner, name));
export const findRepoById = (id) => toRepo(db.prepare('SELECT * FROM github_repositories WHERE id = ?').get(id));
export const reposByGithubRepoId = (githubRepoId) => db.prepare("SELECT * FROM github_repositories WHERE github_repo_id = ? AND state <> 'unlinked'").all(githubRepoId).map(toRepo);
export function insertRepo(v) {
  const id = newId(); const t = now();
  db.prepare(`INSERT INTO github_repositories (id, student_task_id, student_id, enrollment_id, internship_id, source, github_repo_id, owner, name, url, visibility, state, setup_error, ownership_status, ownership_verified_at, created_by, created_at, updated_at)
    VALUES (@id, @studentTaskId, @studentId, @enrollmentId, @internshipId, @source, @githubRepoId, @owner, @name, @url, @visibility, @state, NULL, @ownershipStatus, @ownershipVerifiedAt, @createdBy, @t, @t)`)
    .run({ githubRepoId: null, visibility: null, ownershipStatus: 'unverified', ownershipVerifiedAt: null, createdBy: null, ...v, id, t });
  return findRepoById(id);
}
const COLS = { githubRepoId: 'github_repo_id', visibility: 'visibility', state: 'state', setupError: 'setup_error', ownershipStatus: 'ownership_status', ownershipVerifiedAt: 'ownership_verified_at', owner: 'owner', name: 'name', url: 'url', evidenceStaleAt: 'evidence_stale_at' };
export function updateRepo(id, patch) {
  const keys = Object.keys(patch).filter((k) => COLS[k]);
  if (!keys.length) return findRepoById(id);
  db.prepare(`UPDATE github_repositories SET ${keys.map((k) => `${COLS[k]} = @${k}`).join(', ')}, updated_at = @t WHERE id = @id`).run({ ...Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])), t: now(), id });
  return findRepoById(id);
}
export const unlinkRepo = (id) => db.prepare("UPDATE github_repositories SET state = 'unlinked', updated_at = ? WHERE id = ?").run(now(), id);
export const resetOwnershipForStudent = (studentId) => db.prepare("UPDATE github_repositories SET ownership_status = 'unverified', ownership_verified_at = NULL, updated_at = ? WHERE student_id = ? AND source <> 'organization'").run(now(), studentId).changes;

export function addSnapshot({ repositoryId, status, data, requestedBy }) {
  const at = now();
  db.prepare('INSERT INTO github_repository_snapshots (repository_id, status, data, requested_by, inspected_at) VALUES (?, ?, ?, ?, ?)').run(repositoryId, status, JSON.stringify(data ?? {}), requestedBy ?? null, at);
  return at;
}
const toSnap = (r) => r && ({ id: r.id, repositoryId: r.repository_id, status: r.status, data: (() => { try { return JSON.parse(r.data); } catch { return {}; } })(), inspectedAt: r.inspected_at });
export const latestSnapshot = (repositoryId) => toSnap(db.prepare('SELECT * FROM github_repository_snapshots WHERE repository_id = ? ORDER BY id DESC LIMIT 1').get(repositoryId));
export const latestOkSnapshot = (repositoryId) => toSnap(db.prepare("SELECT * FROM github_repository_snapshots WHERE repository_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(repositoryId));

export function recordWebhook({ deliveryId, event, action, repositoryFullName, outcome }) {
  try { db.prepare('INSERT INTO github_webhook_events (delivery_id, event, action, repository_full_name, outcome, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(deliveryId, event, action ?? null, repositoryFullName ?? null, outcome, now()); return true; }
  catch (err) { if (isConstraint(err)) return false; throw err; }
}
export const setWebhookOutcome = (deliveryId, outcome) => db.prepare('UPDATE github_webhook_events SET outcome = ? WHERE delivery_id = ?').run(outcome, deliveryId);

// Everything repository creation needs about one assignment, in one read. `student_id` is checked by the caller.
export function taskContext(studentTaskId) {
  const r = db.prepare(`SELECT st.id AS student_task_id, st.student_id, st.enrollment_id, st.task_id, st.status AS st_status, st.project_status, e.status AS enrollment_status, a.internship_id
    FROM student_tasks st JOIN enrollments e ON e.id = st.enrollment_id JOIN applications a ON a.id = e.application_id WHERE st.id = ?`).get(studentTaskId);
  return r && { studentTaskId: r.student_task_id, studentId: r.student_id, enrollmentId: r.enrollment_id, taskId: r.task_id, taskStatus: r.st_status, projectStatus: r.project_status ?? null, enrollmentStatus: r.enrollment_status, internshipId: r.internship_id };
}
// The repository URL the student typed on a submission (user-provided, NOT verified), newest version first.
export const submittedRepositoryUrl = (studentTaskId) => db.prepare('SELECT repository_url FROM task_submissions WHERE student_task_id = ? AND repository_url IS NOT NULL ORDER BY version DESC LIMIT 1').get(studentTaskId)?.repository_url ?? null;
export const countAccounts = () => db.prepare("SELECT COUNT(*) AS n FROM github_accounts WHERE verification_status = 'verified'").get().n;

// ---- Stage 09C Part 2A: what was confirmed when each version was submitted, and internal review notes ----
export function insertCheck({ submissionId, studentTaskId, repositoryId = null, repositoryUrl, state, reason = null, ownershipStatus = null, visibility = null }) {
  db.prepare(`INSERT INTO github_submission_checks (submission_id, student_task_id, repository_id, repository_url, state, reason, ownership_status, visibility, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(submissionId, studentTaskId, repositoryId, repositoryUrl, state, reason, ownershipStatus, visibility, now());
}
export const checksFor = (studentTaskId) => Object.fromEntries(db.prepare('SELECT * FROM github_submission_checks WHERE student_task_id = ?').all(studentTaskId)
  .map((r) => [r.submission_id, { state: r.state, reason: r.reason, ownershipStatus: r.ownership_status, visibility: r.visibility, repositoryUrl: r.repository_url, checkedAt: r.checked_at }]));
export function addNote({ studentTaskId, submissionId, submissionVersion, admin, note }) {
  db.prepare('INSERT INTO project_review_notes (student_task_id, submission_id, submission_version, admin_id, admin_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(studentTaskId, submissionId ?? null, submissionVersion ?? null, admin.id, String(admin.fullName ?? 'Administrator').slice(0, 80), note, now());
}
export const notesFor = (studentTaskId) => db.prepare('SELECT * FROM project_review_notes WHERE student_task_id = ? ORDER BY id').all(studentTaskId)
  .map((r) => ({ id: r.id, submissionVersion: r.submission_version, adminName: r.admin_name, note: r.note, createdAt: r.created_at }));

// Stage 09C Part 2B — webhook support. A failed delivery is forgotten so GitHub's redelivery is processed (handlers are idempotent).
export const forgetWebhook = (deliveryId) => db.prepare('DELETE FROM github_webhook_events WHERE delivery_id = ?').run(deliveryId);
export const markStale = (id) => updateRepo(id, { evidenceStaleAt: now() });
export const organizationRepos = () => db.prepare("SELECT * FROM github_repositories WHERE source = 'organization' AND state <> 'unlinked'").all().map(toRepo);
