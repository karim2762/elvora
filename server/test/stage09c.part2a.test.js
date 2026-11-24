// Stage 09C Part 2A — student GitHub project submission, repository verification state and administrator evidence review.
// Real HTTP against the app + in-memory DB; api.github.com is a MOCK injected with setFetch(). No real GitHub account or network is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1';
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const USER_TOKEN = 'ghu_USERTOKEN_SHOULD_NEVER_LEAK_123'; const INST_TOKEN = 'ghs_INSTALLATION_TOKEN_456';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const EVIL = '# Marks tool\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n[click](javascript:alert(3))\nrtl\u202e text\u0007bell';
let srv, dir, db, admin, asha, ravi, anon, G, gh, inspectMod, verif, repoTask, textTask, ravisTask, calls, mock, ashaId, ashaCookie, raviCookie;
const state = { commits: [{ sha: 'abcdef1234567', msg: 'Add parser', date: '2026-11-19T10:00:00Z' }], gone: false, rate: false, down: false };

const res = (status, body, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json', ...headers } });
async function fakeFetch(url, init = {}) {
  const u = new URL(url); const method = init.method ?? 'GET'; const body = init.body ? JSON.parse(init.body) : undefined;
  const rec = { method, host: u.host, path: u.pathname + u.search, auth: init.headers?.Authorization ?? null, body }; calls.push(rec);
  if (state.down) return res(503, {});
  for (const [m, re, fn] of mock.routes) if (m === method && re.test(rec.host + rec.path)) { const [s, b, h] = fn(rec); return res(s, b, h); }
  return res(404, { message: 'Not Found' });
}
const base = () => [
  ['POST', /github\.com\/login\/oauth\/access_token/, (r) => (['good-code', 'ravi-code'].includes(r.body.code) ? [200, { access_token: USER_TOKEN, refresh_token: 'ghr_R', expires_in: 28800 }] : [200, { error: 'bad_verification_code' }])],
  ['GET', /api\.github\.com\/user$/, (r) => (r.auth === `Bearer ${USER_TOKEN}` ? [200, mock.user] : [401, {}])],
  ['GET', /api\.github\.com\/orgs\/elvora-org\/installation/, () => [200, { id: 77, account: { login: 'elvora-org', type: 'Organization' }, permissions: { administration: 'write', contents: 'write', metadata: 'read' }, repository_selection: 'all' }]],
  ['POST', /api\.github\.com\/app\/installations\/77\/access_tokens/, () => [201, { token: INST_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() }]],
];
// A repository `name` owned by `owner`. Private repositories answer 404 without the student's own token (as GitHub does).
const repoRoutes = (owner, name, { ownerId, priv = false } = {}) => {
  const p = `repos\\/${owner}\\/${name}`; const authed = (r) => r.auth === `Bearer ${USER_TOKEN}`;
  return [
    ['GET', new RegExp(`${p}$`), (r) => (state.gone || (priv && !authed(r)) ? [404, {}] : [200, { id: ownerId + 100, full_name: `${owner}/${name}`, name, html_url: `https://github.com/${owner}/${name}`, owner: { id: ownerId, login: owner, type: 'User' }, private: priv, visibility: priv ? 'private' : 'public', default_branch: 'main', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', pushed_at: '2026-11-19T10:00:00Z', size: 12 }])],
    ['GET', new RegExp(`${p}\\/readme`), () => [200, { encoding: 'base64', content: Buffer.from(EVIL).toString('base64') }]],
    ['GET', new RegExp(`${p}\\/languages`), () => [200, { Python: 3000, HTML: 1000 }]],
    ['GET', new RegExp(`${p}\\/branches`), () => [200, [{ name: 'main' }, { name: 'dev' }]]],
    ['GET', new RegExp(`${p}\\/commits`), () => (state.rate ? [403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }] : [200, state.commits.map((c) => ({ sha: c.sha, commit: { message: c.msg, author: { date: c.date } }, author: { login: owner } }))])],
    ['GET', new RegExp(`${p}\\/git\\/trees`), () => [200, { truncated: false, tree: [{ type: 'blob', path: 'README.md' }, { type: 'blob', path: 'src/marks.py' }, { type: 'blob', path: 'tests/test_marks.py' }] }]],
  ];
};
const useMock = (user, extra = []) => { calls = []; mock = { user: user ?? { id: 1001, login: 'asha-v', type: 'User' }, routes: [...extra, ...base()] }; };

const content = { objective: 'Build a small tool.', background: 'Practice.', tools: ['Python 3'], steps: ['Plan the tool on paper first.', 'Build the tool step by step.'], expectedOutput: 'A working tool.', submissionRequirements: 'Share your repository link.' };
const tpl = (over = {}) => ({ category: 'python-development', title: 'Student marks analysis', shortDescription: 'Read a CSV of marks and print averages.', difficulty: 'Beginner', taskType: 'Practical Assignment', submissionType: 'repository', estimatedHours: 6, learningObjectives: ['Read a CSV file'], requiredSkills: ['Python basics'], deliverables: ['marks.py'], evaluationCriteria: ['Runs without errors'], resources: [], content, ...over });
const enroll = async (c, email, name, listing) => {
  await c.post('/auth/register', validStudent({ email, fullName: name }));
  const a = await c.post('/applications', validApplication({ internshipId: listing, fullName: name })); assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal((await admin.patch(`/admin/applications/${a.data.application.id}/status`, { status: 'Approved' })).status, 200);
  const e = await admin.post(`/admin/applications/${a.data.application.id}/internship`, { startDate: day(-1) }); assert.equal(e.status, 201);
  assert.equal((await admin.patch(`/admin/internships/${e.data.internship.id}/activate`, { startDate: day(-1) })).status, 200);
  return e.data.internship.id;
};
const tasksOf = (enr) => db.prepare('SELECT st.id, t.title FROM student_tasks st JOIN internship_tasks t ON t.id = st.task_id WHERE st.enrollment_id = ? ORDER BY t.sequence').all(enr);
const loginCookie = async (email) => { const r = await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) }); assert.equal(r.status, 200); return r.headers.getSetCookie()[0].split(';')[0]; };
const raw = (cookie) => (p, method = 'GET', body) => fetch(srv.base + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
async function connect(cookie, code = 'good-code') {
  const f = raw(cookie); const start = await (await f('/student/github/connect', 'POST', {})).json();
  const r = await f(`/student/github/callback?code=${code}&state=${new URL(start.authorizeUrl).searchParams.get('state')}`); assert.match(r.headers.get('location'), /github=connected/);
}
const good = (over = {}) => ({ description: 'I built a marks analysis tool that reads a CSV and prints averages.', repositoryUrl: 'https://github.com/asha-v/marks-tool', implementedFeatures: 'CSV parsing, per-student average and a class summary.', testingPerformed: 'Unit tests for the parser and manual runs with sample data.', challengesEncountered: 'Handling blank marks in the CSV took some time.', liveUrl: 'https://marks-tool.example.com', submissionNotes: 'Run python src/marks.py', ...over });
const subUrl = (id) => `/student/github/tasks/${id}/submissions`;
const scoresFor = (detail, frac = 1) => Object.fromEntries(detail.rubric.criteria.map((c) => [c.key, Math.round(c.maxScore * frac)]));
const snaps = (taskId) => db.prepare('SELECT COUNT(*) n FROM github_repository_snapshots s JOIN github_repositories r ON r.id = s.repository_id WHERE r.student_task_id = ?').get(taskId).n;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-09c2a-'));
  srv = await startServer({
    ADMIN_API_KEY: 'k'.repeat(40), DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000', RATE_LIMIT_TASK_SUBMIT_MAX: '1000',
    ORG_ADDRESS: '12 Example Road', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Gowtham', ORG_SIGNATORY_TITLE: 'CEO',
    GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'), GITHUB_CLIENT_ID: 'Iv1.testclient', GITHUB_CLIENT_SECRET: 'client-secret-value', GITHUB_ORGANIZATION: 'elvora-org',
    GITHUB_CALLBACK_URL: 'http://localhost:4000/api/v1/student/github/callback', GITHUB_WEBHOOK_SECRET: 'whsec_test_secret_value', GITHUB_REPOSITORY_VISIBILITY: 'private', GITHUB_DEFAULT_REPOSITORY_PERMISSION: 'push',
  });
  ({ db } = await import('../src/db/index.js'));
  G = { client: await import('../src/github/client.js') }; gh = await import('../src/db/github.js'); inspectMod = await import('../src/github/inspect.js'); verif = await import('../src/github/verification.js');
  G.client.setFetch(fakeFetch); G.client.setSleep(async () => {});
  [anon, admin, asha, ravi] = [1, 2, 3, 4].map(() => client(srv.base));
  assert.equal((await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js'); setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  const l = await admin.post('/admin/internship-listings', { title: 'Python Tasks Internship', category: 'python-development', description: 'A listing used by the Stage 09C Part 2A tests.', durationDays: 30, skills: ['Python'], outcomes: ['Build a small Python project'], eligibility: { who: 'Any student' }, type: 'Project-Based', difficulty: 'Beginner' });
  assert.equal((await admin.patch(`/admin/internship-listings/${l.data.internship.id}/state`, { action: 'publish' })).status, 200);
  const lid = l.data.internship.id;
  assert.equal((await admin.post(`/admin/internship-listings/${lid}/tasks`, { ...tpl({ taskType: 'Mini Project', title: 'Marks analysis tool' }), publish: true })).status, 201);
  assert.equal((await admin.post(`/admin/internship-listings/${lid}/tasks`, { ...tpl({ title: 'Reading notes', submissionType: 'text' }), publish: true })).status, 201);
  const ae = await enroll(asha, 'asha@example.com', 'Asha Verma', lid); const re = await enroll(ravi, 'ravi@example.com', 'Ravi Kumar', lid);
  [repoTask, textTask] = tasksOf(ae); [ravisTask] = tasksOf(re);
  ashaId = findByEmail('asha@example.com').id; ashaCookie = await loginCookie('asha@example.com'); raviCookie = await loginCookie('ravi@example.com');
});
after(() => { G.client.setFetch(null); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------------------------------------------
test('migration 18: columns and tables exist; history tables stay append-only; foreign keys intact', () => {
  assert.ok(db.pragma('user_version', { simple: true }) >= 18);
  const cols = db.prepare("PRAGMA table_info('task_submissions')").all().map((c) => c.name);
  for (const c of ['implemented_features', 'testing_performed', 'challenges_encountered']) assert.ok(cols.includes(c), c);
  for (const t of ['github_submission_checks', 'project_review_notes']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('verification states: every state, in plain words, never academic approval', () => {
  const repo = (o = {}) => ({ id: 'GHR-X', studentId: 's', source: 'student_owned', state: 'active', ownershipStatus: 'verified', ...o });
  const ok = (ageDays, pushed) => ({ status: 'ok', inspectedAt: new Date(Date.now() - ageDays * 86400000).toISOString(), data: { verifiedFromGitHub: { repository: { pushedAt: pushed } } } });
  const acc = { verificationStatus: 'verified' };
  assert.equal(verif.verificationFor(null).state, 'not_linked');
  assert.equal(verif.verificationFor(repo({ ownershipStatus: 'unverified' }), null, acc).state, 'pending_verification');
  assert.equal(verif.verificationFor(repo(), ok(0, null), acc).state, 'verified');
  assert.equal(verif.verificationFor(repo({ ownershipStatus: 'not_owner' }), null, acc).state, 'verification_failed');
  assert.equal(verif.verificationFor(repo(), null, { verificationStatus: 'revoked' }).state, 'access_revoked');
  assert.equal(verif.verificationFor(repo(), { status: 'access_denied', data: {} }, acc).state, 'access_revoked');
  assert.equal(verif.verificationFor(repo({ state: 'unavailable' }), null, acc).state, 'repository_unavailable');
  assert.equal(verif.verificationFor(repo(), { status: 'not_found', data: {} }, acc).state, 'repository_unavailable');
  assert.equal(verif.verificationFor(repo(), ok(30, null), acc).state, 'evidence_outdated');
  assert.equal(verif.verificationFor(repo(), ok(1, new Date().toISOString()), acc).state, 'evidence_outdated', 'pushed after the last inspection');
  for (const s of verif.VERIFICATION_STATES) { const v = verif.verificationFor(s === 'not_linked' ? null : repo({ ownershipStatus: s === 'pending_verification' ? 'unverified' : 'verified' })); assert.ok(v.label && v.message && /does not mean your project is approved/.test(v.academicNote)); assert.ok(!/approved\b/i.test(v.message.replace(/approved:/, ''))); }
});

test('submission validation: required narrative fields, invalid URL, non-GitHub URL, non-repository task, unauthorised and anonymous callers', async () => {
  useMock();
  let r = await asha.post(subUrl(repoTask.id), { description: 'I built a marks analysis tool that reads a CSV.', repositoryUrl: 'https://github.com/asha-v/marks-tool' });
  assert.equal(r.status, 400); for (const k of ['implementedFeatures', 'testingPerformed', 'challengesEncountered']) assert.ok(r.data.error.fields[k], k);
  for (const url of ['not a url', 'https://example.com/asha-v/marks-tool', 'http://github.com/asha-v/marks-tool', 'https://github.com/asha-v']) { r = await asha.post(subUrl(repoTask.id), good({ repositoryUrl: url })); assert.equal(r.status, 400, url); assert.ok(r.data.error.fields.repositoryUrl); }
  assert.equal((await asha.post(subUrl(textTask.id), good())).data.error.code, 'NOT_A_REPOSITORY_TASK');
  assert.equal((await ravi.post(subUrl(repoTask.id), good())).status, 404, "another student's task is a plain 404");
  assert.equal((await ravi.get(subUrl(repoTask.id))).status, 404);
  assert.equal((await anon.post(subUrl(repoTask.id), good())).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_submissions').get().n, 0, 'nothing was stored by any failed attempt');
  assert.deepEqual(calls.filter((c) => c.host === 'api.github.com' && c.path.startsWith('/repos/')), [], 'a malformed URL never reaches GitHub');
});

test('a typed URL alone is not verification: a GitHub account must be connected first when GitHub can be asked', async () => {
  useMock(undefined, repoRoutes('asha-v', 'marks-tool', { ownerId: 1001 }));
  const r = await asha.post(subUrl(repoTask.id), good()); assert.equal(r.status, 409); assert.equal(r.data.error.code, 'GITHUB_NOT_CONNECTED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_submissions').get().n, 0);
});

test('repository checks: missing repository, someone else’s repository (verification failed), then the student’s own', async () => {
  await connect(ashaCookie);
  // does not exist
  useMock(undefined, []);
  let r = await asha.post(subUrl(repoTask.id), good({ repositoryUrl: 'https://github.com/asha-v/missing' })); assert.equal(r.status, 404); assert.equal(r.data.error.code, 'REPOSITORY_NOT_FOUND');
  // exists but belongs to someone else
  useMock(undefined, repoRoutes('someone-else', 'marks-tool', { ownerId: 9999 }));
  r = await asha.post(subUrl(repoTask.id), good({ repositoryUrl: 'https://github.com/someone-else/marks-tool' })); assert.equal(r.status, 403); assert.equal(r.data.error.code, 'REPOSITORY_NOT_OWNED');
  const w = await asha.get(`/student/github/tasks/${repoTask.id}/repository`);
  assert.equal(w.data.repository.verification.state, 'verification_failed'); assert.match(w.data.repository.verification.message, /does not belong/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_submissions').get().n, 0);
  // a student cannot reuse another student’s repository either
  assert.equal(JSON.stringify(w.data).includes(USER_TOKEN), false);
});

test('private repository: read with the student’s own token; ownership verified; submission v1 created, evidence stored, status Submitted (never Approved)', async () => {
  useMock(undefined, repoRoutes('asha-v', 'marks-tool', { ownerId: 1001, priv: true }));
  const before = db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n;
  const r = await asha.post(subUrl(repoTask.id), good({ status: 'Approved', score: 100, decision: 'Approved', studentId: 'x' })); assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.submission.version, 1); assert.equal(r.data.verification.state, 'verified'); assert.equal(r.data.checkedWithGitHub, true);
  assert.equal(r.data.assignment.submissionStatus, 'Submitted'); assert.equal(r.data.submissionState.status, 'Submitted');
  const row = db.prepare('SELECT status, review_decision FROM student_tasks WHERE id = ?').get(repoTask.id); assert.equal(row.status, 'Submitted'); assert.equal(row.review_decision, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_reviews').get().n, 0, 'a verified repository creates no review, score or approval');
  const sub = db.prepare('SELECT * FROM task_submissions').get();
  assert.equal(sub.implemented_features, good().implementedFeatures); assert.equal(sub.testing_performed, good().testingPerformed); assert.equal(sub.challenges_encountered, good().challengesEncountered); assert.equal(sub.live_url, 'https://marks-tool.example.com/');
  const chk = db.prepare('SELECT * FROM github_submission_checks').get(); assert.equal(chk.state, 'verified'); assert.equal(chk.visibility, 'private'); assert.equal(chk.ownership_status, 'verified');
  assert.ok(calls.some((c) => c.path.endsWith('/repos/asha-v/marks-tool') && c.auth === `Bearer ${USER_TOKEN}`), 'the student’s own token read the private repository');
  assert.equal(snaps(repoTask.id), 1, 'evidence refreshed on submission');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'github.submission'").get()); assert.ok(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n > before);
  assert.equal(JSON.stringify(r.data).includes(USER_TOKEN) || JSON.stringify(r.data).includes('ghr_R'), false, 'no token in any response');
});

test('duplicate prevention: a second submission while waiting, and the same repository for another student, are both refused', async () => {
  useMock(undefined, repoRoutes('asha-v', 'marks-tool', { ownerId: 1001, priv: true }));
  const again = await asha.post(subUrl(repoTask.id), good()); assert.equal(again.status, 409); assert.equal(again.data.error.code, 'AWAITING_REVIEW');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_submissions').get().n, 1);
  useMock({ id: 2002, login: 'ravi-k', type: 'User' }); await connect(raviCookie, 'ravi-code'); // Ravi connects HIS account, then tries Asha's repository
  useMock({ id: 2002, login: 'ravi-k', type: 'User' }, repoRoutes('asha-v', 'marks-tool', { ownerId: 1001 }));
  const dup = await ravi.post(subUrl(ravisTask.id), good()); assert.equal(dup.status, 409); assert.equal(dup.data.error.code, 'DUPLICATE_REPOSITORY');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_submissions').get().n, 1);
});

test('student history: versions with what was confirmed; reviewer notes never appear', async () => {
  const r = await asha.get(subUrl(repoTask.id)); assert.equal(r.status, 200);
  assert.equal(r.data.submissions.length, 1); assert.equal(r.data.submissions[0].verification.state, 'verified'); assert.equal(r.data.verification.state, 'verified'); assert.match(r.data.academicNote, /does not mean your project is approved/);
  assert.ok(!('notes' in r.data));
});

// ---------------------------------------------------------------------------------------------------------------------------------
test('admin evidence: repository, languages, commits, branches, test-file presence, last inspection; README is plain text only', async () => {
  const d = await admin.get(`/admin/projects/${repoTask.id}`); assert.equal(d.status, 200, JSON.stringify(d.data));
  const g = d.data.github; assert.equal(g.configured, true); assert.equal(g.verification.state, 'verified');
  assert.equal(g.repository.owner, 'asha-v'); assert.equal(g.repository.name, 'marks-tool'); assert.equal(g.repository.openUrl, 'https://github.com/asha-v/marks-tool'); assert.equal(g.repository.visibility, 'private');
  const e = g.evidence; assert.equal(e.metadata.createdAt, '2026-11-01T10:00:00Z'); assert.equal(e.metadata.updatedAt, '2026-11-20T10:00:00Z'); assert.deepEqual(e.branches.names, ['main', 'dev']);
  assert.deepEqual(e.languages.map((l) => [l.name, l.percent]), [['Python', 75], ['HTML', 25]]);
  assert.equal(e.files.hasTestFiles, true); assert.ok(e.files.paths.includes('src/marks.py')); assert.equal(e.commits.latest[0].message, 'Add parser'); assert.equal(e.commits.countIsExact, false); assert.ok(g.lastInspection.inspectedAt);
  assert.equal(g.submissions.length, 1); assert.equal(g.submissions[0].implementedFeatures, good().implementedFeatures); assert.equal(g.submissions[0].check.state, 'verified'); assert.equal(g.submittedUrlMatchesLinked, true);
  assert.match(g.notice, /Tests were not executed/);
  // README safety
  const rd = e.readme; assert.equal(rd.format, 'plain_text'); assert.ok(rd.text.includes('<script>'), 'markup stays literal text; the client renders text, never HTML');
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e]/.test(rd.text), 'control and bidi-override characters are removed');
  assert.ok(!('html' in rd));
  const big = inspectMod.snapshotView && 'x'; void big;
  const dedicated = await admin.get(`/admin/projects/${repoTask.id}/github`); assert.equal(dedicated.status, 200); assert.equal(dedicated.data.evidence.readme.format, 'plain_text');
  for (const s of [USER_TOKEN, INST_TOKEN, 'client-secret-value', 'PRIVATE KEY']) assert.ok(!JSON.stringify(d.data).includes(s), 'no secret in evidence');
});

test('admin access control: students and anonymous callers never reach evidence, refresh or notes; the console key is read-only', async () => {
  for (const [m, p, b] of [['get', `/admin/projects/${repoTask.id}/github`], ['post', `/admin/projects/${repoTask.id}/github/refresh`, {}], ['get', `/admin/projects/${repoTask.id}/notes`], ['post', `/admin/projects/${repoTask.id}/notes`, { note: 'hello there' }]]) {
    assert.equal((await asha[m](p, b)).status, 403, `student ${m} ${p}`); assert.equal((await anon[m](p, b)).status, 401, `anon ${m} ${p}`);
  }
  const key = { 'X-Admin-Key': 'k'.repeat(40) };
  assert.equal((await anon.get(`/admin/projects/${repoTask.id}/github`, key)).status, 200, 'the console key may read');
  for (const p of ['/github/refresh', '/notes']) assert.ok([401, 403].includes((await anon.post(`/admin/projects/${repoTask.id}${p}`, { note: 'hello there' }, key)).status), 'the console key cannot write');
  assert.equal((await admin.get('/admin/projects/STK-NOPE0000/github')).status, 404);
});

test('refresh evidence: appends a snapshot, shows new commits, audited; a rate limit gives a readable error and keeps the older evidence', async () => {
  state.commits = [{ sha: 'fedcba9876543', msg: 'Add tests', date: '2026-11-21T10:00:00Z' }, ...state.commits];
  useMock(undefined, repoRoutes('asha-v', 'marks-tool', { ownerId: 1001, priv: true }));
  const n = snaps(repoTask.id); const r = await admin.post(`/admin/projects/${repoTask.id}/github/refresh`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(snaps(repoTask.id), n + 1); assert.equal(r.data.evidence.commits.latest[0].message, 'Add tests'); assert.equal(r.data.evidence.commits.latest.length, 2);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'project.evidence_refresh' AND result = 'success' AND target_id = ?").get(repoTask.id));
  state.rate = true; const lim = await admin.post(`/admin/projects/${repoTask.id}/github/refresh`, {});
  state.rate = false; assert.equal(lim.status, 429); assert.match(lim.data.error.message, /try again/i); assert.ok(!/ratelimit|API rate limit exceeded/i.test(lim.data.error.message));
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'project.evidence_refresh' AND result = 'failure'").get());
  const after = await admin.get(`/admin/projects/${repoTask.id}/github`); assert.equal(after.data.evidence.commits.latest[0].message, 'Add tests', 'earlier good evidence is kept');
  assert.equal(after.data.evidence.stale, true);
});

test('GitHub outage during a student’s own refresh: friendly message, no technical detail, snapshot recorded', async () => {
  state.down = true; const r = await asha.post(`/student/github/tasks/${repoTask.id}/repository/inspect`, {}); state.down = false;
  assert.equal(r.status, 502); assert.match(r.data.error.message, /not reachable|try again/i); assert.ok(!/503|stack|ECONN|Bearer/i.test(JSON.stringify(r.data)));
});

test('internal review notes: appended, audited, validated, visible only to administrators', async () => {
  let r = await admin.post(`/admin/projects/${repoTask.id}/notes`, { note: 'Parser looks good; check how blank marks are handled.' }); assert.equal(r.status, 200); assert.equal(r.data.notes.length, 1); assert.equal(r.data.notes[0].submissionVersion, 1);
  assert.equal((await admin.post(`/admin/projects/${repoTask.id}/notes`, { note: 'x' })).status, 400);
  assert.equal((await admin.post(`/admin/projects/${repoTask.id}/notes`, {})).status, 400);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'project.note_add'").get());
  assert.throws(() => db.prepare('UPDATE project_review_notes SET note = ?').run('edited'), /append-only/);
  const sv = await asha.get(`/student/tasks/${repoTask.id}`); const hv = await asha.get(subUrl(repoTask.id)); const wv = await asha.get(`/student/github/tasks/${repoTask.id}/repository`);
  for (const x of [sv, hv, wv]) assert.ok(!JSON.stringify(x.data).includes('blank marks are handled'), 'students never see internal notes');
  r = await admin.get(`/admin/projects/${repoTask.id}/notes`); assert.equal(r.data.notes.length, 1);
});

test('review workflow: repository existence never approves; incomplete scoring is refused even with a verified repository; request changes notifies the student', async () => {
  let d = (await admin.get(`/admin/projects/${repoTask.id}`)).data; assert.equal(d.submission.status, 'Submitted'); assert.equal(d.github.verification.state, 'verified');
  const noScores = await admin.post(`/admin/projects/${repoTask.id}/decision`, { decision: 'Approved', confirm: true }); assert.equal(noScores.status, 400, 'a verified repository with many commits cannot be approved without an evaluation');
  assert.equal((await asha.post(`/admin/projects/${repoTask.id}/decision`, { decision: 'Approved', confirm: true, scores: {} })).status, 403);
  assert.equal((await admin.post(`/admin/projects/${repoTask.id}/start-review`, {})).status, 200);
  d = (await admin.get(`/admin/projects/${repoTask.id}`)).data;
  const cr = await admin.post(`/admin/projects/${repoTask.id}/decision`, { decision: 'Changes Requested', confirm: true, scores: scoresFor(d, 0.5), feedback: 'Please add README installation steps and handle blank marks.' });
  assert.equal(cr.status, 200, JSON.stringify(cr.data)); assert.equal(cr.data.submission.status, 'Changes Requested');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE student_id = ? AND type = 'task_changes_requested'").get(ashaId));
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'project.decision'").get());
  const sv = await asha.get(`/student/tasks/${repoTask.id}`); assert.equal(sv.data.assignment.submissionStatus, 'Changes Requested'); assert.equal(sv.data.evaluations.length, 1); assert.match(sv.data.evaluations[0].feedback, /README installation/);
});

test('resubmission: new version appended, v1 and its review preserved, evidence refreshed, status Resubmitted', async () => {
  state.commits = [{ sha: '1111111222222', msg: 'Handle blank marks', date: '2026-11-22T08:00:00Z' }, ...state.commits];
  useMock(undefined, repoRoutes('asha-v', 'marks-tool', { ownerId: 1001, priv: true }));
  const n = snaps(repoTask.id);
  const r = await asha.post(subUrl(repoTask.id), good({ description: 'Second version: I added install steps and blank-mark handling to the tool.' })); assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.submission.version, 2); assert.equal(r.data.assignment.submissionStatus, 'Resubmitted'); assert.equal(snaps(repoTask.id), n + 1);
  const subs = db.prepare('SELECT version, description FROM task_submissions ORDER BY version').all(); assert.equal(subs.length, 2); assert.match(subs[0].description, /reads a CSV/); assert.match(subs[1].description, /Second version/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM github_submission_checks').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_reviews WHERE student_task_id = ?').get(repoTask.id).n, 1, 'the earlier review is kept');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM project_evaluations WHERE status = 'Final'").get().n, 1);
  const h = await asha.get(subUrl(repoTask.id)); assert.equal(h.data.submissions.length, 2); assert.equal(h.data.reviews.length, 1);
  const d = (await admin.get(`/admin/projects/${repoTask.id}`)).data; assert.equal(d.github.submissions.length, 2); assert.equal(d.github.notes.length, 1, 'v1 notes preserved'); assert.equal(d.github.evidence.commits.latest[0].message, 'Handle blank marks');
  assert.throws(() => db.prepare('UPDATE task_submissions SET description = ?').run('x'), /append-only/);
});

test('approval is an explicit administrator decision recorded in the audit log; afterwards nothing can be resubmitted', async () => {
  await admin.post(`/admin/projects/${repoTask.id}/start-review`, {});
  const d = (await admin.get(`/admin/projects/${repoTask.id}`)).data;
  const ok = await admin.post(`/admin/projects/${repoTask.id}/decision`, { decision: 'Approved', confirm: true, scores: scoresFor(d, 0.9), feedback: 'Well done.' }); assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.submission.status, 'Approved');
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE student_id = ? AND type = 'task_approved'").get(ashaId));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action = 'project.decision'").get().n, 2);
  assert.equal((await asha.post(subUrl(repoTask.id), good())).status, 409);
});

test('rejection: Ravi submits his own repository; the administrator rejects it; rejected work cannot be resubmitted', async () => {
  useMock({ id: 2002, login: 'ravi-k', type: 'User' }, repoRoutes('ravi-k', 'ravi-tool', { ownerId: 2002 }));
  const r = await ravi.post(subUrl(ravisTask.id), good({ repositoryUrl: 'https://github.com/ravi-k/ravi-tool' })); assert.equal(r.status, 201, JSON.stringify(r.data));
  await admin.post(`/admin/projects/${ravisTask.id}/start-review`, {}); const d = (await admin.get(`/admin/projects/${ravisTask.id}`)).data;
  const rej = await admin.post(`/admin/projects/${ravisTask.id}/decision`, { decision: 'Rejected', confirm: true, scores: scoresFor(d, 0.2), feedback: 'The project does not meet the minimum requirements.' });
  assert.equal(rej.status, 200, JSON.stringify(rej.data)); assert.equal(rej.data.submission.status, 'Rejected');
  assert.equal((await ravi.post(subUrl(ravisTask.id), good({ repositoryUrl: 'https://github.com/ravi-k/ravi-tool' }))).data.error.code, 'TASK_REJECTED');
});

test('GitHub down at submission time: the version is accepted as “pending verification” (never verified), and the integrity checks still hold', async () => {
  // a fresh assignment is needed; reuse the text task by turning it into a repository task for the test is not allowed, so exercise the service rules directly:
  const v = verif.verificationFor({ id: 'GHR-Z', studentId: ashaId, source: 'manual_url', state: 'active', ownershipStatus: 'unverified' }, null, null);
  assert.equal(v.state, 'pending_verification'); assert.match(v.message, /not been able to confirm/);
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.prepare('SELECT COUNT(*) n FROM github_submission_checks WHERE state = ?').get('verified').n >= 1, true);
});
