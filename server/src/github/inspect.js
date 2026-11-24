import * as gh from '../db/github.js';
import { record as audit } from '../db/audit.js';
import { github, GitHubError } from './client.js';
import { withInstallation } from './app.js';
import { getUserToken } from './oauth.js';
import { isAppReady, isOauthReady } from './config.js';

// Stage 09C — read-only inspection through GitHub's REST API. Repository code is NEVER cloned, installed or executed here: the only
// things read are API answers (metadata, README text, file NAMES, commit metadata). Everything under `verifiedFromGitHub` came from
// GitHub; everything under `userProvided` is what the student typed. Counts below are evidence, not a quality judgement, and no test
// result is ever claimed (testsExecuted is always false).
export const canCallGitHub = () => isOauthReady() || isAppReady();
const enc = encodeURIComponent;
const NOTES = Object.freeze([
  'Commit and file counts are evidence of activity, not of project quality.',
  'Tests were not executed. Test files are only detected by name.',
  'ELVORA never runs repository code on its servers.',
]);
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|(^|\/)[^/]*(\.|_)(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]*\.py$/i;
const SOURCE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|java|kt|go|rs|rb|php|cs|c|cc|cpp|h|hpp|swift|sql|html|css|scss|vue|svelte|sh|ipynb|r|dart)$/i;

// Which credential reads this repository? Organisation repos: the App installation. Others: the student's own token (it respects their access
// to private repositories), else the installation (public data only), else anonymous (public data only).
export async function withReadAccess(repo, run) {
  if (repo.source === 'organization') return { via: 'installation', value: await withInstallation((t) => run(t)) };
  const userToken = await getUserToken(repo.studentId);
  if (userToken) { try { return { via: 'user', value: await run(userToken) }; } catch (err) { if (err.code !== 'GITHUB_AUTH_INVALID') throw err; } }
  if (isAppReady()) return { via: 'installation', value: await withInstallation((t) => run(t)) };
  return { via: 'anonymous', value: await run(undefined) };
}

export async function fetchRepositoryMeta(studentId, owner, name) {
  const run = (token) => github({ path: `/repos/${enc(owner)}/${enc(name)}`, token }).then((r) => r.data);
  const userToken = await getUserToken(studentId);
  if (userToken) { try { return await run(userToken); } catch (err) { if (!['GITHUB_AUTH_INVALID', 'GITHUB_NOT_FOUND'].includes(err.code)) throw err; } }
  if (isAppReady()) { try { return await withInstallation(run); } catch (err) { if (err.code !== 'GITHUB_NOT_FOUND') throw err; } }
  return run(undefined);
}

