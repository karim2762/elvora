// Stage 09C Part 1 — with NO GitHub settings the application stays fully usable and every GitHub feature says "setup required" honestly:
// nothing is simulated, no request is sent to GitHub, and manual repository links are stored as UNVERIFIED.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let srv, db, admin, asha, anon, task, outbound;

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: 'k'.repeat(40), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000', RATE_LIMIT_TASK_SUBMIT_MAX: '1000',
    GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GITHUB_ORGANIZATION: '', GITHUB_CALLBACK_URL: '', GITHUB_WEBHOOK_SECRET: '',
    ORG_ADDRESS: '12 Example Road', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Gowtham', ORG_SIGNATORY_TITLE: 'CEO' });
  ({ db } = await import('../src/db/index.js'));
  outbound = []; (await import('../src/github/client.js')).setFetch(async (u) => { outbound.push(String(u)); throw new Error('network must not be used'); });
  [anon, admin, asha] = [1, 2, 3].map(() => client(srv.base));
  await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }));
  const { findByEmail, setRole } = await import('../src/db/students.js'); setRole(findByEmail('boss@example.com').id, 'admin');
  await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW });
  const l = await admin.post('/admin/internship-listings', { title: 'Python Tasks Internship', category: 'python-development', description: 'A listing used by the Stage 09C tests.', durationDays: 30, skills: ['Python'], outcomes: ['Build a small Python project'], eligibility: { who: 'Any student' }, type: 'Project-Based', difficulty: 'Beginner' });
  await admin.patch(`/admin/internship-listings/${l.data.internship.id}/state`, { action: 'publish' });
  const content = { objective: 'Build a small tool.', background: 'Practice.', tools: ['Python 3'], steps: ['Plan the tool on paper first.', 'Build the tool step by step.'], expectedOutput: 'A working tool.', submissionRequirements: 'Share your repository link.' };
  const t = await admin.post(`/admin/internship-listings/${l.data.internship.id}/tasks`, { category: 'python-development', title: 'Marks analysis tool', shortDescription: 'Read a CSV of marks and print averages.', difficulty: 'Beginner', taskType: 'Mini Project', submissionType: 'repository', estimatedHours: 6, learningObjectives: ['Read a CSV file'], requiredSkills: ['Python basics'], deliverables: ['marks.py'], evaluationCriteria: ['Runs without errors'], resources: [], content, publish: true });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  await asha.post('/auth/register', validStudent());
  const a = await asha.post('/applications', validApplication({ internshipId: l.data.internship.id }));
  await admin.patch(`/admin/applications/${a.data.application.id}/status`, { status: 'Approved' });
  const e = await admin.post(`/admin/applications/${a.data.application.id}/internship`, { startDate: day(-1) });
  await admin.patch(`/admin/internships/${e.data.internship.id}/activate`, { startDate: day(-1) });
  task = db.prepare('SELECT id FROM student_tasks WHERE enrollment_id = ?').get(e.data.internship.id);
});
after(() => srv.close());

test('setup-required state: students and administrators are told plainly; nothing is configured, nothing is sent to GitHub', async () => {
  const s = await asha.get('/student/github/status'); assert.equal(s.status, 200);
  assert.deepEqual(s.data.integration, { state: 'setup_required', canConnectAccount: false, canCreateRepositories: false }); assert.equal(s.data.account.connected, false);
  const h = await admin.get('/admin/github/status?live=1'); assert.equal(h.data.state, 'setup_required'); assert.ok(h.data.configuration.app.missing.includes('GITHUB_APP_PRIVATE_KEY')); assert.ok(h.data.configuration.oauth.missing.includes('GITHUB_CLIENT_SECRET')); assert.equal(h.data.live.ok, false);
  for (const [p, body] of [['/student/github/connect', {}], [`/student/github/tasks/${task.id}/repository`, {}], [`/student/github/tasks/${task.id}/repository/verify-ownership`, {}], [`/student/github/tasks/${task.id}/repository/inspect`, {}]]) {
    const r = await asha.post(p, body); assert.ok([503, 404].includes(r.status), `${p} -> ${r.status}`); if (r.status === 503) assert.equal(r.data.error.code, 'GITHUB_NOT_CONFIGURED');
  }
  assert.equal((await asha.post(`/student/github/tasks/${task.id}/repository`, {})).status, 503);
  const hook = await fetch(`${srv.base}/github/webhook`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64), 'x-github-event': 'ping', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(hook.status, 503);
  assert.deepEqual(outbound, []);
});

test('the app stays usable: a typed repository link is stored as UNVERIFIED and says it was not checked with GitHub; no verification is claimed', async () => {
  const bad = await asha.post(`/student/github/tasks/${task.id}/repository/link`, { repositoryUrl: 'https://example.com/a/b' }); assert.equal(bad.status, 400);
  const ok = await asha.post(`/student/github/tasks/${task.id}/repository/link`, { repositoryUrl: 'https://github.com/asha-v/marks-tool' });
  assert.equal(ok.status, 201); assert.equal(ok.data.checkedWithGitHub, false); assert.equal(ok.data.repository.source, 'manual_url'); assert.equal(ok.data.repository.ownership.status, 'unverified'); assert.equal(ok.data.repository.ownership.verifiedByGitHub, false);
  const v = await asha.get(`/student/github/tasks/${task.id}/repository`); assert.equal(v.data.integration.state, 'setup_required'); assert.equal(v.data.repository.lastInspection, null);
  assert.equal((await anon.get(`/student/github/tasks/${task.id}/repository`)).status, 401);
  assert.equal((await asha.get('/student/tasks')).status, 200); // existing task API unaffected
  assert.deepEqual(outbound, []);
});
