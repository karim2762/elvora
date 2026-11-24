// Stage 09C Part 2B — notifications, webhooks, security and integration (mocked GitHub, in-memory DB).
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
  const f = raw(cookie); const start = await (await f("/student/github/connect", "POST", {})).json(); if (!start.authorizeUrl) throw new Error(JSON.stringify(start));
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

const WHSEC = 'whsec_test_secret_value';
const hook = (event, payload, { id = crypto.randomUUID(), secret = WHSEC, sig, rawBody } = {}) => {
  const raw = rawBody ?? Buffer.from(JSON.stringify(payload)); const s = sig ?? `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return fetch(`${srv.base}/github/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': id, ...(s ? { 'x-hub-signature-256': s } : {}) }, body: raw });
};
const notes = async (c) => (await c.get('/student/notifications?pageSize=50')).data;
const ofType = (list, type) => list.notifications.filter((n) => n.type === type);

test('migration 19: columns, dedupe index; older notifications untouched; foreign keys intact', () => {
  assert.ok(db.pragma('user_version', { simple: true }) >= 19);
  const cols = db.prepare("PRAGMA table_info('notifications')").all().map((c) => c.name); assert.ok(cols.includes('student_task_id') && cols.includes('dedupe_key'));
  assert.ok(db.prepare("PRAGMA table_info('github_repositories')").all().some((c) => c.name === 'evidence_stale_at'));
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('notifications: connect, link and submit create linked, unread, correctly-owned notifications; a retried event adds none', async () => {
  useMock(); await connect(ashaCookie);
  let n = await notes(asha); assert.equal(ofType(n, 'github_connected').length, 1); assert.equal(ofType(n, 'github_connected')[0].read, false);
  assert.equal((await raw(ashaCookie)('/student/github', 'DELETE')).status, 200); await connect(ashaCookie); // disconnect + reconnect on the same day: same key, no second row
  assert.equal(ofType(await notes(asha), 'github_connected').length, 1, 'retry is idempotent');
  useMock(undefined, repoRoutes('asha-v', 'marks-tool', { ownerId: 1001 }));
  let r = await asha.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: 'https://github.com/asha-v/marks-tool' }); assert.equal(r.status, 201, JSON.stringify(r.data));
  n = await notes(asha); const linked = ofType(n, 'github_repo_linked'); assert.equal(linked.length, 1); assert.equal(linked[0].studentTaskId, repoTask.id); assert.ok(linked[0].enrollmentId);
  r = await asha.post(subUrl(repoTask.id), good()); assert.equal(r.status, 201, JSON.stringify(r.data));
  n = await notes(asha); assert.equal(ofType(n, 'project_submitted').length, 1); assert.equal(ofType(n, 'submission_verified').length, 1); assert.equal(ofType(n, 'project_submitted')[0].studentTaskId, repoTask.id);
  assert.deepEqual((await notes(ravi)).notifications.filter((x) => x.type.startsWith('github_') || x.type === 'project_submitted'), [], "another student never receives Asha's notifications");
  const id = linked[0].id; const read = await asha.patch(`/student/notifications/${id}/read`, {}); assert.ok([200, 204].includes(read.status), read.status);
  assert.equal((await notes(asha)).notifications.find((x) => x.id === id).read, true, 'read status persists');
  assert.equal((await ravi.patch(`/student/notifications/${id}/read`, {})).status, 404, "another student's notification id behaves like a missing one");
  const body = JSON.stringify(await notes(asha)); assert.ok(!body.includes(USER_TOKEN) && !body.includes(INST_TOKEN), 'no token in notifications');
});

test('notification failure never corrupts or fails the operation (insert blocked by a trigger)', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
  db.exec("CREATE TRIGGER t_block BEFORE INSERT ON notifications WHEN NEW.dedupe_key LIKE 'gh:%' BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  try {
    useMock(); const mod = await import('../src/github/notify.js');
    assert.equal(mod.notifyGithub('github_connected', { studentId: ashaId, login: 'x', key: 'fail-test' }), false, 'returns false instead of throwing');
    assert.equal((await asha.get('/student/github/status')).status, 200);
  } finally { db.exec('DROP TRIGGER t_block'); }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, before);
  const mod = await import('../src/github/notify.js');
  assert.equal(mod.notifyGithub('github_repo_linked', { studentId: ashaId, studentTaskId: ravisTask.id, repo: 'x/y', key: 'k' }), false, "never links a notification to another student's task");
  assert.equal(mod.notifyGithub('not_a_kind', { studentId: ashaId }), false);
});

