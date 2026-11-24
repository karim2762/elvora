// Stage 09D — audit tests that need NO network and NO HTTP server: GitHub is a MOCK injected with setFetch(), the database is in memory.
// Covers: OAuth state/PKCE/replay/expiry/duplicate/revocation/disconnect, token encryption and log redaction, webhook signature and replay,
// repository URL / SSRF validation, README sanitising, the task library, rejected-project repository lock, the completion gate and the
// Stage 09D indexes. Nothing here proves behaviour against the REAL github.com (see the manual checklist in the Stage 09D report).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SECRET = 'whsec-test-secret-value';
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: 'file::memory:', SESSION_SECRET: 'test-secret-test-secret-test-secret-1234', AUTOMATION_ENABLED: 'false', ADMIN_API_KEY: '',
  GITHUB_CLIENT_ID: 'Iv1.testclientid', GITHUB_CLIENT_SECRET: 'client-secret-do-not-log', GITHUB_CALLBACK_URL: 'http://localhost:5173/api/v1/student/github/callback',
  GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '', GITHUB_ORGANIZATION: '',
});
const { db } = await import('../src/db/index.js');
const students = await import('../src/db/students.js');
const gh = await import('../src/db/github.js');
const client = await import('../src/github/client.js');
const oauth = await import('../src/github/oauth.js');
const crypt = await import('../src/github/crypto.js');
const webhook = await import('../src/github/webhook.js');
const repos = await import('../src/github/repositories.js');
const naming = await import('../src/github/naming.js');
const { parseGitHubRepoUrl } = await import('../src/utils/github.js');
const { safeReadme } = await import('../src/services/githubProject.js');
const { TASK_LIBRARY } = await import('../src/tasks/library/index.js');
const { seedTaskLibrary } = await import('../src/services/taskLibrarySeed.js');
const { taskGate } = await import('../src/services/completionEligibility.js');
const enrollmentsDb = await import('../src/db/enrollments.js');

const now = new Date().toISOString();
let n = 0;
const mkStudent = (name) => {
  const s = students.createStudent({ fullName: name, email: `${name.replace(/\W/g, '').toLowerCase()}${++n}@example.com`, phone: '+91 98765 43210', passwordHash: 'x', college: 'IIT', degree: 'B.Tech', branch: 'CS', academicYear: '3rd Year', graduationYear: 2030, skills: [] });
  return students.findById(s.id);
};

// ---- a recording mock of github.com / api.github.com -------------------------------------------------------------------------------
const TOKEN = 'gho_SUPERSECRETTOKEN1234567890';
const calls = []; let ghUser = { id: 4242, login: 'asha-v', type: 'User' }; let tokenAnswer = { access_token: TOKEN, token_type: 'bearer' };
const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method: init.method, host: u.host, path: u.pathname, headers: init.headers, body });
  if (u.host === 'github.com' && u.pathname === '/login/oauth/access_token') return json(tokenAnswer);
  if (u.host === 'api.github.com' && u.pathname === '/user') return json(ghUser);
  if (u.host === 'api.github.com' && u.pathname.endsWith('/grant') && init.method === 'DELETE') return json(null, 204);
  return json({ message: 'Not Found' }, 404);
};
const logged = []; const orig = { log: console.log, error: console.error, warn: console.warn };
before(() => { client.setFetch(fakeFetch); client.setSleep(async () => {}); for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.map(String).join(' ')); });
after(() => { client.setFetch(null); client.setSleep(null); Object.assign(console, orig); });

const begin = (student) => { const { authorizeUrl } = oauth.beginConnect(student); return new URL(authorizeUrl).searchParams; };
const code = (fn) => { try { fn(); } catch (e) { return e.code ?? `${e.status}`; } return 'no error'; };
const codeAsync = async (fn) => { try { await fn(); } catch (e) { return e.code ?? `${e.status}`; } return 'no error'; };

