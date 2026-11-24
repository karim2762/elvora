// Stage 07B (part 2): DB + service level tests (no HTTP, so no Express needed): student management and internship lifecycle.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file::memory:', SESSION_SECRET: 'test-secret-test-secret-test-secret-1234' });
let db, students, applications, enrollments, notifications, sa, lc, svc, asha, ravi, boss;
const admin = { id: 'admin-1', fullName: 'Priya Admin', email: 'priya@elvora.test', via: 'session' };
const profile = (email, over = {}) => ({ fullName: 'Test Student', email, phone: '9876543210', passwordHash: 'secret-hash', college: 'IIT Madras', degree: 'B.Tech', branch: 'CS', academicYear: '3rd Year', graduationYear: 2027, skills: [], ...over });
const responses = { fullName: 'Test', phone: '9876543210', college: 'C', degree: 'B.Tech', branch: 'CS', academicYear: '3rd Year', skills: ['Python'], motivation: 'x'.repeat(60) };
const internship = { id: 'ELV-PY-001', title: 'Python Programming Essentials', category: 'python-development', durationDays: 30 };
const approvedEnrollment = (student, id) => {
  const a = applications.createApplication({ student, internship: { ...internship, id }, responses });
  applications.changeStatus(a.id, 'Approved', { admin });
  return svc.createEnrollment(a.id, {});
};
const fail = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const notes = (s) => notifications.pageForStudent(s.id, { limit: 50, offset: 0 }).rows;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

before(async () => {
  ({ db } = await import('../src/db/index.js'));
  students = await import('../src/db/students.js');
  applications = await import('../src/db/applications.js');
  enrollments = await import('../src/db/enrollments.js');
  notifications = await import('../src/db/notifications.js');
  sa = await import('../src/services/studentAdmin.js');
  lc = await import('../src/services/internshipLifecycle.js');
  svc = await import('../src/services/enrollments.js');
  asha = students.createStudent(profile('asha@example.com', { fullName: 'Asha Verma' }));
  ravi = students.createStudent(profile('ravi@example.com', { fullName: 'Ravi Kumar', college: 'NIT Trichy', degree: 'MCA', academicYear: '1st Year' }));
  boss = students.createStudent(profile('boss@example.com', { fullName: 'Boss Admin' }));
  students.setRole(boss.id, 'admin');
});

test('migration 11 adds account status, account history, progress and internship events', () => {
  assert.ok(db.pragma('user_version', { simple: true }) >= 11); // later stages add migrations
  assert.equal(asha.accountStatus, 'active');
  for (const t of ['student_account_history', 'enrollment_events']) assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), t);
});

test('student list: search, filters, pagination; admin accounts are listed but flagged; secrets never appear', () => {
  const all = sa.listStudents({});
  assert.deepEqual(all.students.map((s) => s.email).sort(), ['asha@example.com', 'boss@example.com', 'ravi@example.com'].sort());
  assert.equal(all.pagination.total, 3);
  assert.deepEqual(all.counts, { all: 3, active: 3, suspended: 0 });
  assert.deepEqual(all.students.filter((s) => s.isAdmin).map((s) => s.email), ['boss@example.com']);
  assert.ok(!JSON.stringify(all).includes('secret-hash') && !JSON.stringify(all).toLowerCase().includes('password'));
  assert.ok(all.students.every((s) => !('phone' in s) && !('passwordHash' in s) && !('role' in s)));
  assert.equal(sa.listStudents({ q: 'ravi' }).students.length, 1);
  assert.equal(sa.listStudents({ q: 'NIT' }).students[0].fullName, 'Ravi Kumar');
  assert.equal(sa.listStudents({ q: asha.id }).students.length, 1);
  assert.equal(sa.listStudents({ q: '%' }).students.length, 0); // LIKE wildcards are escaped
  assert.equal(sa.listStudents({ degree: 'MCA' }).students.length, 1);
  assert.ok(sa.listStudents({ academicYear: '3rd Year' }).students.some((x) => x.email === 'asha@example.com'));
  assert.equal(sa.listStudents({ pageSize: '1' }).pagination.totalPages, 3);
  assert.equal(fail(() => sa.listStudents({ status: 'banned' })).status, 400);
  assert.equal(fail(() => sa.listStudents({ page: '0' })).status, 400);
  assert.equal(sa.studentDetail(boss.id).student.isAdmin, true); // readable, flagged as an administrator
  assert.equal(fail(() => sa.changeAccountStatus(boss.id, { status: 'suspended', reason: 'testing suspend' }, { id: boss.id, fullName: 'Boss' })).status, 404); // but never changeable here
  assert.equal(fail(() => sa.studentDetail('not-an-id')).status, 404);
});

