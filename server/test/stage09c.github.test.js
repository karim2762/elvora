// Stage 09C Part 1 — GitHub integration (OAuth connection, App installation, repository creation/linking/verification/inspection, webhooks).
// Real HTTP against the app + an in-memory DB; api.github.com is a MOCK injected with setFetch(). No real GitHub account or network is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const WEBHOOK_SECRET = 'whsec_test_secret_value';
const USER_TOKEN = 'ghu_USERTOKEN_SHOULD_NEVER_LEAK_123';
const INST_TOKEN = 'ghs_INSTALLATION_TOKEN_456';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let srv, dir, db, admin, asha, ravi, anon, G, audit, gh, repoTask, textTask, ravisTask, calls, mock, logs;

// ---- the GitHub mock: mock.routes is an ordered list of [METHOD, regex, handler(req) -> [status, body, headers?]] ----
const res = (status, body, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json', ...headers } });
async function fakeFetch(url, init = {}) {
  const u = new URL(url); const method = init.method ?? 'GET'; const body = init.body ? JSON.parse(init.body) : undefined;
  const rec = { method, host: u.host, path: u.pathname + u.search, auth: init.headers?.Authorization ?? null, body }; calls.push(rec);
  for (const [m, re, fn] of mock.routes) if (m === method && re.test(rec.host + rec.path)) { const [s, b, h] = fn(rec); return res(s, b, h); }
  return res(404, { message: 'Not Found' });
}
const base = () => [
  ['POST', /github\.com\/login\/oauth\/access_token/, (r) => (r.body.code === 'good-code' || r.body.code === 'org-code' || r.body.code === 'ravi-code') ? [200, { access_token: USER_TOKEN, refresh_token: 'ghr_REFRESH', expires_in: 28800 }] : [200, { error: 'bad_verification_code' }]],
  ['GET', /api\.github\.com\/user$/, (r) => r.auth === `Bearer ${USER_TOKEN}` ? [200, mock.user] : [401, {}]],
  ['DELETE', /api\.github\.com\/applications\/.+\/grant/, () => [204]],
  ['GET', /api\.github\.com\/orgs\/elvora-org\/installation/, () => [200, { id: 77, account: { login: 'ELVORA-org', type: 'Organization' }, permissions: { administration: 'write', contents: 'write', metadata: 'read' }, repository_selection: 'all' }]],
  ['POST', /api\.github\.com\/app\/installations\/77\/access_tokens/, () => [201, { token: INST_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() }]],
];
const useMock = (user = { id: 1001, login: 'asha-v', type: 'User' }, extra = []) => { calls = []; mock = { user, routes: [...extra, ...base()] }; };

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
// Drive the whole connect flow for a student client and return the redirect Location.
async function connect(c, { code = 'good-code', tamper } = {}) {
  const r = await c.post('/student/github/connect', {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  const u = new URL(r.data.authorizeUrl); let state = u.searchParams.get('state'); if (tamper) state = tamper(state);
  const cb = await c.get(`/student/github/callback?code=${code}&state=${encodeURIComponent(state)}`);
  return { authorize: u, cb };
}
const redirectOf = async (c, p) => { const r = await fetch(srv.base + p, { redirect: 'manual', headers: c.cookie ? { cookie: c.cookie } : {} }); return r; };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-09c-'));
  srv = await startServer({
    ADMIN_API_KEY: 'k'.repeat(40), DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000', RATE_LIMIT_TASK_SUBMIT_MAX: '1000',
    ORG_ADDRESS: '12 Example Road', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Gowtham', ORG_SIGNATORY_TITLE: 'CEO',
    GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'), GITHUB_CLIENT_ID: 'Iv1.testclient', GITHUB_CLIENT_SECRET: 'client-secret-value', GITHUB_ORGANIZATION: 'elvora-org',
    GITHUB_CALLBACK_URL: 'http://localhost:4000/api/v1/student/github/callback', GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, GITHUB_REPOSITORY_VISIBILITY: 'private', GITHUB_DEFAULT_REPOSITORY_PERMISSION: 'push',
  });
  ({ db } = await import('../src/db/index.js'));
  G = { client: await import('../src/github/client.js'), repos: await import('../src/github/repositories.js'), naming: await import('../src/github/naming.js'), crypto: await import('../src/github/crypto.js'), appmod: await import('../src/github/app.js') };
  audit = await import('../src/db/audit.js'); gh = await import('../src/db/github.js');
  G.client.setFetch(fakeFetch); G.client.setSleep(async () => {});
  logs = []; for (const k of ['log', 'warn', 'error']) { const o = console[k]; console[k] = (...a) => { logs.push(a.map(String).join(' ')); o.apply(console, a); }; }
  [anon, admin, asha, ravi] = [1, 2, 3, 4].map(() => client(srv.base));
  for (const c of [asha, ravi]) { const orig = c.get; c.cookie = ''; }
  assert.equal((await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js'); setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  const l = await admin.post('/admin/internship-listings', { title: 'Python Tasks Internship', category: 'python-development', description: 'A listing used by the Stage 09C tests.', durationDays: 30, skills: ['Python'], outcomes: ['Build a small Python project'], eligibility: { who: 'Any student' }, type: 'Project-Based', difficulty: 'Beginner' });
  assert.equal((await admin.patch(`/admin/internship-listings/${l.data.internship.id}/state`, { action: 'publish' })).status, 200);
  const lid = l.data.internship.id;
  { const x = await admin.post(`/admin/internship-listings/${lid}/tasks`, { ...tpl({ taskType: 'Mini Project', title: 'Marks analysis tool' }), publish: true }); assert.equal(x.status, 201, JSON.stringify(x.data)); }
  assert.equal((await admin.post(`/admin/internship-listings/${lid}/tasks`, { ...tpl({ title: 'Reading notes', submissionType: 'text' }), publish: true })).status, 201);
  const ae = await enroll(asha, 'asha@example.com', 'Asha Verma', lid); const re = await enroll(ravi, 'ravi@example.com', 'Ravi Kumar', lid);
  [repoTask, textTask] = tasksOf(ae); [ravisTask] = tasksOf(re);
  // The cookie jar of the helper is private, so expose it for the manual-redirect fetches.
});
after(() => { G.client.setFetch(null); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ----------------------------------------------------------------------------------------------------------------------------------
test('migration 17: tables exist, nothing else changed, snapshots and audit log stay append-only', () => {
  assert.ok(db.pragma('user_version', { simple: true }) >= 17);
  for (const t of ['github_accounts', 'github_oauth_states', 'github_repositories', 'github_repository_snapshots', 'github_webhook_events']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('crypto: tokens round-trip, are unreadable at rest, and tampering or a wrong format yields null', () => {
  const blob = G.crypto.encrypt('ghu_secret'); assert.ok(!blob.includes('ghu_secret')); assert.equal(G.crypto.decrypt(blob), 'ghu_secret');
  assert.equal(G.crypto.decrypt(blob.slice(0, -2) + 'AA'), null); assert.equal(G.crypto.decrypt('garbage'), null); assert.equal(G.crypto.decrypt(null), null);
  assert.notEqual(G.crypto.encrypt('x'), G.crypto.encrypt('x'));
});

test('repository naming: elvora-<internship>-<public id>-<slug>; only public identifiers; valid GitHub name; length-capped', () => {
  const n = G.naming.repositoryName({ internshipId: 'ELV-PY-001', enrollmentId: 'ELV-7K3Q9XMD', title: 'Student Marks Analysis!' });
  assert.equal(n, 'elvora-elv-py-001-elv-7k3q9xmd-student-marks-analysis');
  assert.match(G.naming.repositoryName({ internshipId: 'X', enrollmentId: 'Y', title: '   ' }), /-project$/);
  const long = G.naming.repositoryName({ internshipId: 'ELV-PY-001', enrollmentId: 'ELV-7K3Q9XMD', title: 'a'.repeat(300) }); assert.ok(long.length <= 100 && G.naming.REPO_NAME_RE.test(long));
  assert.match(G.naming.repositoryName({ internshipId: 'ELV-PY-001', enrollmentId: 'ELV-7K3Q9XMD', title: 'Tool', studentTaskId: 'STK-AB12CD34', disambiguate: true }), /-ab12cd34$/);
});

test('student status: integration ready, no account yet; nothing about configuration leaks; students never reach admin health', async () => {
  const r = await asha.get('/student/github/status'); assert.equal(r.status, 200);
  assert.equal(r.data.integration.state, 'ready'); assert.equal(r.data.account.connected, false);
  const text = JSON.stringify(r.data); for (const s of ['elvora-org', '12345', 'client-secret-value', 'PRIVATE KEY']) assert.ok(!text.includes(s), s);
  assert.equal((await asha.get('/admin/github/status')).status, 403);
  assert.equal((await anon.get('/student/github/status')).status, 401);
  assert.equal((await anon.post('/student/github/connect', {})).status, 401);
});

test('OAuth start: state + PKCE S256 + redirect URI; no client secret in the URL; the state is stored only as a hash', async () => {
  useMock();
  const r = await asha.post('/student/github/connect', {}); assert.equal(r.status, 200);
  const u = new URL(r.data.authorizeUrl);
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize'); assert.equal(u.searchParams.get('client_id'), 'Iv1.testclient');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256'); assert.ok(u.searchParams.get('code_challenge').length >= 40); assert.ok(u.searchParams.get('state').length >= 40);
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:4000/api/v1/student/github/callback'); assert.ok(!r.data.authorizeUrl.includes('client-secret-value'));
  const rows = db.prepare('SELECT * FROM github_oauth_states').all(); assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(u.searchParams.get('state')));
});

// The callback is a browser redirect; use the cookie-aware client for the call and read the redirect from a manual fetch.
async function callback(c, query) {
  const cookie = c.cookieValue(); const r = await fetch(`${srv.base}/student/github/callback?${query}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return { status: r.status, location: r.headers.get('location') };
}
before(() => { /* cookie access helper: the shared client keeps its cookie private, so sign in again and capture it */ });

test('OAuth callback: bad state, wrong student, missing sign-in, replay and GitHub errors never link an account', async () => {
  // capture session cookies by logging in with raw fetches
  const login = async (email) => { const r = await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) }); assert.equal(r.status, 200); return r.headers.getSetCookie()[0].split(';')[0]; };
  const [ca, cr] = [await login('asha@example.com'), await login('ravi@example.com')];
  const api = (cookie) => async (p, init = {}) => fetch(srv.base + p, { redirect: 'manual', ...init, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
  const A = api(ca), R = api(cr), N = api(null);
  useMock();
  const start = async (X) => new URL((await (await X('/student/github/connect', { method: 'POST', body: '{}' })).json()).authorizeUrl).searchParams.get('state');
  // 1. forged state
  let r = await A(`/student/github/callback?code=good-code&state=${'x'.repeat(43)}`); assert.equal(r.status, 302); assert.match(r.headers.get('location'), /github=error&reason=GITHUB_STATE_INVALID/);
  // 2. state issued to Asha, presented by Ravi (login-CSRF / session mix-up)
  const sa = await start(A); r = await R(`/student/github/callback?code=good-code&state=${sa}`); assert.match(r.headers.get('location'), /reason=GITHUB_STATE_INVALID/);
  r = await A(`/student/github/callback?code=good-code&state=${sa}`); assert.match(r.headers.get('location'), /reason=GITHUB_STATE_INVALID/, 'the state was consumed even by the failed attempt');
  // 3. not signed in at all
  const s2 = await start(A); r = await N(`/student/github/callback?code=good-code&state=${s2}`); assert.match(r.headers.get('location'), /\/login$/);
  // 4. user denied access on GitHub
  const s3 = await start(A); r = await A(`/student/github/callback?error=access_denied&state=${s3}`); assert.match(r.headers.get('location'), /reason=GITHUB_AUTH_DENIED/);
  // 5. GitHub rejects the code
  const s4 = await start(A); r = await A(`/student/github/callback?code=wrong&state=${s4}`); assert.match(r.headers.get('location'), /reason=GITHUB_CODE_REJECTED/);
  // 6. expired state
  const s5 = await start(A); db.prepare('UPDATE github_oauth_states SET expires_at = 1').run(); r = await A(`/student/github/callback?code=good-code&state=${s5}`); assert.match(r.headers.get('location'), /reason=GITHUB_STATE_INVALID/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_accounts').get().n, 0);
  // 7. an organisation account is not a person
  useMock({ id: 5555, login: 'some-org', type: 'Organization' });
  const s6 = await start(A); r = await A(`/student/github/callback?code=good-code&state=${s6}`); assert.match(r.headers.get('location'), /reason=GITHUB_ACCOUNT_TYPE/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_accounts').get().n, 0);
  Object.assign(globalThis, { __cookies: { ca, cr } });
});

test('connect: identity comes from GitHub, PKCE verifier is sent, tokens are stored encrypted and never returned; audit row written', async () => {
  useMock();
  const { ca } = globalThis.__cookies;
  const start = await (await fetch(`${srv.base}/student/github/connect`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ca }, body: '{}' })).json();
  const u = new URL(start.authorizeUrl);
  const r = await fetch(`${srv.base}/student/github/callback?code=good-code&state=${u.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: ca } });
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /github=connected/); assert.ok(!r.headers.get('location').includes(USER_TOKEN));
  const exchange = calls.find((c) => c.path === '/login/oauth/access_token');
  assert.equal(crypto.createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), u.searchParams.get('code_challenge'), 'the PKCE verifier matches the challenge');
  assert.equal(exchange.body.client_secret, 'client-secret-value');
  const row = db.prepare('SELECT * FROM github_accounts').get();
  assert.equal(row.login, 'asha-v'); assert.equal(row.github_user_id, 1001); assert.equal(row.verification_status, 'verified');
  assert.ok(!JSON.stringify(row).includes(USER_TOKEN) && !JSON.stringify(row).includes('ghr_REFRESH')); assert.equal(G.crypto.decrypt(row.access_token_enc), USER_TOKEN);
  const st = await asha.get('/student/github/status'); assert.equal(st.data.account.login, 'asha-v'); assert.equal(st.data.account.verified, true); assert.equal(st.data.account.connected, true);
  assert.ok(!JSON.stringify(st.data).includes(USER_TOKEN));
  const ev = db.prepare("SELECT actor_type, action, target_type FROM audit_logs WHERE action = 'github.connect'").all(); assert.equal(ev.length, 1); assert.equal(ev[0].actor_type, 'system');
  // a second connect while connected is refused
  assert.equal((await asha.post('/student/github/connect', {})).status, 409);
});

test('one GitHub account can be linked to only one ELVORA account', async () => {
  useMock(); const { cr } = globalThis.__cookies;
  const start = await (await fetch(`${srv.base}/student/github/connect`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cr }, body: '{}' })).json();
  const r = await fetch(`${srv.base}/student/github/callback?code=ravi-code&state=${new URL(start.authorizeUrl).searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: cr } });
  assert.match(r.headers.get('location'), /reason=GITHUB_ACCOUNT_IN_USE/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_accounts').get().n, 1);
  assert.throws(() => gh.saveAccount({ studentId: db.prepare("SELECT id FROM students WHERE email='ravi@example.com'").get().id, githubUserId: 1001, login: 'dup', accountType: 'User', accessTokenEnc: 'x' }), /UNIQUE/i);
});

test('repository creation: refused when the student has not connected GitHub, for foreign tasks, text-only tasks and unknown IDs', async () => {
  useMock();
  const noAcct = await ravi.post(`/student/github/tasks/${ravisTask.id}/repository`, {}); assert.equal(noAcct.status, 409); assert.equal(noAcct.data.error.code, 'GITHUB_NOT_CONNECTED');
  assert.equal((await ravi.post(`/student/github/tasks/${repoTask.id}/repository`, {})).status, 404, 'another student’s task looks missing');
  assert.equal((await asha.post(`/student/github/tasks/${textTask.id}/repository`, {})).data.error.code, 'REPOSITORY_NOT_ELIGIBLE');
  assert.equal((await asha.post('/student/github/tasks/STK-00000000/repository', {})).status, 404); assert.equal((await asha.post('/student/github/tasks/not-an-id/repository', {})).status, 404);
  assert.equal((await anon.post(`/student/github/tasks/${repoTask.id}/repository`, {})).status, 401);
  assert.equal(calls.filter((c) => c.method === 'POST' && /\/repos$/.test(c.path)).length, 0, 'nothing was sent to GitHub');
});

const orgRoutes = (over = {}) => {
  const files = new Set(); let created = 0;
  return { files, get created() { return created; }, routes: [
    ['POST', /api\.github\.com\/orgs\/elvora-org\/repos$/, (r) => { if (over.exists) return [422, { message: 'name already exists' }]; created++; return [201, { id: 9001, name: r.body.name, html_url: `https://github.com/elvora-org/${r.body.name}`, owner: { login: 'elvora-org' }, private: true, visibility: 'private', description: r.body.description }]; }],
    ['GET', /api\.github\.com\/repos\/elvora-org\/[^/]+$/, (r) => over.foreign ? [200, { id: 9001, name: 'x', html_url: 'x', owner: { login: 'elvora-org' }, description: 'somebody else' }] : [200, { id: 9001, name: r.path.split('/').pop(), html_url: `https://github.com${r.path.replace('/repos', '')}`, owner: { login: 'elvora-org' }, private: true, visibility: 'private', description: over.marker }]],
    ['PUT', /api\.github\.com\/repos\/elvora-org\/[^/]+\/contents\//, (r) => { const k = r.path; if (files.has(k)) return [422, { message: 'sha wasn’t supplied' }]; files.add(k); return [201, {}]; }],
    ['PUT', /api\.github\.com\/repos\/elvora-org\/[^/]+\/collaborators\//, () => over.collabFails ? [500, {}] : [201, {}]],
  ] };
};

test('repository creation: names, permissions, tokens, starter files, stored record and audit; second call is idempotent', async () => {
  const org = orgRoutes(); useMock(undefined, org.routes);
  const r = await asha.post(`/student/github/tasks/${repoTask.id}/repository`, {}); assert.equal(r.status, 201, JSON.stringify(r.data));
  const enr = db.prepare('SELECT enrollment_id FROM student_tasks WHERE id = ?').get(repoTask.id).enrollment_id;
  const listing = db.prepare('SELECT internship_id FROM github_repositories').get().internship_id.toLowerCase();
  const row = db.prepare('SELECT * FROM github_repositories').get();
  assert.match(row.name, new RegExp(`^elvora-${listing}-${enr.toLowerCase()}-marks-analysis-tool$`)); assert.equal(row.owner, 'elvora-org'); assert.equal(row.state, 'active'); assert.equal(row.github_repo_id, 9001);
  assert.equal(row.student_task_id, repoTask.id); assert.ok(row.internship_id && row.enrollment_id && row.student_id && row.created_at && row.url.startsWith('https://github.com/elvora-org/'));
  for (const bad of ['asha', 'example.com', '98765', 'Verma']) assert.ok(!row.name.toLowerCase().includes(bad.toLowerCase()) && !row.url.includes(bad), bad);
  const create = calls.find((c) => c.method === 'POST' && /\/orgs\/elvora-org\/repos$/.test(c.path));
  assert.equal(create.auth, `Bearer ${INST_TOKEN}`); assert.equal(create.body.private, true); assert.equal(create.body.visibility, 'private'); assert.equal(create.body.auto_init, false);
  const lookup = calls.find((c) => /\/orgs\/elvora-org\/installation/.test(c.path)); assert.match(lookup.auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, 'App JWT used only to find the installation');
  const jwt = lookup.auth.slice(7).split('.'); const claims = JSON.parse(Buffer.from(jwt[1], 'base64url')); assert.equal(claims.iss, '12345'); assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2], 'base64url')), 'JWT is signed with the App key');
  const collab = calls.find((c) => /\/collaborators\/asha-v$/.test(c.path)); assert.equal(collab.body.permission, 'push'); assert.equal(collab.auth, `Bearer ${INST_TOKEN}`);
  const put = calls.filter((c) => c.method === 'PUT' && /contents/.test(c.path)).map((c) => ({ p: decodeURIComponent(c.path.split('/contents/')[1]), body: Buffer.from(c.body.content, 'base64').toString() }));
  for (const f of ['README.md', '.gitignore', 'config.example.env', 'src/README.md', 'tests/README.md', 'docs/README.md']) assert.ok(put.find((x) => x.p === f), f);
  const readme = put.find((x) => x.p === 'README.md').body; assert.match(readme, /ELVORA internship assignment/); assert.match(readme, /Read a CSV file/); assert.match(readme, /Runs without errors/);
  for (const x of put) for (const bad of ['asha@example.com', 'password=', 'api_key', 'BEGIN PRIVATE KEY']) assert.ok(!x.body.includes(bad), `${x.p} contains ${bad}`);
  assert.ok(!put.some((x) => /\.(py|js)$/.test(x.p)), 'no solution code is shipped');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'github.repository_create' AND result = 'success' AND target_id = ?").get(repoTask.id));
  const before = calls.length; const again = await asha.post(`/student/github/tasks/${repoTask.id}/repository`, {});
  assert.equal(again.status, 200); assert.equal(again.data.created, false); assert.equal(org.created, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_repositories').get().n, 1);
  assert.equal(calls.slice(before).filter((c) => c.method === 'POST' && /repos$/.test(c.path)).length, 0);
  // the student can see it, without any token
  const view = await asha.get(`/student/github/tasks/${repoTask.id}/repository`); assert.equal(view.data.repository.state, 'active'); assert.ok(!JSON.stringify(view.data).includes(INST_TOKEN));
});