// =================================================================================================================================
// OAuth: state, PKCE, replay, expiry, ownership, duplicates, revocation, disconnect, token protection
// =================================================================================================================================
test('oauth: authorize URL carries a random state and a PKCE S256 challenge; only a HASH of the state and an ENCRYPTED verifier are stored', () => {
  const asha = mkStudent('Asha Verma'); const q = begin(asha);
  assert.equal(q.get('code_challenge_method'), 'S256'); assert.ok(q.get('state').length >= 40); assert.equal(q.get('client_id'), 'Iv1.testclientid'); assert.equal(q.get('allow_signup'), 'false');
  const row = db.prepare('SELECT * FROM github_oauth_states WHERE student_id = ?').get(asha.id);
  assert.notEqual(row.state_hash, q.get('state')); assert.equal(row.state_hash, crypt.sha256(q.get('state')));
  assert.match(row.verifier_enc, /^v1\./); assert.equal(crypt.pkceChallenge(crypt.decrypt(row.verifier_enc)), q.get('code_challenge'));
  assert.equal(begin(asha).get('state') === q.get('state'), false, 'a new attempt replaces the old state');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_oauth_states WHERE student_id = ?').get(asha.id).n, 1);
});

test('oauth: invalid, foreign, replayed and expired states are refused; the state is single use even when the exchange fails', async () => {
  const asha = mkStudent('Asha Two'); const ravi = mkStudent('Ravi Kumar');
  assert.equal(await codeAsync(() => oauth.completeConnect(asha, { code: 'abc', state: 'short' })), 'GITHUB_STATE_INVALID');
  assert.equal(await codeAsync(() => oauth.completeConnect(asha, { code: 'abc', state: 'x'.repeat(60) })), 'GITHUB_STATE_INVALID');
  const stolen = begin(asha).get('state'); // another signed-in student replays asha's state
  assert.equal(await codeAsync(() => oauth.completeConnect(ravi, { code: 'abc', state: stolen })), 'GITHUB_STATE_INVALID');
  assert.equal(await codeAsync(() => oauth.completeConnect(asha, { code: 'abc', state: stolen })), 'GITHUB_STATE_INVALID', 'consumed by the first (failed) attempt');
  const old = crypt.randomToken(32); gh.insertState({ stateHash: crypt.sha256(old), studentId: asha.id, verifierEnc: crypt.encrypt('v'), expiresAt: Date.now() - 1 });
  assert.equal(await codeAsync(() => oauth.completeConnect(asha, { code: 'abc', state: old })), 'GITHUB_STATE_INVALID', 'expired');
  const s = begin(asha).get('state');
  assert.equal(await codeAsync(() => oauth.completeConnect(asha, { error: 'access_denied', state: s })), 'GITHUB_AUTH_DENIED');
  const s2 = begin(asha).get('state'); tokenAnswer = { error: 'bad_verification_code' };
  assert.equal(await codeAsync(() => oauth.completeConnect(asha, { code: 'nope', state: s2 })), 'GITHUB_CODE_REJECTED'); tokenAnswer = { access_token: TOKEN, token_type: 'bearer' };
  assert.ok(!gh.findAccount(asha.id), 'nothing was connected by any failed attempt');
});

test('oauth: a successful connection sends Accept: application/json and the PKCE verifier, stores the token ENCRYPTED, and never logs a secret', async () => {
  const asha = mkStudent('Asha Three'); const q = begin(asha); calls.length = 0;
  const r = await oauth.completeConnect(asha, { code: 'good-code', state: q.get('state') });
  assert.deepEqual(r, { ok: true, login: 'asha-v' });
  const ex = calls.find((c) => c.path === '/login/oauth/access_token');
  assert.equal(ex.headers.Accept, 'application/json', 'github.com answers form-encoded unless JSON is requested explicitly');
  assert.equal(crypt.pkceChallenge(ex.body.code_verifier), q.get('code_challenge')); assert.equal(ex.body.code, 'good-code');
  const raw = db.prepare('SELECT * FROM github_accounts WHERE student_id = ?').get(asha.id);
  assert.ok(!JSON.stringify(raw).includes(TOKEN), 'plaintext token is not in the database row'); assert.match(raw.access_token_enc, /^v1\./); assert.equal(crypt.decrypt(raw.access_token_enc), TOKEN);
  assert.equal(await oauth.getUserToken(asha.id), TOKEN);
  const view = JSON.stringify(oauth.accountView(asha.id)); assert.ok(!view.includes(TOKEN) && !/token/i.test(view), 'the view sent to the browser holds no token field');
  assert.ok(!JSON.stringify(gh.findAccount(asha.id)).includes('Enc'), 'the default reader never returns token columns');
  const audit = db.prepare("SELECT reason FROM audit_logs WHERE action = 'github.connect' AND target_id = ?").get(asha.id); assert.ok(audit && !audit.reason.includes(TOKEN));
  assert.ok(!logged.join('\n').includes(TOKEN) && !logged.join('\n').includes('client-secret-do-not-log'), 'no token or client secret reached console output');
  assert.equal(code(() => oauth.beginConnect(asha)), 'GITHUB_ALREADY_CONNECTED');
});