test('student detail: profile, applications, internship history and documents; no password or role', () => {
  const e = approvedEnrollment(asha, 'ELV-PY-001');
  const d = sa.studentDetail(asha.id);
  assert.equal(d.student.email, 'asha@example.com');
  assert.equal(d.student.phone, '9876543210');
  assert.ok(!JSON.stringify(d).includes('secret-hash') && !('role' in d.student) && !('passwordHash' in d.student));
  assert.equal(d.applications.length, 1);
  assert.equal(d.applications[0].internshipRecordId, e.id);
  assert.equal(d.internships[0].status, 'Awaiting Start');
  assert.deepEqual(d.documents, []);
  assert.deepEqual(sa.studentDetail(ravi.id).applications, []); // no cross-student leakage
});

test('suspend / reactivate: reason required, sessions revoked, history + notification recorded, role untouched', () => {
  db.prepare('INSERT INTO sessions (token_hash, student_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run('h1', ravi.id, new Date().toISOString(), Date.now() + 1e6);
  assert.equal(fail(() => sa.changeAccountStatus(ravi.id, { status: 'suspended' }, admin)).fields.reason.includes('reason'), true);
  assert.equal(fail(() => sa.changeAccountStatus(ravi.id, { status: 'deleted' }, admin)).status, 400);
  assert.equal(fail(() => sa.changeAccountStatus(boss.id, { status: 'suspended', reason: 'trying to lock out an admin' }, admin)).status, 404);
  assert.equal(students.findById(boss.id).accountStatus, 'active');
  const r = sa.changeAccountStatus(ravi.id, { status: 'suspended', reason: 'Fake documents submitted', role: 'admin' }, admin);
  assert.equal(r.changed, true); assert.equal(r.student.accountStatus, 'suspended');
  assert.equal(students.findById(ravi.id).role, 'student'); // a role in the body is ignored
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE student_id = ?').get(ravi.id).n, 0);
  assert.deepEqual(r.accountHistory.map((h) => [h.from, h.to, h.reason, h.changedBy]), [['active', 'suspended', 'Fake documents submitted', 'Priya Admin']]);
  assert.ok(notes(ravi).some((n) => n.type === 'account_status' && n.title === 'Account suspended'));
  assert.equal(sa.changeAccountStatus(ravi.id, { status: 'suspended', reason: 'again again' }, admin).changed, false); // no duplicate history
  assert.equal(sa.studentDetail(ravi.id).accountHistory.length, 1);
  assert.equal(sa.listStudents({ status: 'suspended' }).students.length, 1);
  const back = sa.changeAccountStatus(ravi.id, { status: 'active' }, admin);
  assert.equal(back.student.accountStatus, 'active'); assert.equal(back.accountHistory.length, 2); // history is appended, never overwritten
});

test('lifecycle: activate sets/confirms the start date, records history and notifies the student', () => {
  const e = enrollments.findByApplication(sa.studentDetail(asha.id).applications[0].id);
  assert.equal(fail(() => lc.activate(e.id, { startDate: day(5) }, admin)).fields.startDate.length > 0, true); // future start refused
  assert.equal(fail(() => lc.activate(e.id, { startDate: '2020-02-30' }, admin)).status, 400);
  assert.equal(fail(() => lc.activate(e.id, { startDate: day(-2), expectedEndDate: day(-5) }, admin)).status, 400);
  const a = lc.activate(e.id, { startDate: day(-2), expectedEndDate: day(28) }, admin);
  assert.equal(a.status, 'Active'); assert.equal(a.startDate, day(-2)); assert.equal(a.expectedEndDate, day(28));
  assert.equal(fail(() => lc.activate(e.id, {}, admin)).code, 'INVALID_TRANSITION');
  const ev = enrollments.eventsFor(e.id);
  assert.deepEqual([ev[0].kind, ev[0].from, ev[0].to, ev[0].by], ['status', 'Awaiting Start', 'Active', 'Priya Admin']);
  assert.ok(notes(asha).some((n) => n.type === 'internship_activated'));
});

test('lifecycle: progress is validated, recorded, visible to the student, and only while Active', () => {
  const e = enrollments.findByApplication(sa.studentDetail(asha.id).applications[0].id);
  for (const bad of [-1, 101, 50.5, '60', null, undefined]) assert.equal(fail(() => lc.updateProgress(e.id, { progressPercent: bad }, admin)).status, 400, String(bad));
  assert.equal(lc.updateProgress(e.id, { progressPercent: 60, note: 'Milestone 2 reviewed' }, admin).progressPercent, 60);
  assert.equal(svc.listStudentInternships(asha)[0].progressPercent, 60); // student dashboard data
  assert.ok(enrollments.eventsFor(e.id).some((x) => x.kind === 'progress' && x.detail.includes('not recorded → 60%') && x.by === 'Priya Admin'));
  assert.ok(notes(asha).some((n) => n.message.includes('60%')));
  const n = enrollments.eventsFor(e.id).length;
  lc.updateProgress(e.id, { progressPercent: 60 }, admin); // same value: nothing recorded
  assert.equal(enrollments.eventsFor(e.id).length, n);
});

test('completion is refused until every check passes AND the admin confirms; then it is recorded', () => {
  const e = enrollments.findByApplication(sa.studentDetail(asha.id).applications[0].id);
  let err = fail(() => lc.complete(e.id, { confirmReviewed: true }, admin)); // progress is 60
  assert.equal(err.code, 'COMPLETION_CHECKS_FAILED'); assert.equal(err.details.checks.find((c) => c.key === 'progress').passed, false);
  assert.equal(fail(() => lc.complete(e.id, { confirmReviewed: true }, { via: 'key' })).status, 403); // no signed-in administrator
  lc.updateProgress(e.id, { progressPercent: 100 }, admin);
  err = fail(() => lc.complete(e.id, {}, admin)); // checks pass but no confirmation
  assert.equal(err.status, 400); assert.ok(err.fields.confirmReviewed);
  assert.equal(enrollments.findById(e.id).status, 'Active');
  const done = lc.complete(e.id, { confirmReviewed: true, note: 'All milestones accepted' }, admin);
  assert.equal(done.status, 'Completed'); assert.ok(done.completedAt);
  const last = enrollments.eventsFor(e.id).at(-1);
  assert.deepEqual([last.to, last.by, last.detail], ['Completed', 'Priya Admin', 'All milestones accepted']);
  assert.ok(notes(asha).some((n) => n.type === 'internship_completed'));
  assert.equal(fail(() => lc.complete(e.id, { confirmReviewed: true }, admin)).code, 'INVALID_TRANSITION'); // final
  assert.equal(fail(() => lc.updateProgress(e.id, { progressPercent: 90 }, admin)).code, 'NOT_ACTIVE');
  assert.equal(fail(() => lc.cancel(e.id, { reason: 'too late to cancel' }, admin)).code, 'INVALID_TRANSITION');
  assert.equal(enrollments.eventsFor(e.id).length, 4); // activation, progress 60, progress 100, completion
});

test('suspend and cancel need a reason; the reason is saved and shown to the student; history is preserved', () => {
  const e = approvedEnrollment(ravi, 'ELV-PY-002');
  assert.equal(fail(() => lc.suspend(e.id, {}, admin)).status, 400); // not active yet AND no reason: validation first
  lc.activate(e.id, { startDate: day(-1) }, admin);
  assert.equal(fail(() => lc.suspend(e.id, { reason: 'x' }, admin)).fields.reason.length > 0, true);
  const s = lc.suspend(e.id, { reason: 'Inactive for two weeks' }, admin);
  assert.equal(s.status, 'Suspended'); assert.ok(s.suspendedAt);
  assert.ok(notes(ravi).some((n) => n.title === 'Internship suspended' && n.message.includes('Inactive for two weeks')));
  assert.equal(fail(() => lc.updateProgress(e.id, { progressPercent: 10 }, admin)).code, 'NOT_ACTIVE');
  assert.equal(lc.activate(e.id, {}, admin).status, 'Active'); // resume
  const c = lc.cancel(e.id, { reason: 'Student requested withdrawal' }, admin);
  assert.equal(c.status, 'Cancelled'); assert.ok(c.cancelledAt && c.startDate); // dates preserved
  assert.deepEqual(enrollments.eventsFor(e.id).map((x) => `${x.from}>${x.to}`), ['Awaiting Start>Active', 'Active>Suspended', 'Suspended>Active', 'Active>Cancelled']);
  const view = lc.lifecycleView(e.id);
  assert.equal(view.allowedActions.complete, false); assert.ok(!('studentId' in view.internship));
});

test('the legacy status service (automation, API key) still works and records "Automation" with no actor', () => {
  const x = students.createStudent(profile('x@example.com'));
  const e = approvedEnrollment(x, 'ELV-PY-003');
  svc.changeEnrollmentStatus(e.id, { status: 'Active' });
  assert.equal(enrollments.eventsFor(e.id)[0].by, 'Automation');
});