test('failed setup is recorded and a retry finishes the SAME repository without a duplicate; foreign or missing-installation cases are handled', async () => {
  db.prepare("UPDATE github_repositories SET state = 'creating'").run(); // simulate an interrupted first attempt
  db.prepare("UPDATE github_repositories SET state = 'active'").run();
  // new scenario on a fresh task row: delete our row, then fail at the collaborator step
  db.prepare('DELETE FROM github_repositories').run();
  const org = orgRoutes({ collabFails: true }); useMock(undefined, org.routes);
  const bad = await asha.post(`/student/github/tasks/${repoTask.id}/repository`, {}); assert.equal(bad.status, 502); assert.equal(bad.data.error.code, 'GITHUB_UNAVAILABLE');
  assert.ok(!JSON.stringify(bad.data).includes('Error:') && !JSON.stringify(bad.data).includes('at '), 'no stack trace');
  assert.equal(db.prepare('SELECT state FROM github_repositories').get().state, 'failed');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'github.repository_create' AND result = 'failure'").get());
  // retry: GitHub now says the name exists, and the existing repository carries OUR marker -> adopted
  const org2 = orgRoutes({ exists: true, marker: `ELVORA internship assignment [elvora:${repoTask.id}]` }); org2.files.add('x'); useMock(undefined, org2.routes);
  const ok = await asha.post(`/student/github/tasks/${repoTask.id}/repository`, {}); assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_repositories').get().n, 1); assert.equal(db.prepare('SELECT state FROM github_repositories').get().state, 'active');
  // a same-named repository that is NOT ours is never adopted
  db.prepare('DELETE FROM github_repositories').run();
  useMock(undefined, orgRoutes({ exists: true, foreign: true }).routes);
  const foreign = await asha.post(`/student/github/tasks/${repoTask.id}/repository`, {}); assert.equal(foreign.status, 409); assert.equal(foreign.data.error.code, 'REPOSITORY_EXISTS');
  // App not installed on the organisation
  db.prepare('DELETE FROM github_repositories').run(); G.appmod.resetAppCache();
  useMock(undefined, [['GET', /orgs\/elvora-org\/installation/, () => [404, {}]]]);
  const noInst = await asha.post(`/student/github/tasks/${repoTask.id}/repository`, {}); assert.equal(noInst.status, 503); assert.equal(noInst.data.error.code, 'GITHUB_INSTALLATION_MISSING');
  // GitHub API down / rate limited: clear messages, no internals
  db.prepare('DELETE FROM github_repositories').run(); G.appmod.resetAppCache();
  useMock(undefined, [['GET', /orgs\/elvora-org\/installation/, () => [403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }]]]);
  const rl = await asha.post(`/student/github/tasks/${repoTask.id}/repository`, {}); assert.equal(rl.status, 429); assert.equal(rl.data.error.code, 'GITHUB_RATE_LIMITED'); assert.ok(rl.data.error.details.retryAt);
  G.appmod.resetAppCache(); useMock(undefined, [['GET', /orgs\/elvora-org\/installation/, () => [503, {}]]]);
  const down = await asha.post(`/student/github/tasks/${repoTask.id}/repository`, {}); assert.equal(down.status, 502);
  assert.ok(calls.filter((c) => /installation$/.test(c.path)).length >= 3, 'temporary failures were retried');
  db.prepare('DELETE FROM github_repositories').run(); G.appmod.resetAppCache();
});