test('oauth: one GitHub account per ELVORA student; organization accounts are refused; revocation drops every token; disconnect revokes the grant and audits', async () => {
  const holder = mkStudent('Holder One'); const other = mkStudent('Other Two'); const third = mkStudent('Third Three');
  ghUser = { id: 5151, login: 'holder-one', type: 'User' }; // its own GitHub identity: other tests in this file already hold 4242
  await oauth.completeConnect(holder, { code: 'c', state: begin(holder).get('state') });
  assert.equal(await codeAsync(() => oauth.completeConnect(other, { code: 'c', state: begin(other).get('state') })), 'GITHUB_ACCOUNT_IN_USE');
  assert.ok(!gh.findAccount(other.id));
  ghUser = { id: 7, login: 'some-org', type: 'Organization' };
  assert.equal(await codeAsync(() => oauth.completeConnect(third, { code: 'c', state: begin(third).get('state') })), 'GITHUB_ACCOUNT_TYPE');
  ghUser = { id: 5151, login: 'holder-one', type: 'User' };
  assert.equal(gh.markRevoked(5151), 1);
  const rev = db.prepare('SELECT * FROM github_accounts WHERE student_id = ?').get(holder.id);
  assert.equal(rev.access_token_enc, null); assert.equal(rev.refresh_token_enc, null); assert.equal(oauth.accountView(holder.id).status, 'authorization_revoked'); assert.equal(await oauth.getUserToken(holder.id), null);
  await oauth.completeConnect(holder, { code: 'c', state: begin(holder).get('state') }); // same student reconnects after a revocation
  assert.equal(oauth.accountView(holder.id).status, 'connected');
  calls.length = 0; const d = await oauth.disconnect(holder);
  assert.deepEqual(d, { ok: true, revokedOnGitHub: true }); assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/grant') && c.headers.Authorization.startsWith('Basic ')));
  assert.ok(!gh.findAccount(holder.id)); assert.equal(await codeAsync(() => oauth.disconnect(holder)), 'GITHUB_NOT_CONNECTED');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'github.disconnect' AND target_id = ?").get(holder.id));
  ghUser = { id: 4242, login: 'asha-v', type: 'User' };
});

// =================================================================================================================================
// Token encryption
// =================================================================================================================================
test('crypto: AES-GCM round trip, random IV, tamper detection, garbage in -> null (never throws, never echoes)', () => {
  const a = crypt.encrypt('secret-value'); const b = crypt.encrypt('secret-value');
  assert.notEqual(a, b); assert.equal(crypt.decrypt(a), 'secret-value');
  const [v, iv, tag, ct] = a.split('.'); const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  for (const bad of [[v, iv, tag, flip(ct)], [v, iv, flip(tag), ct], [v, flip(iv), tag, ct], ['v2', iv, tag, ct]]) assert.equal(crypt.decrypt(bad.join('.')), null);
  for (const bad of [null, undefined, '', 'v1.a.b', 'plaintext-token', 42]) assert.equal(crypt.decrypt(bad), null);
});

