// Stage 09B (Part 2A) — GitHub project submissions: URL validation, submit/resubmit, history, status, ownership and authorisation (real HTTP, in-memory DB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';
import { parseGitHubRepoUrl } from '../src/utils/github.js';
import { VERIFICATION_NOTICE, submissionStatusOf, SUBMISSION_STATUSES } from '../src/tasks/githubSubmission.js';

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-09b2a-'));
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

test('GitHub URL parser: accepts only repository addresses and normalises them; rejects everything else', () => {
  for (const u of ['https://github.com/asha/app', 'https://github.com/asha/app/', 'https://github.com/asha/app.git', 'https://www.github.com/asha/app']) assert.equal(parseGitHubRepoUrl(u).value.url, 'https://github.com/asha/app');
  for (const u of ['http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?x=1', 'https://github.com/a/b#r', 'https://u:p@github.com/a/b',
    'https://github.com.evil.example/a/b', 'https://github.com/orgs/b', 'https://github.com/-a/b', 'https://github.com/a--b/c', 'javascript:alert(1)', 'github.com/a/b', 'https://github.com:8080/a/b', 'https://github.com/a/..']) assert.ok(parseGitHubRepoUrl(u).error, u);
  assert.equal(parseGitHubRepoUrl('').value, null);
});

test('status vocabulary: the seven statuses exist, and the student-facing status is derived from the stored one', () => {
  assert.deepEqual(SUBMISSION_STATUSES, ['Not Submitted', 'Submitted', 'Under Review', 'Changes Requested', 'Resubmitted', 'Approved', 'Rejected']);
  assert.equal(submissionStatusOf({ status: 'Assigned' }, 0), 'Not Submitted'); assert.equal(submissionStatusOf({ status: 'In Progress' }, 0), 'Not Submitted');
  assert.equal(submissionStatusOf({ status: 'Submitted' }, 1), 'Submitted'); assert.equal(submissionStatusOf({ status: 'Submitted' }, 2), 'Resubmitted');
  assert.equal(submissionStatusOf({ status: 'Changes Requested' }, 1), 'Changes Requested'); assert.equal(submissionStatusOf({ status: 'Approved' }, 1), 'Approved');
});

test('student view: requirements, exact notice, security warning, commit guidance, suggested name without private data, status Not Submitted', async () => {
  const r = await asha.get(`/student/tasks/${repoTask.id}`); assert.equal(r.status, 200);
  const s = r.data.submission;
  assert.equal(s.status, 'Not Submitted'); assert.equal(s.canSubmit, true); assert.equal(s.guide.requiresRepository, true);
  assert.equal(s.guide.verificationNotice, 'GitHub repository ownership, repository contents and commit history will be verified after GitHub integration is implemented in Stage 09C.');
  assert.equal(s.guide.verificationNotice, VERIFICATION_NOTICE);
  for (const need of ['README.md', 'An appropriate .gitignore', 'Testing instructions']) assert.ok(s.guide.requiredContent.includes(need), need);
  assert.ok(s.guide.securityWarning.items.some((i) => /API keys/.test(i)) && s.guide.securityWarning.items.some((i) => /Passwords/.test(i)));
  assert.equal(s.guide.commits.milestones.length, 6); assert.match(s.guide.commits.notQualifying, /only a README\.md/);
  assert.match(s.guide.suggestedRepositoryName, /^elvora-internship-[a-z0-9-]+$/);
  const text = JSON.stringify(r.data); assert.ok(!text.includes('asha@example.com') && !text.includes('98765'), 'no email or phone in the payload');
  assert.ok(!('studentId' in r.data.assignment));
  assert.equal((await asha.get('/student/tasks')).data.tasks.find((t) => t.id === repoTask.id).submissionStatus, 'Not Submitted');
});