test('administrator: reads need an admin, writes need an admin SESSION (not the shared key); admin can create and the student is given access', async () => {
  const org = orgRoutes(); useMock(undefined, org.routes);
  assert.equal((await asha.post(`/admin/github/tasks/${repoTask.id}/repository`, {})).status, 403);
  assert.equal((await anon.post(`/admin/github/tasks/${repoTask.id}/repository`, {})).status, 401);
  const key = await anon.post(`/admin/github/tasks/${repoTask.id}/repository`, {}, { 'X-Admin-Key': 'k'.repeat(40) }); assert.ok([401, 403].includes(key.status), `shared key must not create repositories (${key.status})`);
  const ok = await admin.post(`/admin/github/tasks/${repoTask.id}/repository`, {}); assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.ok(calls.find((c) => /\/collaborators\/asha-v$/.test(c.path)));
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'github.repository_create' AND actor_type = 'admin'").get());
  const health = await admin.get('/admin/github/status?live=1'); assert.equal(health.status, 200); assert.equal(health.data.live.ok, true); assert.equal(health.data.configuration.app.ready, true);
  const text = JSON.stringify(health.data); for (const s of ['client-secret-value', 'PRIVATE KEY', WEBHOOK_SECRET, INST_TOKEN]) assert.ok(!text.includes(s), 'health never shows secret values');
  // missing GitHub App permission is reported
  G.appmod.resetAppCache(); useMock(undefined, [['GET', /orgs\/elvora-org\/installation/, () => [200, { id: 77, account: { login: 'elvora-org', type: 'Organization' }, permissions: { metadata: 'read' } }]]]);
  assert.deepEqual((await admin.get('/admin/github/status?live=1')).data.live.missingPermissions.sort(), ['administration:write', 'contents:write']);
  G.appmod.resetAppCache();
});

