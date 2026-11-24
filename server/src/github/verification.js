import * as gh from '../db/github.js';

// Stage 09C Part 2A — the ONE place that turns repository facts into a student-readable verification state.
// Verification is about the REPOSITORY (it exists, it is the student's, ELVORA can read it). It is never an academic result:
// a verified repository is not an approved project, and nothing here reads commit or file counts.
export const VERIFICATION_STATES = ['not_linked', 'pending_verification', 'verified', 'verification_failed', 'access_revoked', 'repository_unavailable', 'evidence_outdated'];
const DAY = 86_400_000;
export const EVIDENCE_MAX_AGE_DAYS = 7;
export const ACADEMIC_NOTE = 'Repository verification only confirms the repository. It does not mean your project is approved: an ELVORA reviewer evaluates your work separately.';

const TEXT = {
  not_linked: ['Not linked', 'slate', 'No GitHub repository is linked to this task yet. Create one or link an existing repository.'],
  pending_verification: ['Pending verification', 'amber', 'We have not been able to confirm this repository yet. This can happen when GitHub is busy or not connected. You can check again later.'],
  verified: ['Verified', 'teal', 'This repository exists, belongs to you and can be reviewed.'],
  verification_failed: ['Verification failed', 'red', 'This repository does not belong to your connected GitHub account, so we could not confirm it is yours. Link a repository you own.'],
  access_revoked: ['Access revoked', 'red', 'Your GitHub connection or access to this repository was removed. Reconnect your GitHub account to continue.'],
  repository_unavailable: ['Repository unavailable', 'red', 'We could not find this repository. It may have been deleted, renamed or made private.'],
  evidence_outdated: ['Evidence outdated', 'amber', 'The repository changed since it was last checked. Refresh the repository evidence so your reviewer sees your latest work.'],
};
const view = (state, extra = {}) => ({ state, label: TEXT[state][0], tone: TEXT[state][1], message: TEXT[state][2], academicNote: ACADEMIC_NOTE, ...extra });

export function verificationFor(repo, snap = undefined, account = undefined) {
  if (!repo) return view('not_linked');
  const s = snap === undefined ? gh.latestSnapshot(repo.id) : snap;
  const acc = account === undefined ? gh.findAccount(repo.studentId) : account;
  if (repo.state === 'unavailable' || s?.status === 'not_found') return view('repository_unavailable');
  if (s?.status === 'access_denied' || (repo.source !== 'organization' && acc?.verificationStatus === 'revoked')) return view('access_revoked');
  if (repo.ownershipStatus === 'not_owner') return view('verification_failed');
  if (repo.ownershipStatus === 'verified') {
    const ok = s?.status === 'ok' ? s : gh.latestOkSnapshot(repo.id);
    if (ok) {
      const age = Date.now() - Date.parse(ok.inspectedAt); const pushed = Date.parse(ok.data?.verifiedFromGitHub?.repository?.pushedAt ?? '');
      if (age > EVIDENCE_MAX_AGE_DAYS * DAY) return view('evidence_outdated');
      if (repo.evidenceStaleAt && Date.parse(repo.evidenceStaleAt) > Date.parse(ok.inspectedAt)) return view('evidence_outdated'); // a push/visibility/installation event since the last inspection
      if (Number.isFinite(pushed) && pushed > Date.parse(ok.inspectedAt)) return view('evidence_outdated');
    }
    return view('verified');
  }
  return view('pending_verification');
}