test('validation: server rejects bad or missing links and short text with field errors; nothing is stored', async () => {
  const bad = async (over, field) => { const r = await asha.post(`/student/tasks/${repoTask.id}/submissions`, { ...good, ...over }); assert.equal(r.status, 400, JSON.stringify(over)); assert.ok(r.data.error.fields[field], field); };
  await bad({ repositoryUrl: '' }, 'repositoryUrl'); await bad({ repositoryUrl: 'https://gitlab.com/a/b' }, 'repositoryUrl'); await bad({ repositoryUrl: 'https://github.com/a/b/tree/main' }, 'repositoryUrl');
  await bad({ repositoryUrl: 'javascript:alert(1)' }, 'repositoryUrl'); await bad({ description: 'too short' }, 'description'); await bad({ documentationUrl: 'http://docs.example.com' }, 'documentationUrl');
  await bad({ liveUrl: 'ftp://x.example.com' }, 'liveUrl'); await bad({ submissionNotes: 'x'.repeat(1001) }, 'submissionNotes'); await bad({ repositoryDescription: 'abc' }, 'repositoryDescription');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_submissions WHERE student_task_id = ?').get(repoTask.id).n, 0);
});

test('submit: creates version 1, normalises the link, ignores privileged fields, and shows the status', async () => {
  const r = await asha.post(`/student/tasks/${repoTask.id}/submissions`, { ...good, repositoryUrl: 'https://github.com/asha-v/marks-analysis.git', status: 'Approved', score: 100, decision: 'Approved', studentId: 'someone-else', reviewDecision: 'Approved' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.submission.version, 1);
  assert.equal(r.data.assignment.submissionStatus, 'Submitted'); assert.equal(r.data.submissions[0].repositoryUrl, 'https://github.com/asha-v/marks-analysis');
  assert.equal(r.data.submissions[0].repositoryDescription, good.repositoryDescription); assert.equal(r.data.submissions[0].documentationUrl, good.documentationUrl);
  const row = db.prepare('SELECT status, review_decision FROM student_tasks WHERE id = ?').get(repoTask.id); assert.equal(row.status, 'Submitted'); assert.equal(row.review_decision, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_reviews WHERE student_task_id = ?').get(repoTask.id).n, 0, 'a student cannot create a review or score');
  const again = await asha.post(`/student/tasks/${repoTask.id}/submissions`, good); assert.equal(again.status, 409); assert.equal(again.data.error.code, 'AWAITING_REVIEW');
  const v = await asha.get(`/student/tasks/${repoTask.id}`); assert.equal(v.data.submission.canSubmit, false); assert.match(v.data.submission.blockedReason, /waiting for review/);
});

test('ownership: another student gets the same 404 for view, start and submit, and their own list never shows it', async () => {
  for (const [m, p] of [['get', `/student/tasks/${repoTask.id}`], ['post', `/student/tasks/${repoTask.id}/start`], ['post', `/student/tasks/${repoTask.id}/submissions`]]) {
    const r = await ravi[m](p, m === 'post' ? good : undefined); assert.equal(r.status, 404, p);
  }
  assert.equal((await ravi.post(`/student/tasks/${repoTask.id}/submissions`, { ...good, studentId: 'x' })).status, 404);
  assert.ok(!(await ravi.get('/student/tasks')).data.tasks.some((t) => t.id === repoTask.id));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_submissions WHERE student_task_id = ?').get(repoTask.id).n, 1, 'Ravi’s attempts changed nothing');
});

test('authorisation: signed-out callers get 401; students cannot use admin review or submission data', async () => {
  assert.equal((await anon.post(`/student/tasks/${repoTask.id}/submissions`, good)).status, 401);
  assert.equal((await anon.get(`/student/tasks/${repoTask.id}`)).status, 401);
  assert.ok([401, 403].includes((await asha.patch(`/admin/student-tasks/${repoTask.id}/review`, { decision: 'Approved', confirmReviewed: true })).status));
  assert.ok([401, 403].includes((await asha.get(`/admin/student-tasks/${repoTask.id}`)).status));
  assert.equal((await asha.post(`/student/tasks/NOT-AN-ID/submissions`, good)).status, 404);
});

test('duplicate rules: the same repository cannot be reused for a different task of the same student', async () => {
  const r = await asha.post(`/student/tasks/${textTask.id}/submissions`, { description: 'Notes about what I read and learned this week.', repositoryUrl: 'https://github.com/ASHA-V/Marks-Analysis' });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'DUPLICATE_REPOSITORY'); assert.ok(r.data.error.fields.repositoryUrl);
});

test('text task: repository optional but, when given, must still be a GitHub repository', async () => {
  const bad = await asha.post(`/student/tasks/${textTask.id}/submissions`, { description: 'Notes about what I read and learned this week.', repositoryUrl: 'https://example.com/x/y' });
  assert.equal(bad.status, 400);
  const ok = await asha.post(`/student/tasks/${textTask.id}/submissions`, { description: 'Notes about what I read and learned this week.' });
  assert.equal(ok.status, 201); assert.equal(ok.data.submissions[0].repositoryUrl, null);
});

test('changes requested → correct and resubmit: previous version and feedback are kept, form is pre-filled, status becomes Resubmitted', async () => {
  const rv = await admin.patch(`/admin/student-tasks/${repoTask.id}/review`, { decision: 'Changes Requested', feedback: 'Please add tests and a README.', confirmReviewed: true }); assert.equal(rv.status, 200, JSON.stringify(rv.data));
  let v = (await asha.get(`/student/tasks/${repoTask.id}`)).data;
  assert.equal(v.submission.status, 'Changes Requested'); assert.equal(v.submission.canSubmit, true); assert.equal(v.reviews[0].feedback, 'Please add tests and a README.'); assert.equal(v.reviews[0].score, null);
  assert.equal(v.submission.draft.repositoryUrl, 'https://github.com/asha-v/marks-analysis'); assert.equal(v.submission.draft.submissionNotes, good.submissionNotes);
  const r = await asha.post(`/student/tasks/${repoTask.id}/submissions`, { ...good, description: 'Added unit tests, a README and a .gitignore as requested.' }); assert.equal(r.status, 201);
  v = r.data; assert.equal(v.assignment.submissionStatus, 'Resubmitted'); assert.equal(v.submissions.length, 2);
  assert.equal(v.submissions[0].description, good.description, 'version 1 is unchanged'); assert.match(v.submissions[1].description, /unit tests/); assert.equal(v.reviews.length, 1);
  assert.equal((await asha.get('/student/tasks')).data.tasks.find((t) => t.id === repoTask.id).submissionStatus, 'Resubmitted');
});

test('status persists across sessions and approval is shown; history is append-only in the database', async () => {
  assert.equal((await admin.patch(`/admin/student-tasks/${repoTask.id}/review`, { decision: 'Approved', feedback: 'Great work.', confirmReviewed: true })).status, 200);
  const fresh = client(srv.base); assert.equal((await fresh.post('/auth/login', { email: 'asha@example.com', password: PW })).status, 200);
  const v = (await fresh.get(`/student/tasks/${repoTask.id}`)).data; assert.equal(v.submission.status, 'Approved'); assert.equal(v.submission.canSubmit, false); assert.equal(v.reviews.length, 2);
  assert.equal((await fresh.post(`/student/tasks/${repoTask.id}/submissions`, good)).status, 409);
  assert.throws(() => db.prepare("UPDATE task_submissions SET repository_url = 'https://github.com/x/y'").run(), /append-only/);
  assert.throws(() => db.prepare("UPDATE task_reviews SET score = 100").run(), /append-only/);
});

test('migration 15 is additive: new columns exist and are nullable, and pre-existing rows still read', () => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all();
  for (const c of ['repository_description', 'documentation_url', 'submission_notes']) { const x = cols('task_submissions').find((k) => k.name === c); assert.ok(x && x.notnull === 0, c); }
  for (const c of ['score', 'score_breakdown']) { const x = cols('task_reviews').find((k) => k.name === c); assert.ok(x && x.notnull === 0, c); }
});
