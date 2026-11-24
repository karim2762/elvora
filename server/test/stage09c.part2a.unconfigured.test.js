// Stage 09C Part 2A — with NO GitHub settings a project can still be submitted: it is stored as "pending verification", nothing is verified or simulated.
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

const body = { description: 'I built a marks analysis tool that reads a CSV and prints averages.', repositoryUrl: 'https://github.com/asha-v/marks-tool', implementedFeatures: 'CSV parsing and per-student averages.', testingPerformed: 'Manual runs with sample data.', challengesEncountered: 'Blank marks in the CSV.' };

test('GitHub not set up: submission is accepted as PENDING verification, never verified, and nothing is sent to GitHub', async () => {
  const r = await asha.post(`/student/github/tasks/${task.id}/submissions`, body);
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.submission.version, 1); assert.equal(r.data.checkedWithGitHub, false);
  assert.equal(r.data.verification.state, 'pending_verification'); assert.equal(r.data.assignment.submissionStatus, 'Submitted');
  const chk = db.prepare('SELECT state, reason FROM github_submission_checks').get(); assert.equal(chk.state, 'pending_verification'); assert.match(chk.reason, /not set up/);
  assert.equal(db.prepare('SELECT ownership_status FROM github_repositories').get().ownership_status, 'unverified');
  assert.deepEqual(outbound, []);
  assert.equal((await asha.post(`/student/github/tasks/${task.id}/submissions`, body)).data.error.code, 'AWAITING_REVIEW');
});

test('GitHub not set up: administrators see the stored submission with “pending verification”, no invented evidence, and refresh says setup is required', async () => {
  const d = await admin.get(`/admin/projects/${task.id}`); assert.equal(d.status, 200);
  assert.equal(d.data.github.configured, false); assert.equal(d.data.github.evidence, null); assert.equal(d.data.github.verification.state, 'pending_verification'); assert.equal(d.data.github.submissions[0].check.state, 'pending_verification');
  const r = await admin.post(`/admin/projects/${task.id}/github/refresh`, {}); assert.equal(r.status, 503); assert.equal(r.data.error.code, 'GITHUB_NOT_CONFIGURED');
  assert.equal((await admin.get('/admin/projects')).status, 200, 'the existing Stage 09B list is unaffected');
  assert.deepEqual(outbound, []);
});
