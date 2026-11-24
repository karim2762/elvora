import crypto from 'node:crypto';
import { config } from '../config/index.js';
import * as gh from '../db/github.js';
import { invalidateInstallationToken, resetAppCache, knownInstallationId } from './app.js';
import { notifyGithub } from './notify.js';

// Stage 09C — GitHub webhooks. The signature (HMAC-SHA256 of the RAW body, header X-Hub-Signature-256) is checked BEFORE the body is parsed or
// anything is stored. Events only keep ELVORA's records truthful (revoked authorizations, deleted/renamed repositories); they never
// approve, score or submit anything. Each delivery id is processed once.
export function verifySignature(rawBody, header) {
  const secret = config.github.webhookSecret;
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'));
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const today = () => new Date().toISOString().slice(0, 10);
// Tells the student (once per repository per day) that ELVORA can no longer see or confirm the repository. Wording is about the repository only.
const tell = (r, detail) => notifyGithub('github_verification_failed', { studentId: r.studentId, studentTaskId: r.studentTaskId, detail, key: `${r.id}:${crypto.createHash('sha1').update(detail).digest('hex').slice(0, 8)}:${today()}` });

// Never trust a payload: it must name an installation ELVORA knows (when known) and, for repository events, a repository ELVORA has linked by GitHub's numeric id.
function installationOk(payload) {
  const known = knownInstallationId(); const claimed = payload?.installation?.id;
  return !(known && claimed && Number(claimed) !== Number(known));
}

function repositoryEvent(action, payload) {
  const repoPayload = payload.repository;
  if (!isObj(repoPayload) || !Number.isInteger(repoPayload.id)) return 'ignored';
  const rows = gh.reposByGithubRepoId(repoPayload.id);
  if (!rows.length) return 'no_linked_repository';
  if (['deleted', 'archived'].includes(action)) {
    for (const r of rows) { gh.updateRepo(r.id, { state: 'unavailable' }); tell(r, action === 'deleted' ? 'The repository was deleted on GitHub, so it can no longer be verified. Link another repository.' : 'The repository was archived on GitHub, so work can no longer be pushed to it.'); }
    return `unavailable:${rows.length}`;
  }
  if (['privatized', 'publicized'].includes(action)) { // visibility changed: record it and invalidate evidence; do not guess at access
    for (const r of rows) { gh.updateRepo(r.id, { visibility: action === 'privatized' ? 'private' : 'public' }); gh.markStale(r.id); }
    return `visibility_${action}:${rows.length}`;
  }
  if (['renamed', 'transferred', 'unarchived'].includes(action)) {
    for (const r of rows) {
      gh.updateRepo(r.id, { owner: repoPayload.owner?.login ?? r.owner, name: repoPayload.name ?? r.name, url: repoPayload.html_url ?? r.url, state: action === 'unarchived' ? 'active' : r.state, ...(action === 'transferred' ? { ownershipStatus: 'unverified', ownershipVerifiedAt: null } : {}) });
      gh.markStale(r.id);
      if (action === 'transferred') tell(r, 'The repository was transferred to another GitHub owner, so ownership needs to be verified again.');
    }
    return `updated:${rows.length}`;
  }
  return 'ignored';
}

export function processEvent({ deliveryId, event, payload }) {
  if (!isObj(payload)) return { status: 400, outcome: 'malformed_payload' };
  const action = typeof payload.action === 'string' ? payload.action.slice(0, 40) : null;
  const fullName = typeof payload.repository?.full_name === 'string' ? payload.repository.full_name.slice(0, 200) : null;
  if (!/^[0-9a-f-]{8,64}$/i.test(String(deliveryId))) return { status: 400, outcome: 'bad_delivery_id' };
  if (!gh.recordWebhook({ deliveryId, event: String(event).slice(0, 60), action, repositoryFullName: fullName, outcome: 'received' })) return { status: 200, outcome: 'duplicate' };
  let outcome = 'ignored';
  try {
    if (!installationOk(payload)) outcome = 'rejected:installation_mismatch';
    else if (event === 'github_app_authorization' && action === 'revoked' && Number.isInteger(payload.sender?.id)) outcome = `revoked:${gh.markRevoked(payload.sender.id)}`;
    else if (event === 'installation' && ['deleted', 'suspend', 'unsuspend', 'new_permissions_accepted'].includes(action)) {
      resetAppCache();
      // ELVORA-created repositories depend on this installation: their evidence is outdated until GitHub is asked again.
      for (const r of gh.organizationRepos()) { gh.markStale(r.id); if (['deleted', 'suspend'].includes(action)) tell(r, 'ELVORA lost access to the GitHub organisation, so this repository cannot be checked right now.'); }
      outcome = `installation_${action}`;
    } else if (event === 'installation_repositories') {
      invalidateInstallationToken(); let n = 0;
      for (const removed of Array.isArray(payload.repositories_removed) ? payload.repositories_removed : []) {
        if (!Number.isInteger(removed?.id)) continue;
        for (const r of gh.reposByGithubRepoId(removed.id)) { gh.updateRepo(r.id, { state: 'unavailable' }); tell(r, 'ELVORA no longer has access to this repository, so it cannot be verified.'); n += 1; }
      }
      outcome = `installation_repositories:${n}`;
    } else if (event === 'repository') outcome = repositoryEvent(action, payload);
    else if (event === 'push') { // cheap invalidation only: no GitHub call, no inspection. The default-branch push marks evidence outdated; the next refresh re-inspects.
      const rows = Number.isInteger(payload.repository?.id) ? gh.reposByGithubRepoId(payload.repository.id) : [];
      const def = typeof payload.repository?.default_branch === 'string' ? payload.repository.default_branch : null;
      if (!rows.length) outcome = 'no_linked_repository';
      else if (def && payload.ref !== `refs/heads/${def}`) outcome = 'push_other_branch';
      else { for (const r of rows) gh.markStale(r.id); outcome = `evidence_invalidated:${rows.length}`; }
    }
  } catch { outcome = 'error'; }
  if (outcome === 'error') { gh.forgetWebhook(deliveryId); return { status: 500, outcome }; } // forgotten so GitHub's redelivery is processed
  gh.setWebhookOutcome(deliveryId, outcome);
  return { status: 200, outcome };
}