test('ownership verification: organisation repo needs write access for the student’s verified account; invitation pending stays unverified', async () => {
  useMock(undefined, [['GET', /collaborators\/asha-v\/permission/, () => [200, { permission: 'read', role_name: 'read' }]]]);
  let r = await asha.post(`/student/github/tasks/${repoTask.id}/repository/verify-ownership`, {}); assert.equal(r.status, 200); assert.equal(r.data.ownership.status, 'unverified');
  useMock(undefined, [['GET', /collaborators\/asha-v\/permission/, () => [200, { permission: 'write', role_name: 'write' }]]]);
  r = await asha.post(`/student/github/tasks/${repoTask.id}/repository/verify-ownership`, {}); assert.equal(r.data.ownership.status, 'verified'); assert.equal(r.data.repository.ownership.verifiedByGitHub, true);
  assert.equal((await ravi.post(`/student/github/tasks/${repoTask.id}/repository/verify-ownership`, {})).status, 404);
  assert.equal((await ravi.post(`/student/github/tasks/${ravisTask.id}/repository/verify-ownership`, {})).status, 404, 'no repository linked');
});

test('linking an existing repository: URL validation, organisation namespace blocked, GitHub lookups, ownership from GitHub only, duplicates blocked', async () => {
  const ravisCookie = globalThis.__cookies.cr;
  db.prepare('DELETE FROM github_repositories').run();
  for (const bad of ['', 'not a url', 'http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a']) { const r = await asha.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: bad }); assert.equal(r.status, 400, bad); }
  assert.equal((await asha.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: 'https://github.com/elvora-org/someone-elses' })).status, 403);
  useMock(undefined, [['GET', /repos\/asha-v\/private-thing$/, () => [404, {}]]]);
  const priv = await asha.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: 'https://github.com/asha-v/private-thing' }); assert.equal(priv.status, 404); assert.equal(priv.data.error.code, 'REPOSITORY_NOT_FOUND');
  // someone else's public repository: linkable as a manual URL, but ownership is NOT claimed
  useMock(undefined, [['GET', /repos\/other-dev\/cool-app$/, () => [200, { id: 42, name: 'cool-app', html_url: 'https://github.com/other-dev/cool-app', owner: { id: 777, login: 'other-dev', type: 'User' }, private: false, visibility: 'public' }]]]);
  let r = await asha.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: 'https://github.com/other-dev/cool-app', ownership: 'verified', source: 'organization', studentId: 'x' });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.repository.source, 'manual_url'); assert.equal(r.data.repository.ownership.status, 'unverified');
  const v = await asha.post(`/student/github/tasks/${repoTask.id}/repository/verify-ownership`, {}); assert.equal(v.data.ownership.status, 'not_owner');
  // Ravi cannot take the same repository for his own task
  const dup = await ravi.post(`/student/github/tasks/${ravisTask.id}/repository/link`, { repositoryUrl: 'https://github.com/OTHER-dev/cool-app' }); assert.equal(dup.status, 409); assert.equal(dup.data.error.code, 'DUPLICATE_REPOSITORY');
  // Asha's own repository: GitHub's owner id equals her verified account id -> student_owned + verified
  useMock(undefined, [['GET', /repos\/asha-v\/marks-tool$/, () => [200, { id: 43, name: 'marks-tool', html_url: 'https://github.com/asha-v/marks-tool', owner: { id: 1001, login: 'asha-v', type: 'User' }, private: false, visibility: 'public' }]]]);
  r = await asha.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: 'https://github.com/asha-v/marks-tool.git' }); assert.equal(r.status, 201);
  assert.equal(r.data.repository.source, 'student_owned'); assert.equal(r.data.repository.ownership.status, 'verified'); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM github_repositories WHERE state <> 'unlinked'").get().n, 1, 'the earlier link was replaced');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'github.repository_link'").get());
  void ravisCookie;
  // archived repositories are refused; unlink works
  useMock(undefined, [['GET', /repos\/asha-v\/old$/, () => [200, { id: 44, name: 'old', html_url: 'https://github.com/asha-v/old', owner: { id: 1001, login: 'asha-v', type: 'User' }, archived: true }]]]);
  assert.equal((await asha.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: 'https://github.com/asha-v/old' })).data.error.code, 'REPOSITORY_ARCHIVED');
  assert.equal((await asha.del(`/student/github/tasks/${repoTask.id}/repository/link`)).status, 200); assert.equal((await asha.get(`/student/github/tasks/${repoTask.id}/repository`)).data.repository, null);
});