const firstLine = (m) => String(m ?? '').split('\n')[0].slice(0, 200);
export async function collect(repo, token, current) {
  const base = `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
  const get = (path) => github({ path: `${base}${path}`, token }).then((r) => r.data);
  const soft = async (fn, fallback) => { try { return await fn(); } catch (err) { if (['GITHUB_NOT_FOUND', 'GITHUB_CONFLICT', 'GITHUB_FORBIDDEN'].includes(err.code)) return fallback; throw err; } };
  const meta = current ?? await get('');
  const branch = meta.default_branch;
  const [readme, languages, branches, commits, tree] = await Promise.all([
    soft(() => get('/readme'), null),
    soft(() => get('/languages'), {}),
    soft(() => get('/branches?per_page=30'), []),
    soft(() => get('/commits?per_page=30'), []), // an empty repository answers 409
    branch ? soft(() => get(`/git/trees/${enc(branch)}?recursive=1`), null) : null,
  ]);
  const paths = (tree?.tree ?? []).filter((e) => e.type === 'blob').map((e) => String(e.path));
  const text = readme?.content && readme.encoding === 'base64' ? Buffer.from(readme.content, 'base64').toString('utf8') : '';
  const testFiles = paths.filter((p) => TEST_PATH.test(p));
  return {
    repository: {
      id: meta.id, fullName: meta.full_name, url: meta.html_url, owner: { login: meta.owner?.login, type: meta.owner?.type, id: meta.owner?.id },
      private: !!meta.private, visibility: meta.visibility ?? (meta.private ? 'private' : 'public'), defaultBranch: branch ?? null,
      createdAt: meta.created_at, updatedAt: meta.updated_at, pushedAt: meta.pushed_at, archived: !!meta.archived, sizeKb: meta.size ?? null,
    },
    readme: { present: !!readme, length: text.length, truncated: text.length > 20_000, content: text.slice(0, 20_000) },
    languages: languages ?? {},
    branches: { count: Array.isArray(branches) ? branches.length : 0, truncated: Array.isArray(branches) && branches.length >= 30, names: (branches ?? []).slice(0, 30).map((b) => String(b.name)) },
    commits: {
      sampled: Array.isArray(commits) ? commits.length : 0, countIsExact: false, // only the newest 30 are read
      latest: (Array.isArray(commits) ? commits : []).map((c) => ({ sha: String(c.sha ?? '').slice(0, 7), message: firstLine(c.commit?.message), authoredAt: c.commit?.author?.date ?? null, authorLogin: c.author?.login ?? null })),
    },
    files: {
      total: paths.length, truncated: !!tree?.truncated, sourceFiles: paths.filter((p) => SOURCE_EXT.test(p) && !TEST_PATH.test(p)).length,
      testFiles: testFiles.length, hasTestFiles: testFiles.length > 0, topLevel: [...new Set(paths.map((p) => p.split('/')[0]))].slice(0, 40), paths: paths.slice(0, 300),
    },
  };
}

// Inspect (or refresh the evidence of) one linked repository and store a snapshot. Never throws for "repository not reachable": that is
// recorded as a snapshot and reflected in the repository state. Rate limits and outages are recorded and re-thrown for a clear message.
export async function inspect(repo, { requestedBy = null, admin = null, studentActor = false } = {}) {
  if (!canCallGitHub()) throw new GitHubError('GITHUB_NOT_CONFIGURED', 'GitHub integration is not set up yet.');
  const userProvided = (() => { const u = gh.submittedRepositoryUrl(repo.studentTaskId); return { submittedRepositoryUrl: u, matchesLinkedRepository: u ? u.toLowerCase().replace(/\.git$/, '') === repo.url.toLowerCase() : null }; })();
  let status = 'ok'; let data; let via = null; let fresh = repo;
  try {
    const r = await withReadAccess(repo, (token) => collect(repo, token));
    via = r.via; data = r.value;
  } catch (err) {
    if (err.code === 'GITHUB_NOT_FOUND') status = 'not_found';
    else if (err.code === 'GITHUB_FORBIDDEN') status = 'access_denied';
    else if (err.code === 'GITHUB_RATE_LIMITED') status = 'rate_limited';
    else status = 'error';
    gh.addSnapshot({ repositoryId: repo.id, status, data: { error: err.code ?? 'GITHUB_ERROR', retryAt: err.retryAt ?? null, userProvided }, requestedBy });
    if (status === 'not_found' && repo.state !== 'creating') fresh = gh.updateRepo(repo.id, { state: 'unavailable' }); // deleted, renamed, or access lost: never silently kept "active"
    if (status === 'rate_limited' || status === 'error') throw err;
  }
  if (status === 'ok') {
    const m = data.repository;
    fresh = gh.updateRepo(repo.id, { githubRepoId: m.id, visibility: m.visibility, state: 'active', setupError: null });
    gh.addSnapshot({ repositoryId: repo.id, status, data: { verifiedFromGitHub: { ...data, access: { via } }, userProvided, testsExecuted: false, notes: NOTES }, requestedBy });
  }
  audit({ admin, ...(studentActor ? { actorName: 'Student (GitHub)' } : {}), action: 'github.inspect', targetType: 'student_task', targetId: repo.studentTaskId, result: status === 'ok' ? 'success' : 'failure', reason: `Inspection ${status}` });
  return { status, repository: fresh };
}

export function snapshotView(snap) {
  if (!snap) return null;
  return { status: snap.status, inspectedAt: snap.inspectedAt, ...(snap.status === 'ok' ? snap.data : { error: snap.data?.error ?? null, retryAt: snap.data?.retryAt ?? null, userProvided: snap.data?.userProvided ?? null }) };
}
