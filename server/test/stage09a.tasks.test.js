// Stage 09A — task templates, internship tasks, assignment, integrity rules, completion gate and authorization (real HTTP, in-memory DB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1';
const ORG = { ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Gowtham', ORG_SIGNATORY_TITLE: 'Chief Executive Officer (CEO)' };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let srv, dir, db, worker, tasksSvc, admin, key, asha, ravi, anon, listingId, javaListingId, tplA, tplB, tplFinal;

const content = { objective: 'Build a marks analysis script that reads a CSV and prints a summary.', background: 'Students often keep marks in spreadsheets. This task turns them into a small report.', tools: ['Python 3', 'A text editor'],
  steps: ['Create a CSV file with five students and three subjects.', 'Read the file with the csv module.', 'Print each student’s average and the class topper.'], expectedOutput: 'A script that prints averages and the topper.', submissionRequirements: 'Share your repository link and a short description.' };
const tpl = (over = {}) => ({ category: 'python-development', title: 'Student marks analysis', shortDescription: 'Read a CSV of marks and print averages and the topper.', difficulty: 'Beginner', taskType: 'Practical Assignment', submissionType: 'repository',
  estimatedHours: 6, learningObjectives: ['Read a CSV file in Python'], requiredSkills: ['Python basics'], deliverables: ['marks.py'], evaluationCriteria: ['Script runs without errors'], resources: [{ title: 'Python csv docs', url: 'https://docs.python.org/3/library/csv.html' }], content, ...over });
const listingBody = (over = {}) => ({ title: 'Python Tasks Internship', category: 'python-development', description: 'A listing used by the Stage 09A task tests.', durationDays: 30, skills: ['Python'], outcomes: ['Build a small Python project'], eligibility: { who: 'Any student' }, type: 'Project-Based', difficulty: 'Beginner', ...over });
const approvedEnrollment = async (c, email, name, listing) => {
  await c.post('/auth/register', validStudent({ email, fullName: name }));
  const a = await c.post('/applications', validApplication({ internshipId: listing, fullName: name }));
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal((await admin.patch(`/admin/applications/${a.data.application.id}/status`, { status: 'Approved' })).status, 200);
  const e = await admin.post(`/admin/applications/${a.data.application.id}/internship`, { startDate: day(-1) });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  return { id: e.data.internship.id, appId: a.data.application.id };
};
const student = (email) => import('../src/db/students.js').then((m) => m.findByEmail(email));
const stRows = (enr) => db.prepare('SELECT * FROM student_tasks WHERE enrollment_id = ? ORDER BY rowid').all(enr);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-09a-'));
  key = 'k'.repeat(40);
  srv = await startServer({ ADMIN_API_KEY: key, DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000', ...ORG });
  ({ db } = await import('../src/db/index.js'));
  worker = await import('../src/automation/worker.js');
  tasksSvc = await import('../src/services/internshipTasks.js');
  [anon, admin, asha, ravi] = [1, 2, 3, 4].map(() => client(srv.base));
  assert.equal((await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  for (const [v, lid] of [[listingBody(), 'py'], [listingBody({ title: 'Java Tasks Internship', category: 'java-development', skills: ['Java'] }), 'jv']]) {
    const r = await admin.post('/admin/internship-listings', v); assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await admin.patch(`/admin/internship-listings/${r.data.internship.id}/state`, { action: 'publish' })).status, 200);
    if (lid === 'py') listingId = r.data.internship.id; else javaListingId = r.data.internship.id;
  }
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('templates: created as draft, validated (difficulty limited to Beginner/Easy/Intermediate), must be complete to publish, edits are versioned', async () => {
  const bad = await admin.post('/admin/task-templates', tpl({ difficulty: 'Advanced' }));
  assert.equal(bad.status, 400); assert.ok(bad.data.error.fields.difficulty);
  assert.equal((await admin.post('/admin/task-templates', tpl({ category: 'not-a-category' }))).status, 400);
  assert.equal((await admin.post('/admin/task-templates', tpl({ resources: [{ title: 'x site', url: 'javascript:alert(1)' }] }))).status, 400, 'only https links');
  assert.equal((await admin.post('/admin/task-templates', tpl({ estimatedHours: 500 }))).status, 400);
  const incomplete = await admin.post('/admin/task-templates', tpl({ title: 'Incomplete one', content: { objective: 'Only an objective is written so far.' } }));
  assert.equal(incomplete.status, 201); assert.equal(incomplete.data.template.published, false); assert.equal(incomplete.data.template.readiness.ready, false);
  const pub = await admin.patch(`/admin/task-templates/${incomplete.data.template.id}/state`, { action: 'publish' });
  assert.equal(pub.status, 409); assert.equal(pub.data.error.code, 'TEMPLATE_INCOMPLETE');
  for (const [name, over] of [['A', {}], ['B', { title: 'Mini calculator', taskType: 'Mini Project', difficulty: 'Easy', evaluationCriteria: ['Handles invalid input'] }], ['F', { title: 'Final report generator', taskType: 'Final Project', difficulty: 'Intermediate', minDurationDays: 30 }]]) {
    const c = await admin.post('/admin/task-templates', tpl(over)); assert.equal(c.status, 201, JSON.stringify(c.data));
    assert.equal(c.data.template.readiness.ready, true);
    assert.equal((await admin.patch(`/admin/task-templates/${c.data.template.id}/state`, { action: 'publish' })).status, 200);
    if (name === 'A') tplA = c.data.template; if (name === 'B') tplB = c.data.template; if (name === 'F') tplFinal = c.data.template;
  }
  const edited = await admin.patch(`/admin/task-templates/${tplA.id}`, { estimatedHours: 8 });
  assert.equal(edited.status, 200); assert.equal(edited.data.template.version, 2);
  const stripped = await admin.patch(`/admin/task-templates/${tplA.id}`, { content: { ...content, steps: [] } });
  assert.equal(stripped.status, 409, 'a published template must stay complete');
  const list = await admin.get('/admin/task-templates?category=python-development&state=published');
  assert.equal(list.status, 200); assert.equal(list.data.templates.length, 3);
});

test('internship tasks: template content is COPIED, unrelated categories are refused, duplicates refused, sequence and publication work', async () => {
  assert.equal((await admin.post(`/admin/internship-listings/${javaListingId}/tasks`, { templateId: tplA.id })).status, 409, 'python template cannot go on a java internship');
  const a = await admin.post(`/admin/internship-listings/${listingId}/tasks`, { templateId: tplA.id });
  assert.equal(a.status, 201, JSON.stringify(a.data)); assert.equal(a.data.task.published, false); assert.equal(a.data.task.sequence, 1);
  assert.equal((await admin.post(`/admin/internship-listings/${listingId}/tasks`, { templateId: tplA.id })).data.error.code, 'TEMPLATE_ALREADY_ATTACHED');
  const b = await admin.post(`/admin/internship-listings/${listingId}/tasks`, { templateId: tplB.id, isRequired: false, dueAfterDays: 20 });
  assert.equal(b.status, 201); assert.equal(b.data.task.required, false); assert.equal(b.data.task.dueAfterDays, 20);
  assert.equal((await admin.post(`/admin/internship-listings/${listingId}/tasks`, { templateId: tplB.id, dueAfterDays: 99 })).status, 409, 'already attached is checked first');
  const f = await admin.post(`/admin/internship-listings/${listingId}/tasks`, { templateId: tplFinal.id, dueAfterDays: 90 });
  assert.equal(f.status, 400, 'a deadline cannot be later than the internship length'); 
  const f2 = await admin.post(`/admin/internship-listings/${listingId}/tasks`, { templateId: tplFinal.id, dueAfterDays: 28 });
  assert.equal(f2.status, 201);
  // copy semantics: editing the template does not change the internship's own task
  await admin.patch(`/admin/task-templates/${tplA.id}`, { title: 'Renamed in the library' });
  assert.equal((await admin.get(`/admin/internship-tasks/${a.data.task.id}`)).data.task.title, 'Student marks analysis');
  // short internship vs template minimum
  const week = await admin.post('/admin/internship-listings', listingBody({ title: 'One Week Python', durationDays: 7 }));
  assert.equal((await admin.post(`/admin/internship-listings/${week.data.internship.id}/tasks`, { templateId: tplFinal.id })).data.error.code, 'DURATION_TOO_SHORT');
  // a custom task + ordering
  const custom = await admin.post(`/admin/internship-listings/${listingId}/tasks`, { ...tpl(), title: 'Custom warm-up' });
  assert.equal(custom.status, 201);
  const ids = (await admin.get(`/admin/internship-listings/${listingId}/tasks`)).data.tasks.map((t) => t.id);
  const reversed = [...ids].reverse();
  assert.deepEqual((await admin.put(`/admin/internship-listings/${listingId}/tasks/order`, { taskIds: reversed })).data.tasks.map((t) => t.id), reversed);
  assert.equal((await admin.put(`/admin/internship-listings/${listingId}/tasks/order`, { taskIds: reversed.slice(1) })).status, 409, 'must name every task');
  for (const id of reversed) assert.equal((await admin.patch(`/admin/internship-tasks/${id}/state`, { action: 'publish' })).status, 200);
  assert.equal((await admin.get(`/admin/internship-listings/${listingId}/tasks`)).data.summary.published, 4);
});

test('authorization: students, anonymous callers and the read-only shared key cannot read or change any task configuration', async () => {
  await asha.post('/auth/register', validStudent());
  const paths = [['get', '/admin/task-templates'], ['post', '/admin/task-templates'], ['get', `/admin/internship-listings/${listingId}/tasks`], ['post', `/admin/internship-listings/${listingId}/tasks`],
    ['put', `/admin/internship-listings/${listingId}/completion-criteria`], ['put', `/admin/internship-listings/${listingId}/application-criteria`], ['get', '/admin/applications/recommendations'], ['post', `/admin/internship-listings/${listingId}/tasks/sync`]];
  for (const [m, p] of paths) {
    const anonRes = await anon[m](p, m === 'get' ? undefined : {}); assert.equal(anonRes.status, 401, `anon ${m} ${p}`);
    const stuRes = await asha[m](p, m === 'get' ? undefined : {}); assert.equal(stuRes.status, 403, `student ${m} ${p}`);
  }
  const k = { 'X-Admin-Key': key };
  assert.equal((await anon.get('/admin/task-templates', k)).status, 200, 'the key may READ');
  const before = db.prepare('SELECT COUNT(*) n FROM task_templates').get().n;
  const w = await anon.post('/admin/task-templates', tpl({ title: 'Written by the shared key' }), k);
  assert.ok([401, 403].includes(w.status), `the key may not WRITE (got ${w.status})`);
  assert.ok([401, 403].includes((await anon.patch(`/admin/internship-tasks/${tplA.id}/state`, { action: 'publish' }, k)).status));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_templates').get().n, before, 'nothing was written');
  // the audit log recorded the real changes under the administrator's name
  const log = (await admin.get('/admin/audit-logs?pageSize=100')).data.events.map((e) => e.action);
  for (const a of ['task_template.create', 'task_template.publish', 'internship_task.attach', 'internship_task.publish', 'internship_task.reorder']) assert.ok(log.includes(a), a);
});

let enr1, enr2, enrJava;
test('assignment: the listing’s published tasks are assigned as soon as the internship exists (before activation), ONLY once, with due dates; other internships and repeat calls change nothing', async () => {
  enr1 = await approvedEnrollment(asha, 'asha@example.com', 'Asha Verma', listingId);
  assert.equal(stRows(enr1.id).length, 4, 'the student already has the tasks while the internship is Awaiting Start');
  assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(enr1.id).status, 'Awaiting Start');
  const act = await admin.patch(`/admin/internships/${enr1.id}/activate`, { startDate: day(-1) });
  assert.equal(act.status, 200, JSON.stringify(act.data));
  const rows = stRows(enr1.id);
  assert.equal(rows.length, 4); assert.ok(rows.every((r) => r.status === 'Assigned' && r.student_id === db.prepare('SELECT student_id FROM enrollments WHERE id = ?').get(enr1.id).student_id));
  assert.equal(rows.filter((r) => r.is_required === 0).length, 1, 'the optional task is recorded as optional');
  assert.ok(rows.some((r) => r.due_date === day(-1 + 20)), 'due date = start + dueAfterDays');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE enrollment_id = ? AND type = 'tasks_assigned'").get(enr1.id).n, 1);
  // repeat: manual, worker, and a second activation attempt create nothing new
  assert.equal((await admin.post(`/admin/internships/${enr1.id}/tasks/assign`, {})).data.assigned, 0);
  const cycle = await worker.runCycle({ now: new Date(), force: true });
  assert.equal(cycle.tasksAssigned, 0); assert.equal(stRows(enr1.id).length, 4);
  assert.equal((await admin.patch(`/admin/internships/${enr1.id}/activate`, {})).status, 409);
  // a Java student receives nothing from the Python plan (and the Java listing has no tasks)
  enrJava = await approvedEnrollment(ravi, 'ravi@example.com', 'Ravi Kumar', javaListingId);
  assert.equal((await admin.patch(`/admin/internships/${enrJava.id}/activate`, { startDate: day(-1) })).status, 200);
  assert.equal(stRows(enrJava.id).length, 0);
  // unapproved/not active internship cannot be assigned
  assert.equal((await admin.post(`/admin/internships/${enr1.id.replace(/.$/, '0')}/tasks/assign`, {})).status, 404);
});

test('assignment: future tasks are never pushed silently; an explicit sync adds only the missing ones and preserves progress', async () => {
  const extra = await admin.post(`/admin/internship-listings/${listingId}/tasks`, { ...tpl(), title: 'Added later task', publish: true });
  assert.equal(extra.status, 201);
  await worker.runCycle({ now: new Date(), force: true });
  assert.equal(stRows(enr1.id).length, 4, 'the worker does not top up students who already have a plan');
  const first = db.prepare('SELECT id FROM student_tasks WHERE enrollment_id = ? ORDER BY rowid LIMIT 1').get(enr1.id).id;
  db.prepare("UPDATE student_tasks SET status = 'In Progress' WHERE id = ?").run(first);
  const sync = await admin.post(`/admin/internship-listings/${listingId}/tasks/sync`, {});
  assert.equal(sync.status, 200); assert.equal(sync.data.tasksAssigned, 1);
  assert.equal(stRows(enr1.id).length, 5); assert.equal(db.prepare('SELECT status FROM student_tasks WHERE id = ?').get(first).status, 'In Progress', 'existing progress untouched');
  assert.equal((await admin.post(`/admin/internship-listings/${listingId}/tasks/sync`, {})).data.tasksAssigned, 0, 'idempotent');
  db.prepare("UPDATE student_tasks SET status = 'Assigned' WHERE id = ?").run(first);
  // the DB itself refuses a duplicate assignment even if the app code were bypassed
  const row = db.prepare('SELECT * FROM student_tasks WHERE id = ?').get(first);
  assert.throws(() => db.prepare(`INSERT INTO student_tasks (id, enrollment_id, student_id, task_id, assigned_at, updated_at) VALUES ('STK-DEADBEEF', ?, ?, ?, 'x', 'x')`).run(row.enrollment_id, row.student_id, row.task_id));
});

test('integrity: students submit only THEIR assigned tasks, cannot approve their own work, and history is preserved', async () => {
  const sAsha = await student('asha@example.com'); const sRavi = await student('ravi@example.com');
  const [t1, t2] = stRows(enr1.id);
  const good = { description: 'I read the CSV and printed averages for each student.', repositoryUrl: 'https://github.com/asha/marks' };
  assert.throws(() => tasksSvc.submitWork(sRavi, t1.id, good), (e) => e.status === 404, 'another student cannot submit to it (same 404 as missing)');
  assert.throws(() => tasksSvc.submitWork(sAsha, 'STK-00000000', good), (e) => e.status === 404);
  assert.throws(() => tasksSvc.submitWork(sAsha, t1.id, { description: 'short' }), (e) => e.status === 400);
  assert.throws(() => tasksSvc.submitWork(sAsha, t1.id, { ...good, repositoryUrl: 'http://insecure.example/x' }), (e) => e.status === 400);
  assert.throws(() => tasksSvc.submitWork(sAsha, t1.id, { ...good, attachments: ['x.zip'] }), (e) => e.status === 400, 'attachments are not supported');
  tasksSvc.startTask(sAsha, t1.id);
  assert.throws(() => tasksSvc.startTask(sAsha, t1.id), (e) => e.status === 409);
  const s1 = tasksSvc.submitWork(sAsha, t1.id, good);
  assert.equal(s1.submission.version, 1); assert.equal(s1.studentTask.status, 'Submitted');
  assert.throws(() => tasksSvc.submitWork(sAsha, t1.id, good), (e) => e.code === 'AWAITING_REVIEW');
  // a student (even via the service) cannot review; there is no student route for tasks at all
  assert.throws(() => tasksSvc.reviewWork(sAsha, t1.id, { decision: 'Approved', confirmReviewed: true }), (e) => e.status === 403);
  for (const p of [`/student/tasks`, `/student/tasks/${t1.id}/review`, `/student/tasks/${t1.id}/submit`]) assert.equal((await asha.patch(p, { decision: 'Approved' })).status, 404);
  assert.equal((await asha.patch(`/admin/student-tasks/${t1.id}/review`, { decision: 'Approved', confirmReviewed: true })).status, 403, 'student HTTP cannot reach the review route');
  assert.equal(db.prepare('SELECT status FROM student_tasks WHERE id = ?').get(t1.id).status, 'Submitted');
  // an administrator account can't approve work that is its own either (the check is inside the review transaction)
  const tasksDb = await import('../src/db/tasks.js');
  assert.throws(() => tasksDb.review({ studentTaskId: t1.id, admin: { id: sAsha.id, fullName: 'Asha', via: 'session' }, decision: 'Approved', feedback: null }), (e) => e.code === 'SELF_REVIEW');
  assert.equal(db.prepare('SELECT status FROM student_tasks WHERE id = ?').get(t1.id).status, 'Submitted');
  // review: changes requested needs feedback, confirmation is required
  assert.equal((await admin.patch(`/admin/student-tasks/${t1.id}/review`, { decision: 'Changes Requested', confirmReviewed: true })).status, 400);
  assert.equal((await admin.patch(`/admin/student-tasks/${t1.id}/review`, { decision: 'Approved' })).status, 400);
  const cr = await admin.patch(`/admin/student-tasks/${t1.id}/review`, { decision: 'Changes Requested', feedback: 'Please handle an empty file gracefully.', confirmReviewed: true });
  assert.equal(cr.status, 200); assert.equal(cr.data.studentTask.status, 'Changes Requested');
  assert.equal((await admin.patch(`/admin/student-tasks/${t1.id}/review`, { decision: 'Approved', confirmReviewed: true })).status, 409, 'nothing waiting for review');
  const s2 = tasksSvc.submitWork(sAsha, t1.id, { ...good, description: 'I added handling for an empty file and re-ran everything.' });
  assert.equal(s2.submission.version, 2);
  assert.equal((await admin.patch(`/admin/student-tasks/${t1.id}/review`, { decision: 'Approved', confirmReviewed: true })).status, 200);
  assert.throws(() => tasksSvc.submitWork(sAsha, t1.id, good), (e) => e.code === 'TASK_APPROVED');
  const detail = (await admin.get(`/admin/student-tasks/${t1.id}`)).data;
  assert.equal(detail.submissions.length, 2); assert.equal(detail.reviews.length, 2);
  assert.equal(detail.reviews[0].decision, 'Changes Requested'); assert.equal(detail.studentTask.studentId, undefined, 'no student id exposed');
  // history rows cannot be rewritten
  assert.throws(() => db.prepare("UPDATE task_submissions SET description = 'tampered' WHERE student_task_id = ?").run(t1.id));
  assert.throws(() => db.prepare("UPDATE task_reviews SET decision = 'Approved' WHERE student_task_id = ?").run(t1.id));
  // notifications: the student heard about the review, once per decision
  const types = db.prepare("SELECT type FROM notifications WHERE student_id = ? AND type IN ('task_approved', 'task_changes_requested')").all(sAsha.id).map((n) => n.type);
  assert.deepEqual(types.sort(), ['task_approved', 'task_changes_requested']);
  // an unassigned task (Ravi's enrollment has none) simply doesn't exist for him
  assert.equal(stRows(enrJava.id).length, 0);
  void t2;
});

test('editing a live task keeps every submission and review, bumps the version and records a revision; assigned tasks cannot be deleted', async () => {
  const { tasks } = (await admin.get(`/admin/internship-listings/${listingId}/tasks`)).data;
  const live = tasks.find((t) => t.assignedCount > 0);
  const ed = await admin.patch(`/admin/internship-tasks/${live.id}`, { shortDescription: 'Clearer one-line description of the task.', note: 'Clarified wording' });
  assert.equal(ed.status, 200); assert.equal(ed.data.task.version, live.version + 1); assert.ok(ed.data.note);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_submissions').get().n, 2);
  const rev = (await admin.get(`/admin/internship-tasks/${live.id}`)).data.revisions;
  assert.ok(rev.length >= 2 && rev.at(-1).note === 'Clarified wording');
  assert.equal((await admin.del(`/admin/internship-tasks/${live.id}`)).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM internship_tasks WHERE id = ?').get(live.id).n, 1);
  // unpublishing is the safe alternative and keeps the student's assignment
  assert.equal((await admin.patch(`/admin/internship-tasks/${live.id}/state`, { action: 'unpublish' })).status, 200);
  assert.ok(db.prepare('SELECT 1 FROM student_tasks WHERE task_id = ?').get(live.id));
  assert.equal((await admin.patch(`/admin/internship-tasks/${live.id}/state`, { action: 'publish' })).status, 200);
});

test('completion gate: required tasks must be approved before Completed (admin, legacy route, worker) and before a certificate; end dates alone never complete', async () => {
  const ev = await admin.get(`/admin/internships/${enr1.id}/completion-evaluation`);
  assert.equal(ev.status, 200); assert.equal(ev.data.taskRequirementsMet, false);
  assert.equal(ev.data.checks.find((c) => c.key === 'required_tasks_approved').status, 'not_met');
  await admin.patch(`/admin/internships/${enr1.id}/progress`, { progressPercent: 100 });
  const refused = await admin.patch(`/admin/internships/${enr1.id}/complete`, { confirmReviewed: true });
  assert.equal(refused.status, 409); assert.match(refused.data.error.message, /required task/);
  const legacy = await admin.patch(`/admin/internships/${enr1.id}/status`, { status: 'Completed' });
  assert.equal(legacy.status, 200 === legacy.status ? 409 : legacy.status, 'strict route');
  // certificate approved early + end date passed: the worker still does not complete it
  await admin.patch(`/admin/internships/${enr1.id}/certificate-decision`, { decision: 'Approved' });
  db.prepare('UPDATE enrollments SET expected_end_date = ? WHERE id = ?').run(day(-1), enr1.id);
  const cycle = await worker.runCycle({ now: new Date(), force: true });
  assert.equal(cycle.completed, 0); assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(enr1.id).status, 'Active');
  // approve every required task
  const sAsha = await student('asha@example.com');
  for (const t of stRows(enr1.id).filter((r) => r.is_required === 1)) {
    if (t.status !== 'Approved') {
      tasksSvc.submitWork(sAsha, t.id, { description: 'Completed this task and tested it locally.', repositoryUrl: `https://github.com/asha/work-${t.id.toLowerCase()}` });
      assert.equal((await admin.patch(`/admin/student-tasks/${t.id}/review`, { decision: 'Approved', confirmReviewed: true })).status, 200);
    }
  }
  const ok = await admin.get(`/admin/internships/${enr1.id}/completion-evaluation`); assert.equal(ok.data.taskRequirementsMet, true);
  // a certificate is still impossible before completion, and completion + decision are still separate human steps
  assert.equal((await admin.post('/admin/documents/certificate', { internshipId: enr1.id })).status, 409);
  const done = await worker.runCycle({ now: new Date(), force: true });
  assert.equal(done.completed, 1); assert.equal(done.certificatesIssued, 1, 'approved + completed + tasks done → certificate');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE enrollment_id = ? AND type = 'certificate' AND status = 'Issued'").get(enr1.id).n, 1);
});

test('certificate guard in depth: even a Completed internship cannot be certified if a required task is not approved', async () => {
  enr2 = await approvedEnrollment(client(srv.base), 'mia@example.com', 'Mia Das', listingId);
  assert.equal((await admin.patch(`/admin/internships/${enr2.id}/activate`, { startDate: day(-1) })).status, 200);
  assert.ok(stRows(enr2.id).length >= 4);
  // simulate a bad record: someone set Completed directly in the database
  db.prepare("UPDATE enrollments SET status = 'Completed', completed_at = ?, certificate_decision = 'Approved' WHERE id = ?").run(new Date().toISOString(), enr2.id);
  const r = await admin.post('/admin/documents/certificate', { internshipId: enr2.id });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'TASKS_INCOMPLETE');
  const rep = await admin.get(`/admin/internships/${enr2.id}/documents/certificate/eligibility`);
  assert.equal(rep.data.eligibility.eligible, false); assert.equal(rep.data.eligibility.code, 'TASKS_INCOMPLETE');
  const cycle = await worker.runCycle({ now: new Date(), force: true });
  assert.equal(cycle.certificatesIssued, 0); assert.ok(cycle.failures.some((f) => /TASKS_INCOMPLETE/.test(f.error)), 'the failure is recorded, not silent');
});

test('backward compatibility: an internship whose listing has no tasks completes and certifies exactly as before', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM student_tasks WHERE enrollment_id = ?').get(enrJava.id).n, 0);
  const ev = (await admin.get(`/admin/internships/${enrJava.id}/completion-evaluation`)).data;
  assert.equal(ev.taskRequirementsMet, true); assert.equal(ev.checks[0].status, 'not_applicable');
  await admin.patch(`/admin/internships/${enrJava.id}/progress`, { progressPercent: 100 });
  assert.equal((await admin.patch(`/admin/internships/${enrJava.id}/complete`, { confirmReviewed: true })).status, 200);
});