const inspectRoutes = (over = {}) => [
  ['GET', /repos\/asha-v\/marks-tool$/, () => over.gone ? [404, {}] : [200, { id: 43, full_name: 'asha-v/marks-tool', name: 'marks-tool', html_url: 'https://github.com/asha-v/marks-tool', owner: { id: 1001, login: 'asha-v', type: 'User' }, private: false, visibility: 'public', default_branch: 'main', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', pushed_at: '2026-11-20T10:00:00Z', size: 12 }]],
  ['GET', /repos\/asha-v\/marks-tool\/readme/, () => [200, { encoding: 'base64', content: Buffer.from('# Marks tool\nDoes things.').toString('base64') }]],
  ['GET', /repos\/asha-v\/marks-tool\/languages/, () => [200, { Python: 4200 }]],
  ['GET', /repos\/asha-v\/marks-tool\/branches/, () => [200, [{ name: 'main' }, { name: 'dev' }]]],
  ['GET', /repos\/asha-v\/marks-tool\/commits/, () => over.rate ? [403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }] : [200, [{ sha: 'abcdef1234567', commit: { message: 'Add parser\n\nlong body', author: { date: '2026-11-19T10:00:00Z' } }, author: { login: 'asha-v' } }]]],
  ['GET', /repos\/asha-v\/marks-tool\/git\/trees/, () => [200, { truncated: false, tree: [{ type: 'blob', path: 'README.md' }, { type: 'blob', path: 'src/marks.py' }, { type: 'blob', path: 'tests/test_marks.py' }, { type: 'tree', path: 'src' }] }]],
];

test('inspection: GitHub-verified evidence is stored as a snapshot, separate from what the student typed; no tests are claimed; refresh appends', async () => {
  useMock(undefined, [['GET', /repos\/asha-v\/marks-tool$/, () => [200, { id: 43, name: 'marks-tool', html_url: 'https://github.com/asha-v/marks-tool', owner: { id: 1001, login: 'asha-v', type: 'User' }, private: false, visibility: 'public' }]]]);
  assert.equal((await asha.post(`/student/github/tasks/${repoTask.id}/repository/link`, { repositoryUrl: 'https://github.com/asha-v/marks-tool' })).status, 201);
  // the student's own typed submission link (user-provided data)
  db.prepare("UPDATE student_tasks SET status = 'In Progress' WHERE id = ?").run(repoTask.id);
  const sub = await asha.post(`/student/tasks/${repoTask.id}/submissions`, { description: 'I built the marks tool with a parser and tests for the module.', repositoryUrl: 'https://github.com/asha-v/marks-tool', repositoryDescription: 'Marks tool' });
  assert.ok([200, 201].includes(sub.status), JSON.stringify(sub.data));
  useMock(undefined, inspectRoutes());
  const r = await asha.post(`/student/github/tasks/${repoTask.id}/repository/inspect`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  const i = r.data.inspection; assert.equal(i.status, 'ok'); assert.ok(i.inspectedAt);
  const v = i.verifiedFromGitHub; assert.equal(v.repository.fullName, 'asha-v/marks-tool'); assert.equal(v.repository.visibility, 'public'); assert.equal(v.readme.present, true); assert.match(v.readme.content, /Marks tool/);
  assert.deepEqual(v.languages, { Python: 4200 }); assert.deepEqual(v.branches.names, ['main', 'dev']); assert.equal(v.commits.latest[0].message, 'Add parser'); assert.equal(v.commits.latest[0].sha, 'abcdef1'); assert.equal(v.commits.countIsExact, false);
  assert.equal(v.files.hasTestFiles, true); assert.equal(v.files.sourceFiles, 1); assert.equal(v.files.total, 3);
  assert.equal(i.testsExecuted, false); assert.ok(i.notes.some((n) => /not of project quality/.test(n)) && i.notes.some((n) => /Tests were not executed/.test(n)));
  assert.equal(i.userProvided.submittedRepositoryUrl, 'https://github.com/asha-v/marks-tool'); assert.equal(i.userProvided.matchesLinkedRepository, true);
  assert.ok(!('userProvided' in v), 'typed data is kept apart from verified data');
  assert.equal(calls.filter((c) => c.host !== 'api.github.com' && c.host !== 'github.com').length, 0); assert.ok(!calls.some((c) => /clone|\.git$|archive|zipball|tarball/.test(c.path)), 'code is never downloaded');
  await asha.post(`/student/github/tasks/${repoTask.id}/repository/inspect`, {}); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_repository_snapshots').get().n, 2, 'refresh appends a new snapshot');
  assert.throws(() => db.prepare("UPDATE github_repository_snapshots SET status = 'error'").run(), /append-only/);
  // no status is changed by inspection: nothing is approved automatically
  assert.equal(db.prepare('SELECT status FROM student_tasks WHERE id = ?').get(repoTask.id).status, 'Submitted');
  const read = await asha.get(`/student/github/tasks/${repoTask.id}/repository/inspection`); assert.equal(read.data.inspection.status, 'ok');
  assert.equal((await ravi.get(`/student/github/tasks/${repoTask.id}/repository/inspection`)).status, 404);
  assert.equal((await admin.get(`/admin/github/tasks/${repoTask.id}/repository`)).data.inspection.status, 'ok');
  assert.equal((await admin.post(`/admin/github/tasks/${repoTask.id}/repository/inspect`, {})).status, 200);
});

test('inspection failures: rate limit recorded and reported clearly; deleted repository is marked unavailable, not kept active', async () => {
  useMock(undefined, inspectRoutes({ rate: true }));
  const rl = await asha.post(`/student/github/tasks/${repoTask.id}/repository/inspect`, {}); assert.equal(rl.status, 429); assert.equal(rl.data.error.code, 'GITHUB_RATE_LIMITED');
  assert.equal(gh.latestSnapshot(gh.findRepoForTask(repoTask.id).id).status, 'rate_limited');
  useMock(undefined, inspectRoutes({ gone: true }));
  const gone = await asha.post(`/student/github/tasks/${repoTask.id}/repository/inspect`, {}); assert.equal(gone.status, 200); assert.equal(gone.data.inspection.status, 'not_found'); assert.equal(gone.data.repository.state, 'unavailable');
  useMock(undefined, inspectRoutes()); // the repository comes back
  const back = await asha.post(`/student/github/tasks/${repoTask.id}/repository/inspect`, {}); assert.equal(back.data.repository.state, 'active');
});

const hook = (event, payload, { id = crypto.randomUUID(), secret = WEBHOOK_SECRET, sig } = {}) => {
  const raw = Buffer.from(JSON.stringify(payload)); const s = sig ?? `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return fetch(`${srv.base}/github/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': id, ...(s ? { 'x-hub-signature-256': s } : {}) }, body: raw });
};
test('webhooks: signature is checked on the raw body first; duplicates are ignored; events only keep records truthful', async () => {
  assert.equal((await hook('ping', { zen: 'x' }, { sig: '' })).status, 401, 'missing signature');
  assert.equal((await hook('ping', { zen: 'x' }, { secret: 'wrong' })).status, 401, 'wrong secret');
  assert.equal((await hook('ping', { zen: 'x' }, { sig: 'sha256=' + 'a'.repeat(64) })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_webhook_events').get().n, 0, 'nothing is stored for an unsigned request');
  const id = crypto.randomUUID(); assert.equal((await hook('ping', { zen: 'ok' }, { id })).status, 200);
  assert.equal((await (await hook('ping', { zen: 'ok' }, { id })).json()).outcome, 'duplicate');
  const repo = gh.findRepoForTask(repoTask.id); gh.updateRepo(repo.id, { githubRepoId: 43, state: 'active' });
  assert.equal((await (await hook('repository', { action: 'deleted', repository: { id: 43, full_name: 'asha-v/marks-tool' } })).json()).outcome, 'unavailable:1'); assert.equal(gh.findRepoForTask(repoTask.id).state, 'unavailable');
  await hook('repository', { action: 'transferred', repository: { id: 43, name: 'marks-tool', owner: { login: 'new-owner' }, html_url: 'https://github.com/new-owner/marks-tool' } });
  assert.equal(gh.findRepoForTask(repoTask.id).owner, 'new-owner'); assert.equal(gh.findRepoForTask(repoTask.id).ownershipStatus, 'unverified');
  assert.equal((await (await hook('github_app_authorization', { action: 'revoked', sender: { id: 1001 } })).json()).outcome, 'revoked:1');
  const acct = db.prepare('SELECT * FROM github_accounts').get(); assert.equal(acct.verification_status, 'revoked'); assert.equal(acct.access_token_enc, null);
  const st = await asha.get('/student/github/status'); assert.equal(st.data.account.connected, false); assert.equal(st.data.account.status, 'authorization_revoked');
  assert.equal((await hook('push', { ref: 'refs/heads/main' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM student_tasks WHERE id = ?').get(repoTask.id).status, 'Submitted', 'a push never approves or changes a task');
  assert.equal((await hook('x'.repeat(80), {})).status, 400);
});

test('revoked authorization: GitHub features that need the student’s token ask them to reconnect; reconnecting works', async () => {
  useMock();
  const r = await asha.post(`/student/github/tasks/${repoTask.id}/repository/verify-ownership`, {}); assert.equal(r.status, 409); assert.equal(r.data.error.code, 'GITHUB_NOT_CONNECTED');
  const { ca } = globalThis.__cookies;
  const start = await (await fetch(`${srv.base}/student/github/connect`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ca }, body: '{}' })).json();
  const cb = await fetch(`${srv.base}/student/github/callback?code=good-code&state=${new URL(start.authorizeUrl).searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: ca } });
  assert.match(cb.headers.get('location'), /github=connected/); assert.equal(db.prepare('SELECT verification_status AS s FROM github_accounts').get().s, 'verified');
});

test('token refresh: an expired user token is refreshed with the stored refresh token; a failed refresh marks the authorization revoked', async () => {
  const { getUserToken } = await import('../src/github/oauth.js');
  const sid = db.prepare("SELECT id FROM students WHERE email='asha@example.com'").get().id;
  db.prepare('UPDATE github_accounts SET token_expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  useMock(undefined, [['POST', /login\/oauth\/access_token/, (r) => r.body.grant_type === 'refresh_token' && r.body.refresh_token === 'ghr_REFRESH' ? [200, { access_token: 'ghu_NEW', refresh_token: 'ghr_NEW', expires_in: 28800 }] : [200, { error: 'bad_refresh_token' }]]]);
  assert.equal(await getUserToken(sid), 'ghu_NEW'); assert.equal(G.crypto.decrypt(db.prepare('SELECT access_token_enc AS t FROM github_accounts').get().t), 'ghu_NEW');
  db.prepare('UPDATE github_accounts SET token_expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  useMock(undefined, [['POST', /login\/oauth\/access_token/, () => [200, { error: 'bad_refresh_token' }]]]);
  assert.equal(await getUserToken(sid), null); assert.equal(db.prepare('SELECT verification_status AS s FROM github_accounts').get().s, 'revoked');
});

test('disconnect: GitHub grant is revoked, local tokens deleted, ownership proofs reset, audited; the account can then be linked elsewhere', async () => {
  useMock(); const { ca, cr } = globalThis.__cookies;
  const start = await (await fetch(`${srv.base}/student/github/connect`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ca }, body: '{}' })).json();
  await fetch(`${srv.base}/student/github/callback?code=good-code&state=${new URL(start.authorizeUrl).searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: ca } });
  gh.updateRepo(gh.findRepoForTask(repoTask.id).id, { ownershipStatus: 'verified', ownershipVerifiedAt: new Date().toISOString(), state: 'active' });
  assert.equal((await anon.del('/student/github')).status, 401);
  assert.equal((await ravi.del('/student/github')).status, 404, 'Ravi has nothing to disconnect');
  const d = await asha.del('/student/github'); assert.equal(d.status, 200); assert.equal(d.data.revokedOnGitHub, true);
  const grant = calls.find((c) => c.method === 'DELETE' && /\/grant$/.test(c.path)); assert.match(grant.auth, /^Basic /); assert.ok(!JSON.stringify(d.data).includes(USER_TOKEN));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_accounts').get().n, 0); assert.equal(gh.findRepoForTask(repoTask.id).ownershipStatus, 'unverified');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'github.disconnect'").get());
  const s2 = await (await fetch(`${srv.base}/student/github/connect`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cr }, body: '{}' })).json();
  const cb = await fetch(`${srv.base}/student/github/callback?code=ravi-code&state=${new URL(s2.authorizeUrl).searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: cr } });
  assert.match(cb.headers.get('location'), /github=connected/, 'the GitHub account is free again after disconnect');
});

test('secrets: no token, key or secret appears in any log line or in any stored audit text', () => {
  for (const s of [USER_TOKEN, INST_TOKEN, 'ghr_REFRESH', 'client-secret-value', 'PRIVATE KEY', WEBHOOK_SECRET]) {
    assert.ok(!logs.some((l) => l.includes(s)), `log contains ${s.slice(0, 8)}…`);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()).includes(s), 'audit');
  }
});
