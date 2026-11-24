// Stage 09B (Part 2B) — administrator project evaluation over real HTTP: authorization, validation, the full decision journey, student visibility and regression of 2A rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';
import { parseGitHubRepoUrl } from '../src/utils/github.js';

const PW = 'Str0ng!Pass1';
const ORG = { ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Gowtham', ORG_SIGNATORY_TITLE: 'Chief Executive Officer (CEO)' };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let srv, dir, db, admin, asha, ravi, anon, repoTask, textTask, ravisTask;

const content = { objective: 'Build a marks analysis script that reads a CSV and prints a summary.', background: 'Students often keep marks in spreadsheets. This task turns them into a small report.', tools: ['Python 3'],
  steps: ['Create a CSV file with five students.', 'Read the file with the csv module.', 'Print each average.'], expectedOutput: 'A script that prints averages.', submissionRequirements: 'Share your repository link.' };
const tpl = (over = {}) => ({ category: 'python-development', title: 'Student marks analysis', shortDescription: 'Read a CSV of marks and print averages.', difficulty: 'Beginner', taskType: 'Practical Assignment', submissionType: 'repository',
  estimatedHours: 6, learningObjectives: ['Read a CSV file'], requiredSkills: ['Python basics'], deliverables: ['marks.py'], evaluationCriteria: ['Runs without errors'], resources: [], content, ...over });
const enroll = async (c, email, name, listing) => {
  await c.post('/auth/register', validStudent({ email, fullName: name }));
  const a = await c.post('/applications', validApplication({ internshipId: listing, fullName: name })); assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal((await admin.patch(`/admin/applications/${a.data.application.id}/status`, { status: 'Approved' })).status, 200);
  const e = await admin.post(`/admin/applications/${a.data.application.id}/internship`, { startDate: day(-1) }); assert.equal(e.status, 201);
  assert.equal((await admin.patch(`/admin/internships/${e.data.internship.id}/activate`, { startDate: day(-1) })).status, 200);
  return e.data.internship.id;
};
const rows = (enr) => db.prepare('SELECT st.id, t.title FROM student_tasks st JOIN internship_tasks t ON t.id = st.task_id WHERE st.enrollment_id = ? ORDER BY t.sequence').all(enr);
const good = { description: 'I read the CSV and printed averages for each student, with tests.', repositoryUrl: 'https://github.com/asha-v/marks-analysis', repositoryDescription: 'Marks analysis script with unit tests', documentationUrl: 'https://asha-v.github.io/marks-analysis/', submissionNotes: 'Run python marks.py' };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-09b2b-'));
  srv = await startServer({ ADMIN_API_KEY: 'k'.repeat(40), DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000', RATE_LIMIT_TASK_SUBMIT_MAX: '1000', ...ORG });
  ({ db } = await import('../src/db/index.js'));
  [anon, admin, asha, ravi] = [1, 2, 3, 4].map(() => client(srv.base));
  assert.equal((await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  const l = await admin.post('/admin/internship-listings', { title: 'Python Tasks Internship', category: 'python-development', description: 'A listing used by the Stage 09B Part 2A tests.', durationDays: 30, skills: ['Python'], outcomes: ['Build a small Python project'], eligibility: { who: 'Any student' }, type: 'Project-Based', difficulty: 'Beginner' });
  assert.equal((await admin.patch(`/admin/internship-listings/${l.data.internship.id}/state`, { action: 'publish' })).status, 200);
  const lid = l.data.internship.id;
  assert.equal((await admin.post(`/admin/internship-listings/${lid}/tasks`, { ...tpl(), publish: true })).status, 201);
  assert.equal((await admin.post(`/admin/internship-listings/${lid}/tasks`, { ...tpl({ title: 'Reading notes', submissionType: 'text' }), publish: true })).status, 201);
  const ae = await enroll(asha, 'asha@example.com', 'Asha Verma', lid); const re = await enroll(ravi, 'ravi@example.com', 'Ravi Kumar', lid);
  [repoTask, textTask] = rows(ae); [ravisTask] = rows(re);
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const ALL = { functional: 8, code_quality: 7.5, technical: 9, testing: 6, documentation: 10, repository: 5 };
const P = (id) => `/admin/projects/${id}`;

test('authorization: nobody signed in → 401, students → 403 on EVERY evaluation endpoint, shared key may read but never write', async () => {
  const calls = [['get', '/admin/projects'], ['get', '/admin/projects/options'], ['get', P(repoTask.id)], ['post', `${P(repoTask.id)}/start-review`, {}], ['put', `${P(repoTask.id)}/evaluation`, { scores: ALL }], ['post', `${P(repoTask.id)}/decision`, { decision: 'Approved', confirm: true }]];
  for (const [m, path, body] of calls) {
    assert.equal((await anon[m](path, body)).status, 401, `anon ${m} ${path}`);
    assert.equal((await asha[m](path, body)).status, 403, `student ${m} ${path}`);
  }
  const key = { 'X-Admin-Key': 'k'.repeat(40) };
  const keyHdr = (m, p, b) => fetch(srv.base + p, { method: m, headers: { 'Content-Type': 'application/json', ...key }, body: b ? JSON.stringify(b) : undefined });
  assert.equal((await keyHdr('GET', '/admin/projects')).status, 200);
  assert.equal((await keyHdr('POST', `/admin/projects/${repoTask.id}/decision`, { decision: 'Approved', confirm: true })).status, 401); // a write needs a real administrator session
});

test('students cannot approve themselves or change scores through any student route (extra fields are ignored)', async () => {
  const r = await asha.post(`/student/tasks/${repoTask.id}/submissions`, { ...good, status: 'Approved', score: 100, decision: 'Approved', projectStatus: 'Rejected', scores: ALL }); assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.assignment.submissionStatus, 'Submitted');
  const row = db.prepare('SELECT status, project_status FROM student_tasks WHERE id = ?').get(repoTask.id); assert.equal(row.status, 'Submitted'); assert.equal(row.project_status, null);
  assert.equal((await asha.patch(`/student/tasks/${repoTask.id}`, { status: 'Approved' })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM project_evaluations').get().n, 0);
});

test('admin list and detail: filters, search, new/resubmission flags, links, notes, verification warning', async () => {
  const l = await admin.get('/admin/projects'); assert.equal(l.status, 200);
  const item = l.data.submissions.find((s) => s.id === repoTask.id); assert.ok(item); assert.equal(item.status, 'Submitted'); assert.equal(item.isNew, true); assert.equal(item.repositoryUrl, 'https://github.com/asha-v/marks-analysis');
  assert.equal((await admin.get('/admin/projects?category=python-development&status=Submitted')).data.submissions.length, 1);
  assert.equal((await admin.get('/admin/projects?category=java-development')).data.submissions.length, 0);
  assert.equal((await admin.get(`/admin/projects?taskId=${item.task.id}`)).data.submissions.length, 1);
  assert.equal((await admin.get(`/admin/projects?studentId=${item.student.id}`)).data.submissions.length, 1);
  assert.equal((await admin.get('/admin/projects?q=marks-analysis')).data.submissions.length, 1);
  assert.equal((await admin.get('/admin/projects?q=nothing-matches-this')).data.submissions.length, 0);
  assert.equal((await admin.get('/admin/projects?status=Bogus')).status, 400);
  const d = await admin.get(P(repoTask.id)); assert.equal(d.status, 200);
  assert.equal(d.data.latestSubmission.submissionNotes, 'Run python marks.py'); assert.equal(d.data.latestSubmission.documentationUrl, 'https://asha-v.github.io/marks-analysis/');
  assert.match(d.data.verificationNotice, /NOT been verified/); assert.equal(d.data.rubric.criteria.length, 6);
  assert.equal((await admin.get('/admin/projects/STK-FFFFFFFF')).status, 404); assert.equal((await admin.get('/admin/projects/not-an-id')).status, 404);
  assert.equal(d.headers?.get?.('cache-control') ?? 'no-store', 'no-store');
});

test('evaluation journey over HTTP: review → invalid scores → draft → edit → incomplete → changes requested → resubmit → approve', async () => {
  assert.equal((await admin.post(`${P(repoTask.id)}/start-review`, {})).data.submission.status, 'Under Review');
  assert.equal((await asha.get(`/student/tasks/${repoTask.id}`)).data.assignment.submissionStatus, 'Under Review');
  const badScores = await admin.put(`${P(repoTask.id)}/evaluation`, { scores: { functional: 11, testing: -1 } });
  assert.equal(badScores.status, 400); assert.ok(badScores.data.error.fields.functional && badScores.data.error.fields.testing);
  const d1 = await admin.put(`${P(repoTask.id)}/evaluation`, { scores: { functional: 8 }, feedback: 'Please add tests for empty input.' });
  assert.equal(d1.status, 200); assert.equal(d1.data.draft.weightedTotal, null);
  const incomplete = await admin.post(`${P(repoTask.id)}/decision`, { decision: 'Changes Requested', confirm: true });
  assert.equal(incomplete.status, 400); assert.ok(incomplete.data.error.fields.scores);
  const d2 = await admin.put(`${P(repoTask.id)}/evaluation`, { scores: ALL });
  assert.equal(d2.data.draft.id, d1.data.draft.id); assert.equal(d2.data.draft.calculation.total, 78);
  assert.equal((await asha.get(`/student/tasks/${repoTask.id}`)).data.evaluations.length, 0); // drafts are private to administrators
  const cr = await admin.post(`${P(repoTask.id)}/decision`, { decision: 'Changes Requested', confirm: true });
  assert.equal(cr.status, 200, JSON.stringify(cr.data)); assert.equal(cr.data.submission.status, 'Changes Requested');
  // the student sees status, score breakdown and feedback
  const v = (await asha.get(`/student/tasks/${repoTask.id}`)).data;
  assert.equal(v.assignment.submissionStatus, 'Changes Requested'); assert.equal(v.evaluations.length, 1); assert.equal(v.evaluations[0].weightedTotal, 78); assert.match(v.evaluations[0].feedback, /empty input/);
  assert.equal(v.submission.canSubmit, true);
  // resubmission → Resubmitted → review again → approve
  assert.equal((await asha.post(`/student/tasks/${repoTask.id}/submissions`, { ...good, description: 'Added tests for empty input and an error path.' })).status, 201);
  assert.equal((await admin.get(P(repoTask.id))).data.submission.status, 'Resubmitted');
  assert.equal((await admin.get('/admin/projects?status=Resubmitted')).data.submissions.length, 1);
  await admin.post(`${P(repoTask.id)}/start-review`, {});
  assert.equal((await admin.put(`${P(repoTask.id)}/evaluation`, { scores: { ...ALL, functional: 10 } })).data.draft.submissionVersion, 2);
  const ok = await admin.post(`${P(repoTask.id)}/decision`, { decision: 'Approved', confirm: true });
  assert.equal(ok.status, 200); assert.equal(ok.data.submission.status, 'Approved'); assert.equal(ok.data.previousEvaluations.length, 2);
  assert.equal((await admin.post(`${P(repoTask.id)}/decision`, { decision: 'Rejected', feedback: 'trying to flip it', confirm: true })).status, 409);
  assert.equal((await asha.get(`/student/tasks/${repoTask.id}`)).data.assignment.submissionStatus, 'Approved');
  assert.throws(() => db.prepare("UPDATE project_evaluations SET weighted_total = 1 WHERE status = 'Final'").run(), /immutable/);
});

test('rejection over HTTP needs feedback, blocks resubmission, and only the owning student can read the feedback', async () => {
  assert.equal((await ravi.post(`/student/tasks/${ravisTask.id}/submissions`, { ...good, repositoryUrl: 'https://github.com/ravi-k/marks' })).status, 201);
  await admin.put(`${P(ravisTask.id)}/evaluation`, { scores: ALL });
  const noFeedback = await admin.post(`${P(ravisTask.id)}/decision`, { decision: 'Rejected', confirm: true }); assert.equal(noFeedback.status, 400); assert.ok(noFeedback.data.error.fields.feedback);
  const rej = await admin.post(`${P(ravisTask.id)}/decision`, { decision: 'Rejected', feedback: 'The repository is empty apart from a README.', confirm: true }); assert.equal(rej.status, 200); assert.equal(rej.data.submission.status, 'Rejected');
  const again = await ravi.post(`/student/tasks/${ravisTask.id}/submissions`, { ...good, repositoryUrl: 'https://github.com/ravi-k/marks2' }); assert.equal(again.status, 409); assert.equal(again.data.error.code, 'TASK_REJECTED');
  const own = await ravi.get(`/student/tasks/${ravisTask.id}`); assert.equal(own.data.assignment.submissionStatus, 'Rejected'); assert.match(own.data.evaluations[0].feedback, /repository is empty/);
  assert.equal((await asha.get(`/student/tasks/${ravisTask.id}`)).status, 404); // someone else's task
  assert.equal(JSON.stringify((await ravi.get('/student/tasks')).data).includes('Draft'), false);
});

test('audit log records the review start, draft saves and decisions with the administrator', async () => {
  const rows = db.prepare("SELECT action, admin_name FROM audit_logs WHERE action LIKE 'project.%'").all();
  for (const a of ['project.review_start', 'project.evaluation_save', 'project.decision']) assert.ok(rows.some((r) => r.action === a && r.admin_name === 'Boss Admin'), a);
});