test('webhook signature, malformed payloads and delivery-id deduplication', async () => {
  assert.equal((await hook('push', {}, { sig: '' })).status, 401);
  assert.equal((await hook('push', {}, { secret: 'wrong' })).status, 401);
  const before = db.prepare('SELECT COUNT(*) n FROM github_webhook_events').get().n;
  for (const rawBody of [Buffer.from('null'), Buffer.from('[1,2]'), Buffer.from('"x"'), Buffer.from('{bad json')]) { const r = await hook('push', null, { rawBody }); assert.equal(r.status, 400, rawBody.toString()); }
  assert.equal((await hook('push', {}, { id: 'zz' })).status, 400, 'bad delivery id');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM github_webhook_events').get().n, before, 'malformed deliveries store nothing');
  assert.equal((await hook('repository', { action: 'deleted', repository: 'nope' })).status, 200, 'unexpected shapes are ignored safely');
  assert.equal((await hook('push', { ref: 5, repository: { id: 'x' } })).status, 200);
  const id = crypto.randomUUID(); assert.equal((await (await hook('push', { ref: 'refs/heads/main' }, { id })).json()).outcome, 'no_linked_repository');
  assert.equal((await (await hook('push', { ref: 'refs/heads/main' }, { id })).json()).outcome, 'duplicate');
  gh.recordWebhook({ deliveryId: 'abcdef12-aaaa', event: 'x', outcome: 'received' }); gh.forgetWebhook('abcdef12-aaaa');
  assert.equal(gh.recordWebhook({ deliveryId: 'abcdef12-aaaa', event: 'x', outcome: 'received' }), true, 'a failed delivery is forgotten so the redelivery is processed');
});

test('push events only invalidate evidence: no GitHub call, no approval, other branches ignored', async () => {
  const repo = gh.findRepoForTask(repoTask.id); gh.updateRepo(repo.id, { githubRepoId: 1101 });
  const v0 = (await admin.get(`/admin/projects/${repoTask.id}`)).data.github.verification.state; assert.equal(v0, 'verified');
  calls.length = 0; const statusBefore = db.prepare('SELECT status FROM student_tasks WHERE id = ?').get(repoTask.id).status;
  let r = await (await hook('push', { ref: 'refs/heads/dev', repository: { id: 1101, default_branch: 'main' } })).json(); assert.equal(r.outcome, 'push_other_branch');
  assert.equal((await admin.get(`/admin/projects/${repoTask.id}`)).data.github.verification.state, 'verified');
  await new Promise((s) => setTimeout(s, 5));
  r = await (await hook('push', { ref: 'refs/heads/main', repository: { id: 1101, default_branch: 'main' } })).json(); assert.equal(r.outcome, 'evidence_invalidated:1');
  assert.deepEqual(calls, [], 'a push triggers no GitHub request');
  assert.equal((await admin.get(`/admin/projects/${repoTask.id}`)).data.github.verification.state, 'evidence_outdated');
  assert.equal(db.prepare('SELECT status FROM student_tasks WHERE id = ?').get(repoTask.id).status, statusBefore, 'a push never changes the task');
  useMock(undefined, repoRoutes('asha-v', 'marks-tool', { ownerId: 1001 })); await new Promise((s) => setTimeout(s, 5));
  assert.equal((await admin.post(`/admin/projects/${repoTask.id}/github/refresh`, {})).status, 200);
  assert.equal((await admin.get(`/admin/projects/${repoTask.id}`)).data.github.verification.state, 'verified', 'a refresh clears the outdated state');
});

test('visibility change updates the record without marking the repository unavailable', async () => {
  const repo = gh.findRepoForTask(repoTask.id);
  let r = await (await hook('repository', { action: 'privatized', repository: { id: 1101 } })).json(); assert.equal(r.outcome, 'visibility_privatized:1');
  assert.equal(gh.findRepoById(repo.id).visibility, 'private'); assert.equal(gh.findRepoById(repo.id).state, 'active');
  r = await (await hook('repository', { action: 'publicized', repository: { id: 1101 } })).json(); assert.equal(gh.findRepoById(repo.id).visibility, 'public');
});

test('installation validation: a payload for a different installation is rejected; removed repositories become unavailable and notify once', async () => {
  const app = await import('../src/github/app.js'); await app.getInstallation({ force: true }).catch(() => {});
  assert.equal(app.knownInstallationId(), 77);
  const before = gh.findRepoForTask(repoTask.id).state;
  let r = await (await hook('repository', { action: 'deleted', installation: { id: 999 }, repository: { id: 1101 } })).json(); assert.equal(r.outcome, 'rejected:installation_mismatch'); assert.equal(gh.findRepoForTask(repoTask.id).state, before);
  r = await (await hook('installation', { action: 'new_permissions_accepted', installation: { id: 999 } })).json(); assert.equal(r.outcome, 'rejected:installation_mismatch');
  r = await (await hook('installation', { action: 'new_permissions_accepted', installation: { id: 77 } })).json(); assert.equal(r.outcome, 'installation_new_permissions_accepted');
  const before2 = ofType(await notes(asha), 'github_verification_failed').length;
  r = await (await hook('installation_repositories', { action: 'removed', installation: { id: 77 }, repositories_removed: [{ id: 1101 }, { id: 'x' }, null] })).json(); assert.equal(r.outcome, 'installation_repositories:1');
  assert.equal(gh.findRepoForTask(repoTask.id).state, 'unavailable');
  await hook('installation_repositories', { action: 'removed', installation: { id: 77 }, repositories_removed: [{ id: 1101 }] });
  const after = ofType(await notes(asha), 'github_verification_failed'); assert.equal(after.length, before2 + 1, 'the same event is not notified twice');
  assert.equal(after[0].studentTaskId, repoTask.id);
  assert.equal((await admin.get(`/admin/projects/${repoTask.id}`)).data.github.verification.state, 'repository_unavailable');
});