// =================================================================================================================================
// Webhooks: signature, replay, malformed input
// =================================================================================================================================
const sign = (body, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
test('webhook: signature is verified over the RAW bytes with a constant-time compare; malformed headers are refused', () => {
  const raw = Buffer.from('{"action":"push"}');
  assert.equal(webhook.verifySignature(raw, sign(raw)), true);
  assert.equal(webhook.verifySignature(raw, sign(raw, 'wrong-secret')), false);
  assert.equal(webhook.verifySignature(Buffer.from('{"action":"push" }'), sign(raw)), false, 'one changed byte');
  for (const h of [undefined, '', 'sha256=', 'sha1=' + 'a'.repeat(40), 'sha256=' + 'z'.repeat(64), 'sha256=' + 'a'.repeat(63), sign(raw).toUpperCase().replace('SHA256', 'sha256').slice(0, 70)]) assert.equal(webhook.verifySignature(raw, h), false, String(h));
  assert.equal(webhook.verifySignature(raw.toString(), sign(raw)), false, 'a parsed/string body is not acceptable');
});

test('webhook: each delivery id is processed once (replay and duplicate), bad ids and payloads are refused, unknown repositories are ignored', () => {
  const d = crypto.randomUUID(); const payload = { action: 'pushed', ref: 'refs/heads/main', repository: { id: 999001, default_branch: 'main', full_name: 'a/b' } };
  assert.deepEqual(webhook.processEvent({ deliveryId: d, event: 'push', payload }), { status: 200, outcome: 'no_linked_repository' });
  assert.deepEqual(webhook.processEvent({ deliveryId: d, event: 'push', payload }), { status: 200, outcome: 'duplicate' });
  assert.equal(webhook.processEvent({ deliveryId: '../../etc/passwd', event: 'push', payload }).status, 400);
  assert.equal(webhook.processEvent({ deliveryId: crypto.randomUUID(), event: 'push', payload: [] }).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_webhook_events WHERE delivery_id = ?').get(d).n, 1);
});

// =================================================================================================================================
// URL validation (SSRF / look-alike hosts), README sanitising, naming
// =================================================================================================================================
test('repository URL: only https://github.com/<owner>/<repo>; credentials, ports, other hosts, look-alikes, sub-paths and reserved owners are refused', () => {
  const ok = parseGitHubRepoUrl('https://github.com/asha-v/marks-analyzer.git/');
  assert.deepEqual(ok.value, { url: 'https://github.com/asha-v/marks-analyzer', owner: 'asha-v', repo: 'marks-analyzer' });
  assert.equal(parseGitHubRepoUrl('').value, null);
  for (const bad of ['http://github.com/a/b', 'https://user:pw@github.com/a/b', 'https://github.com:8443/a/b', 'https://github.com.evil.com/a/b', 'https://evil.com/github.com/a/b', 'https://github.com@evil.com/a/b',
    'https://127.0.0.1/a/b', 'https://localhost/a/b', 'https://[::1]/a/b', 'https://api.github.com/repos/a/b', 'https://raw.githubusercontent.com/a/b', 'https://github.com/a', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?tab=readme', 'https://github.com/a/b#x',
    'https://github.com/settings/profile', 'https://github.com/-a/b', 'https://github.com/a--b/c', 'https://github.com/a/..', 'https://github.com/a/%2e%2e', 'ftp://github.com/a/b', 'javascript:alert(1)', 'https://github.com/' + 'a'.repeat(40) + '/b', 'https://github.com/a/' + 'b'.repeat(101)])
    assert.ok(parseGitHubRepoUrl(bad).error, `must refuse ${bad}`);
});

test('README is untrusted: plain text only, control and bidi-override characters removed, length capped, HTML left as inert text', () => {
  const r = safeReadme({ present: true, truncated: false, content: '# T\u0000itle\r\n<script>alert(1)</script>\u202eevil\u2066x\u0007' + 'a'.repeat(7000) });
  assert.equal(r.format, 'plain_text'); assert.ok(!/[\u0000-\u0008\u202a-\u202e\u2066-\u2069]/.test(r.text)); assert.equal(r.text.length, 6000); assert.equal(r.truncated, true); assert.ok(r.text.startsWith('# Title\n<script>'));
  assert.deepEqual(safeReadme(null), { present: false, format: 'plain_text', text: '', truncated: false });
});

test('repository names contain only public identifiers and are GitHub-safe', () => {
  const name = naming.repositoryName({ internshipId: 'ELV-PY-001', enrollmentId: 'ELV-7K3Q9XMD', title: 'Marks Analyzer: “Pro” <script> édition!', studentTaskId: 'STK-AB12CD34' });
  assert.match(name, naming.REPO_NAME_RE); assert.ok(name.length <= 100); assert.ok(name.startsWith('elvora-elv-py-001-elv-7k3q9xmd-'));
  assert.ok(naming.repositoryName({ internshipId: 'x', enrollmentId: 'y', title: 't'.repeat(300), studentTaskId: 'STK-AB12CD34', disambiguate: true }).length <= 100);
});

// =================================================================================================================================
// Task library quality (the published library, not a fixture)
// =================================================================================================================================
test('task library: 12 categories x (1 foundation + 3 mini + 1 final), every project complete, rubrics total 100, IDs unique, and the whole library passes the real validator', () => {
  assert.equal(TASK_LIBRARY.length, 60); assert.equal(new Set(TASK_LIBRARY.map((t) => t.id)).size, 60); assert.equal(new Set(TASK_LIBRARY.map((t) => t.title.toLowerCase())).size, 60);
  const cats = Object.groupBy(TASK_LIBRARY, (t) => t.category); assert.equal(Object.keys(cats).length, 12);
  for (const [cat, list] of Object.entries(cats)) assert.deepEqual(['Practical Assignment', 'Mini Project', 'Mini Project', 'Mini Project', 'Final Project'].sort(), list.map((t) => t.taskType).sort(), cat);
  for (const t of TASK_LIBRARY.filter((x) => x.taskType !== 'Practical Assignment')) {
    const c = t.content;
    for (const k of ['problemStatement', 'features', 'technicalRequirements', 'folderStructure', 'steps', 'testingRequirements', 'acceptanceCriteria', 'rubric', 'expectedOutput', 'submissionRequirements', 'completionChecklist']) assert.ok(c[k] && c[k].length > 0, `${t.key}: ${k}`);
    assert.equal(c.rubric.reduce((a, r) => a + r.weight, 0), 100, t.key); assert.ok(c.features.length >= 5 && c.steps.length >= 5 && c.testingRequirements.length >= 2, t.key);
    assert.ok(t.learningObjectives.length >= 2, t.key); assert.ok(/readme/i.test(JSON.stringify(c.completionChecklist)), `${t.key}: README required`);
    if (t.taskType === 'Final Project') assert.ok(t.estimatedHours >= 30 && t.estimatedHours <= 40, `${t.key} ${t.estimatedHours}h`);
    if (t.minDurationDays) assert.ok(t.estimatedHours / t.minDurationDays <= 3, `${t.key}: ${t.estimatedHours}h in ${t.minDurationDays} days`);
  }
  assert.deepEqual(seedTaskLibrary(), { inserted: 60, existing: 0, total: 60 }); assert.deepEqual(seedTaskLibrary(), { inserted: 0, existing: 60, total: 60 }, 'seeding is idempotent');
});

test('task library: the cloud track can be finished at zero cost without a payment card (a no-card option is listed first; card-based providers are optional)', () => {
  for (const t of TASK_LIBRARY.filter((x) => x.category === 'cloud-computing')) {
    const tools = t.content.tools.join(' | '); assert.match(tools, /no card/i, t.key); assert.match(tools, /Optional: AWS/i, t.key);
    assert.match(JSON.stringify(t.content.technicalRequirements ?? t.content.steps), /card|zero cost|free/i, t.key);
  }
});

// =================================================================================================================================
// Rejected projects, completion gate, indexes (database-level)
// =================================================================================================================================
let seq = 0;
function seedAssignment({ taskType = 'Mini Project', required = 1, stStatus = 'Assigned', projectStatus = null, withTask = true } = {}) {
  const student = mkStudent('Seed Student'); const k = ++seq;
  const lid = `ELV-D-${k}`; const aid = `ELV-APP-D${k}`; const eid = `ELV-INT-D${k}`; const stid = `STK-D00000${String(k).padStart(2, '0')}`;
  const tid = `TSK-D00000${String(k).padStart(2, '0')}`;
  db.prepare(`INSERT INTO internship_listings (id, title, category, description, duration_days, type, difficulty, created_at, updated_at) VALUES (?, ?, 'python-development', 'd', 30, 'Project-Based', 'Beginner', ?, ?)`).run(lid, `L ${lid}`, now, now);
  db.prepare(`INSERT INTO applications (id, student_id, internship_id, internship_title, internship_category, internship_duration_days, full_name, email, phone, college, degree, branch, academic_year, motivation, terms_accepted_at, status, submitted_at, updated_at)
    VALUES (?, ?, ?, ?, 'python-development', 30, ?, ?, '1', 'c', 'd', 'b', 'y', 'm', ?, 'Approved', ?, ?)`).run(aid, student.id, lid, `L ${lid}`, student.fullName, student.email, now, now, now);
  db.prepare("INSERT INTO enrollments (id, application_id, student_id, status, created_at, updated_at) VALUES (?, ?, ?, 'Active', ?, ?)").run(eid, aid, student.id, now, now);
  if (withTask) {
    db.prepare(`INSERT INTO internship_tasks (id, internship_id, title, short_description, difficulty, task_type, submission_type, sequence, is_required, is_published, created_at, updated_at) VALUES (?, ?, 'Marks analysis', 's', 'Beginner', ?, 'repository', 1, ?, 1, ?, ?)`).run(tid, lid, taskType, required, now, now);
    db.prepare('INSERT INTO student_tasks (id, enrollment_id, student_id, task_id, is_required, status, project_status, assigned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(stid, eid, student.id, tid, required, stStatus, projectStatus, now, now);
  }
  return { student, eid, stid, lid };
}

test('rejected project: stored as Changes Requested + Rejected, it can NOT create, link or unlink a repository (final decision); a normal open task still can', async () => {
  const open = seedAssignment(); assert.deepEqual(repos.eligibilityFor(open.stid, open.student), { eligible: true });
  const rej = seedAssignment({ stStatus: 'Changes Requested', projectStatus: 'Rejected' });
  const el = repos.eligibilityFor(rej.stid, rej.student); assert.equal(el.eligible, false); assert.match(el.reason, /rejected/i);
  assert.equal(await codeAsync(() => repos.linkRepository(rej.student, rej.stid, { repositoryUrl: 'https://github.com/asha-v/x' }, { offline: true })), 'REPOSITORY_NOT_ELIGIBLE');
  gh.insertRepo({ studentTaskId: rej.stid, studentId: rej.student.id, enrollmentId: rej.eid, internshipId: rej.lid, source: 'manual_url', owner: 'asha-v', name: 'x', url: 'https://github.com/asha-v/x', state: 'active' });
  assert.equal(code(() => repos.unlinkRepository(rej.student, rej.stid)), 'REPOSITORY_NOT_ELIGIBLE'); assert.ok(gh.findRepoForTask(rej.stid), 'the evaluated repository stays linked');
  const changes = seedAssignment({ stStatus: 'Changes Requested' }); assert.equal(repos.eligibilityFor(changes.stid, changes.student).eligible, true, 'ordinary change requests may still update their repository');
  const other = mkStudent('Someone Else'); assert.equal(code(() => repos.eligibilityFor(open.stid, other)), 'TASK_NOT_FOUND', "another student's task is a plain 404");
});

test('completion gate: only an APPROVED required task satisfies it; submitted, changes requested and rejected never do; no task plan keeps the old behaviour', () => {
  const gate = (a) => taskGate(enrollmentsDb.findById(a.eid));
  for (const [label, a] of [['assigned', seedAssignment()], ['submitted', seedAssignment({ stStatus: 'Submitted' })], ['under review', seedAssignment({ stStatus: 'Submitted', projectStatus: 'Under Review' })],
    ['changes requested', seedAssignment({ stStatus: 'Changes Requested' })], ['rejected', seedAssignment({ stStatus: 'Changes Requested', projectStatus: 'Rejected' })]]) {
    const g = gate(a); assert.equal(g.blocking, true, label); assert.equal(g.code, 'TASKS_INCOMPLETE');
  }
  assert.equal(gate(seedAssignment({ stStatus: 'Approved' })).blocking, false, 'approved');
  assert.equal(gate(seedAssignment({ required: 0, stStatus: 'Assigned' })).blocking, false, 'only optional work is open');
  const none = seedAssignment({ withTask: false }); const g = gate(none); assert.equal(g.blocking, false); assert.equal(g.evaluation.checks[0].status, 'not_applicable', 'internships without tasks behave exactly as before');
  const final = seedAssignment({ taskType: 'Final Project', stStatus: 'Approved' }); db.prepare("INSERT INTO internship_criteria (internship_id, kind, config, updated_at) VALUES (?, 'completion', ?, ?)").run(final.lid, JSON.stringify({ requiredTasksApprovedPercent: 100, requireFinalProject: true }), now);
  assert.equal(gate(final).blocking, false, 'final project approved');
});

test('database: Stage 09D indexes exist and the webhook / checks lookups use them instead of scanning', () => {
  const plan = (sql, ...a) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a).map((r) => r.detail).join(' ');
  assert.match(plan("SELECT * FROM github_repositories WHERE github_repo_id = ? AND state <> 'unlinked'", 1), /idx_github_repos_github_id/);
  assert.match(plan('SELECT * FROM github_submission_checks WHERE student_task_id = ?', 'x'), /idx_github_checks_student_task/);
  assert.ok(db.pragma('user_version', { simple: true }) >= 20); assert.equal(db.pragma('foreign_key_check').length, 0); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});