test('completion criteria: configurable per internship, validated, audited; final project requirement enforced', async () => {
  assert.equal((await admin.put(`/admin/internship-listings/${listingId}/completion-criteria`, { requiredTasksApprovedPercent: 10 })).status, 400);
  const set = await admin.put(`/admin/internship-listings/${listingId}/completion-criteria`, { requiredTasksApprovedPercent: 75, requireFinalProject: true });
  assert.equal(set.status, 200); assert.equal(set.data.criteria.requiredTasksApprovedPercent, 75);
  assert.equal((await admin.get(`/admin/internship-listings/${listingId}/completion-criteria`)).data.customized, true);
  const completion = await import('../src/services/completionEligibility.js'); const enrollments = await import('../src/db/enrollments.js');
  const ev = completion.evaluateTasks(enrollments.findById(enr2.id));
  assert.ok(ev.checks.some((c) => c.key === 'final_project_approved' && c.status === 'not_met'));
  assert.ok((await admin.get('/admin/audit-logs?pageSize=100')).data.events.some((e) => e.action === 'criteria.update'));
});

test('database integrity: foreign keys hold and the new tables cooperate with the old ones', async () => {
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.ok(db.pragma('user_version', { simple: true }) >= 14);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%task%'").all().map((r) => r.name);
  for (const n of ['idx_internship_tasks_listing', 'idx_internship_tasks_template', 'idx_student_tasks_student', 'idx_student_tasks_enrollment']) assert.ok(idx.includes(n), n);
});
