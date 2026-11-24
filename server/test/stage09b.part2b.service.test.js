// Stage 09B Part 2B — rubric maths, evaluation workflow, status transitions, history immutability, listing filters and student visibility.
// Drives the service/repository layer directly against an in-memory database (no HTTP); the HTTP, authorization and security checks live in stage09b.part2b.test.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file::memory:', SESSION_SECRET: 'test-secret-test-secret-test-secret-1234', AUTOMATION_ENABLED: 'false', ADMIN_API_KEY: '' });
const { db } = await import('../src/db/index.js');
const students = await import('../src/db/students.js');
const taskRepo = await import('../src/db/tasks.js');
const svc = await import('../src/services/projectEvaluation.js');
const taskSvc = await import('../src/services/internshipTasks.js');
const rubric = await import('../src/tasks/rubric.js');
const gh = await import('../src/tasks/githubSubmission.js');
const now = new Date().toISOString();
let n = 0;
const mkStudent = (name, role = 'student') => {
  const s = students.createStudent({ fullName: name, email: `${name.replace(/\W/g, '').toLowerCase()}${++n}@example.com`, phone: '+91 98765 43210', passwordHash: 'x', college: 'IIT', degree: 'B.Tech', branch: 'CS', academicYear: '3rd Year', graduationYear: 2030, skills: [] });
  if (role === 'admin') students.setRole(s.id, 'admin');
  return students.findById(s.id);
};
const adminOf = (s) => ({ id: s.id, fullName: s.fullName, via: 'session' });
let admin, admin2, listings = 0;
const seedProject = (student, category = 'python-development', { title = 'Marks analysis' } = {}) => {
  const lid = `ELV-T-${++listings}`;
  db.prepare(`INSERT INTO internship_listings (id, title, category, description, duration_days, type, difficulty, created_at, updated_at) VALUES (?, ?, ?, 'desc', 30, 'Project-Based', 'Beginner', ?, ?)`).run(lid, `Listing ${lid}`, category, now, now);
  const tid = `TSK-${String(listings).padStart(8, '0').replace(/\d/g, (d) => 'ABCDEF0123'[+d])}`;
  db.prepare(`INSERT INTO internship_tasks (id, internship_id, title, short_description, difficulty, task_type, submission_type, sequence, created_at, updated_at) VALUES (?, ?, ?, 'short', 'Beginner', 'Mini Project', 'repository', 1, ?, ?)`).run(tid, lid, title, now, now);
  const aid = `ELV-APP-${listings}`; const eid = `ELV-INT-${listings}`; const stid = `STK-0000000${listings}`;
  db.prepare(`INSERT INTO applications (id, student_id, internship_id, internship_title, internship_category, internship_duration_days, full_name, email, phone, college, degree, branch, academic_year, motivation, terms_accepted_at, status, submitted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 30, ?, ?, '1', 'c', 'd', 'b', 'y', 'm', ?, 'Approved', ?, ?)`).run(aid, student.id, lid, `Listing ${lid}`, category, student.fullName, student.email, now, now, now);
  db.prepare(`INSERT INTO enrollments (id, application_id, student_id, status, created_at, updated_at) VALUES (?, ?, ?, 'Active', ?, ?)`).run(eid, aid, student.id, now, now);
  db.prepare(`INSERT INTO student_tasks (id, enrollment_id, student_id, task_id, assigned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(stid, eid, student.id, tid, now, now);
  return { stid, tid, student, category };
};
const submit = (p, repo = 'asha-v/marks') => taskRepo.submit({ studentTaskId: p.stid, studentId: p.student.id, values: { description: 'I built it with tests and docs.', repositoryUrl: `https://github.com/${repo}`, liveUrl: null, repositoryDescription: 'desc', documentationUrl: null, submissionNotes: null } });
const ALL = { functional: 8, code_quality: 7.5, technical: 9, testing: 6, documentation: 10, repository: 5 }; // = 78
const status = (p) => svc.projectDetail(p.stid).submission.status;
const code = (fn) => { try { fn(); } catch (e) { return `${e.status}:${e.code ?? ''}`; } return 'no error'; };
const fieldsOf = (fn) => { try { fn(); } catch (e) { return e.fields ?? e.details?.fields ?? {}; } return {}; };

before(() => { admin = mkStudent('Boss Admin', 'admin'); admin2 = mkStudent('Second Admin', 'admin'); });

test('rubric: default weights total 100 in one place; every category rubric totals 100 and keeps the same criterion keys', () => {
  assert.deepEqual(rubric.DEFAULT_RUBRIC.criteria.map((c) => [c.label, c.weight]), [['Functional requirements', 30], ['Code quality and organization', 20], ['Technical implementation', 20], ['Testing and error handling', 10], ['Documentation', 10], ['GitHub repository quality', 10]]);
  const keys = rubric.DEFAULT_RUBRIC.criteria.map((c) => c.key);
  for (const r of rubric.listRubrics()) { assert.equal(r.criteria.reduce((a, c) => a + c.weight, 0), 100, r.key); assert.deepEqual(r.criteria.map((c) => c.key), keys); }
  assert.equal(rubric.rubricFor('machine-learning').criteria.find((c) => c.key === 'technical').weight, 30);
  assert.equal(rubric.rubricFor('python-development'), rubric.DEFAULT_RUBRIC); // categories without an override use the default
});

test('weighted total: exact arithmetic, consistent rounding, incomplete evaluations have no total', () => {
  const R = rubric.DEFAULT_RUBRIC;
  const full = rubric.calculate(R, ALL); assert.equal(full.total, 78); assert.equal(full.complete, true);
  assert.deepEqual(full.rows.map((r) => r.contribution), [24, 15, 18, 6, 10, 5]);
  assert.equal(rubric.calculate(R, Object.fromEntries(R.criteria.map((c) => [c.key, 10]))).total, 100);
  assert.equal(rubric.calculate(R, Object.fromEntries(R.criteria.map((c) => [c.key, 0]))).total, 0);
  assert.equal(rubric.calculate(R, Object.fromEntries(R.criteria.map((c) => [c.key, 7.5]))).total, 75);
  assert.equal(rubric.calculate(R, Object.fromEntries(R.criteria.map((c) => [c.key, 0.5]))).total, 5);
  const ml = rubric.rubricFor('machine-learning'); // 25/15/30/10/10/10
  assert.equal(rubric.calculate(ml, { functional: 9, code_quality: 8, technical: 7.5, testing: 7, documentation: 6, repository: 10 }).total, 22.5 + 12 + 22.5 + 7 + 6 + 10);
  const partial = rubric.calculate(R, { functional: 10, technical: 5 });
  assert.equal(partial.total, null); assert.equal(partial.complete, false); assert.equal(partial.partialTotal, 40); assert.deepEqual(partial.missing, ['code_quality', 'testing', 'documentation', 'repository']);
});

test('score validation: negative, above-maximum, non-numeric, off-step and unknown criteria are all rejected', () => {
  const R = rubric.DEFAULT_RUBRIC;
  const bad = rubric.parseScores({ functional: 11, code_quality: -1, technical: 'abc', testing: 7.25, documentation: 1e9, bogus: 5, repository: NaN }, R).errors;
  for (const k of ['functional', 'code_quality', 'technical', 'testing', 'documentation', 'bogus', 'repository']) assert.ok(bad[k], k);
  assert.deepEqual(rubric.parseScores({ functional: '7.5', testing: 0, documentation: 10, technical: null, repository: '' }, R), { scores: { functional: 7.5, testing: 0, documentation: 10 }, errors: {} });
  assert.ok(rubric.parseScores([1], R).errors.scores); assert.ok(rubric.parseScores(null, R).errors.scores);
});

test('status vocabulary and transitions: only the specified moves are legal', () => {
  assert.deepEqual(gh.SUBMISSION_STATUSES, ['Not Submitted', 'Submitted', 'Under Review', 'Changes Requested', 'Resubmitted', 'Approved', 'Rejected']);
  const ok = [['Not Submitted', 'Submitted'], ['Submitted', 'Under Review'], ['Resubmitted', 'Under Review'], ['Under Review', 'Approved'], ['Under Review', 'Changes Requested'], ['Under Review', 'Rejected'], ['Changes Requested', 'Resubmitted']];
  for (const [a, b] of gh.SUBMISSION_STATUSES.flatMap((a) => gh.SUBMISSION_STATUSES.map((b) => [a, b]))) assert.equal(gh.canTransition(a, b), ok.some(([x, y]) => x === a && y === b), `${a} → ${b}`);
  assert.equal(gh.submissionStatusOf({ status: 'Submitted', projectStatus: 'Under Review' }, 3), 'Under Review');
  assert.equal(gh.submissionStatusOf({ status: 'Changes Requested', projectStatus: 'Rejected' }, 1), 'Rejected');
  assert.equal(gh.submissionStatusOf({ status: 'Submitted', projectStatus: null }, 2), 'Resubmitted');
});

test('full journey: submit → under review → draft → changes requested → resubmitted → approved, with history preserved', () => {
  const asha = mkStudent('Asha Verma'); const p = seedProject(asha);
  assert.equal(status(p), 'Not Submitted');
  assert.equal(code(() => svc.startReview(p.stid, adminOf(admin))), '409:INVALID_TRANSITION');
  submit(p); assert.equal(status(p), 'Submitted');
  // opening the project moves it to Under Review; doing it again changes nothing
  assert.equal(svc.startReview(p.stid, adminOf(admin)).submission.status, 'Under Review'); assert.equal(svc.startReview(p.stid, adminOf(admin)).submission.status, 'Under Review');
  assert.equal(db.prepare("SELECT status FROM student_tasks WHERE id = ?").get(p.stid).status, 'Submitted'); // the Stage 09A status is untouched
  // invalid scores are refused and nothing is saved
  assert.deepEqual(Object.keys(fieldsOf(() => svc.saveDraft(p.stid, { scores: { functional: 99, testing: -2 } }, adminOf(admin)))).sort(), ['functional', 'testing']);
  assert.equal(svc.projectDetail(p.stid).draft, null);
  // a partial draft saves and can be reopened and edited (by another administrator too)
  let d = svc.saveDraft(p.stid, { scores: { functional: 8, code_quality: 7.5 }, feedback: 'Good start.' }, adminOf(admin));
  assert.equal(d.draft.calculation.complete, false); assert.equal(d.draft.weightedTotal, null); assert.equal(d.draft.calculation.partialTotal, 39);
  const draftId = d.draft.id;
  d = svc.saveDraft(p.stid, { scores: { technical: 9, code_quality: null } }, adminOf(admin2));
  assert.equal(d.draft.id, draftId); assert.deepEqual(d.draft.scores, { functional: 8, technical: 9 }); assert.equal(d.draft.feedback, 'Good start.'); assert.equal(d.draft.adminName, 'Second Admin');
  assert.equal(d.draft.rubric.key, 'default');
  // incomplete evaluations cannot be finalized; corrections need written feedback
  assert.ok(fieldsOf(() => svc.finalize(p.stid, { decision: 'Approved', confirm: true }, adminOf(admin))).scores);
  svc.saveDraft(p.stid, { scores: ALL, feedback: '' }, adminOf(admin));
  assert.ok(fieldsOf(() => svc.finalize(p.stid, { decision: 'Changes Requested', confirm: true }, adminOf(admin))).feedback);
  assert.ok(fieldsOf(() => svc.finalize(p.stid, { decision: 'Rejected', feedback: 'no', confirm: true }, adminOf(admin))).feedback);
  assert.ok(fieldsOf(() => svc.finalize(p.stid, { decision: 'Maybe', confirm: true }, adminOf(admin))).decision);
  assert.ok(fieldsOf(() => svc.finalize(p.stid, { decision: 'Approved' }, adminOf(admin))).confirm);
  assert.equal(status(p), 'Under Review'); // every failed attempt left the project untouched
  // explicit decision: Changes Requested
  const cr = svc.finalize(p.stid, { decision: 'Changes Requested', feedback: 'Please add tests for the empty-file case.', confirm: true }, adminOf(admin));
  assert.equal(cr.submission.status, 'Changes Requested'); assert.equal(cr.previousEvaluations.length, 1);
  const e1 = cr.previousEvaluations[0]; assert.equal(e1.decision, 'Changes Requested'); assert.equal(e1.weightedTotal, 78); assert.equal(e1.adminName, 'Boss Admin'); assert.ok(e1.decidedAt); assert.equal(e1.submissionVersion, 1);
  assert.equal(e1.rubric.criteria.length, 6); assert.deepEqual(e1.scores, ALL);
  const review = taskRepo.reviewsFor(p.stid); assert.equal(review.length, 1); assert.equal(review[0].score, 78); assert.equal(review[0].decision, 'Changes Requested');
  assert.equal(db.prepare('SELECT feedback FROM student_tasks WHERE id = ?').get(p.stid).feedback, 'Please add tests for the empty-file case.');
  // finalized evaluations can never be changed — not even by raw SQL
  assert.throws(() => db.prepare("UPDATE project_evaluations SET weighted_total = 100 WHERE id = ?").run(e1.id), /immutable/);
  assert.throws(() => db.prepare("UPDATE project_evaluations SET feedback = 'x' WHERE id = ?").run(e1.id), /immutable/);
  assert.equal(code(() => svc.saveDraft(p.stid, { scores: ALL }, adminOf(admin))), '409:NOT_SUBMITTED'); // nothing to evaluate until the student resubmits
  // student resubmits → Resubmitted → Under Review → new evaluation, earlier one preserved
  submit(p); assert.equal(status(p), 'Resubmitted'); assert.equal(svc.projectDetail(p.stid).submission.isResubmission, true);
  svc.startReview(p.stid, adminOf(admin));
  const d2 = svc.saveDraft(p.stid, { scores: { ...ALL, functional: 10 }, feedback: 'Great fixes.' }, adminOf(admin));
  assert.notEqual(d2.draft.id, e1.id); assert.equal(d2.draft.submissionVersion, 2);
  const ok = svc.finalize(p.stid, { decision: 'Approved', confirm: true }, adminOf(admin));
  assert.equal(ok.submission.status, 'Approved'); assert.equal(ok.previousEvaluations.length, 2); assert.equal(ok.previousEvaluations[0].weightedTotal, 78); assert.equal(ok.previousEvaluations[1].weightedTotal, 84);
  assert.equal(db.prepare('SELECT status FROM student_tasks WHERE id = ?').get(p.stid).status, 'Approved');
  // approval is final
  assert.equal(code(() => svc.finalize(p.stid, { decision: 'Rejected', feedback: 'changed my mind', confirm: true }, adminOf(admin))), '409:ALREADY_DECIDED');
  assert.equal(code(() => svc.saveDraft(p.stid, { scores: ALL }, adminOf(admin))), '409:ALREADY_DECIDED');
  // audit trail
  const actions = db.prepare("SELECT action, admin_name, reason FROM audit_logs WHERE target_id = ? ORDER BY rowid").all(p.stid).map((r) => r.action);
  assert.ok(actions.includes('project.review_start') && actions.includes('project.evaluation_save') && actions.filter((a) => a === 'project.decision').length === 2);
  // notifications reach the student
  const types = db.prepare('SELECT type FROM notifications WHERE student_id = ?').all(asha.id).map((r) => r.type);
  assert.ok(types.includes('task_changes_requested') && types.includes('task_approved'));
});

test('scores never decide: a perfect score stays Under Review, and a low score can still be approved only by an explicit decision', () => {
  const a = mkStudent('Perfect Pat'); const p = seedProject(a); submit(p, 'pat/perfect'); svc.startReview(p.stid, adminOf(admin));
  svc.saveDraft(p.stid, { scores: Object.fromEntries(Object.keys(ALL).map((k) => [k, 10])) }, adminOf(admin));
  assert.equal(status(p), 'Under Review'); assert.equal(svc.projectDetail(p.stid).draft.calculation.partialTotal, 100);
  const b = mkStudent('Low Lou'); const q = seedProject(b); submit(q, 'lou/low');
  svc.saveDraft(q.stid, { scores: Object.fromEntries(Object.keys(ALL).map((k) => [k, 0])), feedback: 'Weak but accepted by the reviewer.' }, adminOf(admin));
  assert.equal(svc.finalize(q.stid, { decision: 'Approved', confirm: true }, adminOf(admin)).submission.status, 'Approved');
});

test('rejection: explicit, needs feedback, blocks resubmission, and the student sees the feedback and breakdown (never drafts)', () => {
  const r = mkStudent('Rita Rao'); const p = seedProject(r, 'machine-learning'); submit(p, 'rita/ml');
  const d = svc.saveDraft(p.stid, { scores: ALL, feedback: 'Draft thoughts only the admin should see.' }, adminOf(admin));
  assert.equal(d.rubric.key, 'machine-learning');
  assert.equal(taskSvc.studentTaskView(r, p.stid).evaluations.length, 0); // drafts are invisible to the student
  assert.equal(taskSvc.studentTaskView(r, p.stid).assignment.submissionStatus, 'Under Review');
  const out = svc.finalize(p.stid, { decision: 'Rejected', feedback: 'The repository contains no working code for the task.', confirm: true }, adminOf(admin));
  assert.equal(out.submission.status, 'Rejected');
  assert.equal(taskRepo.reviewsFor(p.stid).length, 0); // task_reviews only knows the Stage 09A decisions
  assert.equal(code(() => submit(p, 'rita/ml2')), '409:TASK_REJECTED');
  const view = taskSvc.studentTaskView(r, p.stid);
  assert.equal(view.assignment.submissionStatus, 'Rejected'); assert.equal(view.submission.canSubmit, false); assert.match(view.submission.blockedReason, /rejected/i);
  assert.equal(view.evaluations.length, 1); assert.equal(view.evaluations[0].decision, 'Rejected'); assert.match(view.evaluations[0].feedback, /no working code/); assert.equal(view.evaluations[0].breakdown.length, 6);
  assert.equal(view.evaluations[0].breakdown[2].weight, 30); // the ML rubric that was actually used
  // another student can never read it
  const other = mkStudent('Other Student'); assert.equal(code(() => taskSvc.studentTaskView(other, p.stid)), '404:TASK_NOT_FOUND');
  assert.equal(taskRepo.progressFor(db.prepare('SELECT enrollment_id FROM student_tasks WHERE id = ?').get(p.stid).enrollment_id).requiredApproved, 0); // a rejected task never counts as done
});

test('authorization rules inside the service: no key-only actor, no self-evaluation, unknown ids are 404', () => {
  const s = mkStudent('Sam Self', 'admin'); const p = seedProject(s); submit(p, 'sam/self');
  assert.equal(code(() => svc.startReview(p.stid, adminOf(s))), '403:SELF_REVIEW');
  assert.equal(code(() => svc.saveDraft(p.stid, { scores: ALL }, { via: 'key' })), '403:ADMIN_REQUIRED');
  assert.equal(code(() => svc.finalize(p.stid, { decision: 'Approved', confirm: true }, undefined)), '403:ADMIN_REQUIRED');
  assert.equal(code(() => svc.projectDetail('STK-FFFFFFFF')), '404:SUBMISSION_NOT_FOUND'); assert.equal(code(() => svc.projectDetail("x'; DROP TABLE students;--")), '404:SUBMISSION_NOT_FOUND');
  assert.equal(status(p), 'Submitted');
});

test('a simple Stage 09A review retires any evaluation draft and clears the refined status', () => {
  const s = mkStudent('Legacy Lee'); const p = seedProject(s); submit(p, 'lee/legacy'); svc.saveDraft(p.stid, { scores: { functional: 5 } }, adminOf(admin));
  taskRepo.review({ studentTaskId: p.stid, admin: adminOf(admin), decision: 'Changes Requested', feedback: 'Please add a README file.' });
  assert.equal(status(p), 'Changes Requested');
  assert.deepEqual(db.prepare('SELECT status FROM project_evaluations WHERE student_task_id = ?').all(p.stid).map((r) => r.status), ['Superseded']);
  submit(p, 'lee/legacy'); svc.saveDraft(p.stid, { scores: { functional: 6 } }, adminOf(admin)); // a fresh draft is possible again
  assert.equal(svc.projectDetail(p.stid).draft.submissionVersion, 2);
});

test('admin listing: filters by category, task, student, status and search; flags new vs resubmitted; counts; validation', () => {
  const all = svc.listProjects({}); assert.ok(all.pagination.total >= 5); assert.ok(all.submissions.every((s) => s.versions >= 1));
  assert.ok(all.submissions.every((s) => gh.SUBMISSION_STATUSES.includes(s.status)));
  const ml = svc.listProjects({ category: 'machine-learning' }); assert.ok(ml.submissions.length >= 1 && ml.submissions.every((s) => s.internship.category === 'machine-learning'));
  const rej = svc.listProjects({ status: 'Rejected' }); assert.ok(rej.submissions.length >= 1 && rej.submissions.every((s) => s.status === 'Rejected'));
  assert.equal(svc.listProjects({ status: 'Approved' }).submissions.every((s) => s.status === 'Approved' && s.lastEvaluation), true);
  const lee = svc.listProjects({ q: 'lee/legacy' }); assert.equal(lee.submissions.length, 1); assert.equal(lee.submissions[0].isResubmission, true); assert.equal(lee.submissions[0].hasDraft, true); assert.equal(lee.submissions[0].status, 'Under Review');
  assert.equal(svc.listProjects({ q: 'Legacy Lee' }).submissions.length, 1);
  assert.equal(svc.listProjects({ q: '%' }).submissions.length, 0); // LIKE wildcards are escaped
  const one = lee.submissions[0];
  assert.equal(svc.listProjects({ taskId: one.task.id }).submissions.length, 1); assert.equal(svc.listProjects({ studentId: one.student.id }).submissions.length, 1);
  const fresh = mkStudent('Fresh Fay'); const p = seedProject(fresh); submit(p, 'fay/fresh');
  const sub = svc.listProjects({ status: 'Submitted', q: 'fay/fresh' }).submissions; assert.equal(sub.length, 1); assert.equal(sub[0].isNew, true); assert.equal(sub[0].isResubmission, false);
  const re = svc.listProjects({ status: 'Resubmitted' }); assert.ok(re.submissions.every((s) => s.isResubmission));
  assert.equal(svc.listProjects({ status: 'Not Submitted' }).submissions.every((s) => s.versions === 0 && s.status === 'Not Submitted'), true);
  const counts = svc.listProjects({}).counts; assert.ok(counts.Approved >= 2 && counts.Rejected >= 1 && counts['Under Review'] >= 1);
  assert.deepEqual(Object.keys(fieldsOf(() => svc.listProjects({ category: 'nope', status: 'Bogus', taskId: 'x', page: 0 }))).sort(), ['category', 'page', 'status', 'taskId']);
  assert.ok(svc.filterOptions().rubrics.length >= 5);
});

test('detail view: the admin sees links, notes, every version, the rubric, and the unverified-GitHub warning', () => {
  const s = mkStudent('Detail Dee'); const p = seedProject(s);
  taskRepo.submit({ studentTaskId: p.stid, studentId: s.id, values: { description: 'Built the thing with tests.', repositoryUrl: 'https://github.com/dee/detail', liveUrl: 'https://dee.example.com', repositoryDescription: 'Repo', documentationUrl: 'https://dee.example.com/docs', submissionNotes: 'Run npm test first.' } });
  const d = svc.projectDetail(p.stid);
  assert.equal(d.latestSubmission.repositoryUrl, 'https://github.com/dee/detail'); assert.equal(d.latestSubmission.liveUrl, 'https://dee.example.com'); assert.equal(d.latestSubmission.documentationUrl, 'https://dee.example.com/docs'); assert.equal(d.latestSubmission.submissionNotes, 'Run npm test first.');
  assert.equal(d.rubric.criteria.length, 6); assert.deepEqual(d.allowedNext, ['Under Review']); assert.equal(d.canEvaluate, true);
  assert.match(d.verificationNotice, /NOT been verified/); assert.match(d.verificationNotice, /Stage 09C/);
});