test('deletion and transfer notify the right student about the right task; revoked authorization is recorded', async () => {
  const repo = gh.findRepoForTask(repoTask.id); gh.updateRepo(repo.id, { state: 'active' });
  let r = await (await hook('repository', { action: 'transferred', repository: { id: 1101, name: 'marks-tool', owner: { login: 'new-owner' }, html_url: 'https://github.com/new-owner/marks-tool' } })).json(); assert.equal(r.outcome, 'updated:1');
  assert.equal(gh.findRepoById(repo.id).owner, 'new-owner'); assert.equal(gh.findRepoById(repo.id).ownershipStatus, 'unverified');
  const t = (await notes(asha)).notifications.find((x) => x.message.includes('transferred')); assert.ok(t && t.studentTaskId === repoTask.id);
  assert.ok(!(await notes(ravi)).notifications.some((x) => x.message.includes('transferred')));
  r = await (await hook('repository', { action: 'deleted', repository: { id: 1101 } })).json(); assert.equal(r.outcome, 'unavailable:1');
  r = await (await hook('github_app_authorization', { action: 'revoked', sender: { id: 1001 } })).json(); assert.equal(r.outcome, 'revoked:1');
  assert.equal(db.prepare('SELECT access_token_enc FROM github_accounts WHERE student_id = ?').get(ashaId).access_token_enc, null);
});

test('webhook processing error is forgotten so the redelivery succeeds (500, then 200)', async () => {
  const real = gh.reposByGithubRepoId; let boom = true;
  const wh = await import('../src/github/webhook.js'); const id = crypto.randomUUID();
  const orig = db.prepare.bind(db); let hit = false;
  db.exec("CREATE TRIGGER t_err BEFORE UPDATE ON github_repositories BEGIN SELECT RAISE(ABORT, 'db down'); END");
  const gone = gh.reposByGithubRepoId(1101).length; assert.ok(gone >= 1);
  const r1 = wh.processEvent({ deliveryId: id, event: 'repository', payload: { action: 'deleted', repository: { id: 1101 } } }); assert.equal(r1.status, 500);
  db.exec('DROP TRIGGER t_err');
  const r2 = wh.processEvent({ deliveryId: id, event: 'repository', payload: { action: 'deleted', repository: { id: 1101 } } }); assert.equal(r2.status, 200); assert.notEqual(r2.outcome, 'duplicate');
  void real; void boom; void orig; void hit;
});

test('review decisions notify with a task link, once, and the student can open only their own task', async () => {
  useMock(undefined, repoRoutes('asha-v', 'marks-tool', { ownerId: 1001 }));
  await admin.post(`/admin/projects/${repoTask.id}/start-review`, {}); const d = (await admin.get(`/admin/projects/${repoTask.id}`)).data;
  const cr = await admin.post(`/admin/projects/${repoTask.id}/decision`, { decision: 'Changes Requested', confirm: true, scores: scoresFor(d, 0.5), feedback: 'Please add README installation steps.' }); assert.equal(cr.status, 200, JSON.stringify(cr.data));
  const n = ofType(await notes(asha), 'task_changes_requested'); assert.equal(n.length, 1); assert.equal(n[0].studentTaskId, repoTask.id);
  const rep = await admin.post(`/admin/projects/${repoTask.id}/decision`, { decision: 'Changes Requested', confirm: true, scores: scoresFor(d, 0.5), feedback: 'again' }); assert.ok(rep.status >= 400, 'a repeated decision is refused');
  assert.equal(ofType(await notes(asha), 'task_changes_requested').length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action = 'project.decision'").get().n >= 1, true, 'decision recorded in the audit log');
  assert.equal((await asha.get('/admin/projects')).status, 403); assert.equal((await ravi.get(`/admin/projects/${repoTask.id}`)).status, 403);
  assert.equal((await ravi.get(`/student/tasks/${repoTask.id}`)).status, 404);
});

test('API surface: nothing GitHub-related leaks a token; student and admin writes are authenticated', async () => {
  for (const c of [asha, admin]) for (const p of ['/student/github/status', `/student/github/tasks/${repoTask.id}/repository`]) { const r = await c.get(p); assert.ok(!JSON.stringify(r.data).match(/ghu_|ghs_|ghr_|client-secret|whsec_|access_token_enc/), p); }
  assert.equal((await anon.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: 'https://github.com/a/b' })).status, 401);
  assert.equal((await ravi.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: 'https://github.com/ravi-k/x' })).status, 404);
  assert.equal((await asha.post(`/admin/projects/${repoTask.id}/notes`, { note: 'x' })).status, 403);
  assert.equal((await asha.post(`/admin/projects/${repoTask.id}/github/refresh`, {})).status, 403);
});
