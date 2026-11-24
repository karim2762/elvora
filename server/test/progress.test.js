// Stage 05B: DB + service level tests (no HTTP, so no Express needed). Covers the timeline rules, the enrollment
// state machine, status history, ownership scoping in SQL and the migration.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file::memory:', SESSION_SECRET: 'test-secret-test-secret-test-secret-1234' });
let db, students, applications, enrollments, svc, buildTimeline, asha, ravi;

const profile = (email) => ({ fullName: 'Test', email, phone: '9876543210', passwordHash: 'x', college: 'C', degree: 'B.Tech', branch: 'CS', academicYear: '3rd Year', graduationYear: 2027, skills: [] });
const responses = { fullName: 'Test', phone: '9876543210', college: 'C', degree: 'B.Tech', branch: 'CS', academicYear: '3rd Year', skills: ['Python'], motivation: 'x'.repeat(60) };
const internship = { id: 'ELV-PY-001', title: 'Python Programming Essentials', category: 'python-development', durationDays: 30 };
const apply = (student, over = {}) => applications.createApplication({ student, internship: { ...internship, ...over }, responses });
const timelineOf = (app, student) => buildTimeline({ application: applications.findOwned(app.id, student.id), dates: applications.statusDates(app.id), enrollment: enrollments.findForApplicationOwned(app.id, student.id) });
const states = (t) => t.map((m) => m.state).join(',');

before(async () => {
  ({ db } = await import('../src/db/index.js'));
  students = await import('../src/db/students.js');
  applications = await import('../src/db/applications.js');
  enrollments = await import('../src/db/enrollments.js');
  svc = await import('../src/services/enrollments.js');
  ({ buildTimeline } = await import('../src/services/progress.js'));
  asha = students.createStudent(profile('asha@example.com'));
  ravi = students.createStudent(profile('ravi@example.com'));
});

test('migrations created the history, enrollment, document and notification tables (schema version 12 or later)', () => {
  assert.ok(db.pragma('user_version', { simple: true }) >= 12); // later stages add migrations (13 = Stage 08A indexes)
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'enrollments'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'application_status_history'").get());
});

test('a new application records its Submitted date and the timeline starts at step 1 only', () => {
  const a = apply(asha);
  assert.equal(applications.statusDates(a.id).Submitted, a.submittedAt);
  const t = timelineOf(a, asha);
  assert.equal(t.length, 7);
  assert.equal(states(t), 'completed,current,pending,pending,pending,pending,pending');
  assert.equal(t[0].date, a.submittedAt);
  assert.equal(t[1].date, null);
});

test('status changes are recorded with dates and drive the timeline; the future is never completed', () => {
  const a = apply(asha, { id: 'ELV-PY-002' });
  applications.setStatus(a.id, 'Under Review');
  let t = timelineOf(a, asha);
  assert.equal(states(t), 'completed,current,pending,pending,pending,pending,pending');
  assert.ok(t[1].date);
  applications.setStatus(a.id, 'Approved');
  t = timelineOf(a, asha);
  assert.equal(states(t), 'completed,completed,completed,current,pending,pending,pending');
  assert.ok(t[2].date);
  assert.equal(t[3].date, null); // activation has no record yet, so no date
});

test('setting the same status twice does not add a duplicate history row', () => {
  const a = apply(asha, { id: 'ELV-JV-001' });
  applications.setStatus(a.id, 'Under Review');
  applications.setStatus(a.id, 'Under Review');
  const n = db.prepare("SELECT COUNT(*) AS n FROM application_status_history WHERE application_id = ? AND status = 'Under Review'").get(a.id).n;
  assert.equal(n, 1);
});

test('rejected and cancelled applications stop the timeline and never show internship progress', () => {
  const r = apply(asha, { id: 'ELV-JV-002' });
  applications.setStatus(r.id, 'Under Review'); applications.setStatus(r.id, 'Rejected');
  assert.equal(states(timelineOf(r, asha)), 'completed,completed,stopped,pending,pending,pending,pending');
  const c = apply(asha, { id: 'ELV-WD-001' });
  applications.setStatus(c.id, 'Cancelled');
  assert.equal(states(timelineOf(c, asha)), 'completed,stopped,pending,pending,pending,pending,pending');
});

test('an enrollment can only be created for an approved application, once', () => {
  const a = apply(ravi);
  assert.throws(() => svc.createEnrollment(a.id, {}), (e) => e.status === 409 && e.code === 'APPLICATION_NOT_APPROVED');
  applications.setStatus(a.id, 'Approved');
  const e = svc.createEnrollment(a.id, { assignedProject: 'CLI task manager', learningObjectives: ['Write clean Python', ' Use Git ', ''], instructions: 'Read the brief first.' });
  assert.match(e.id, /^ELV-[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(e.status, 'Awaiting Start');
  assert.deepEqual(e.learningObjectives, ['Write clean Python', 'Use Git']);
  assert.equal(e.activatedAt, null);
  assert.throws(() => svc.createEnrollment(a.id, {}), (err) => err.status === 409 && err.code === 'ENROLLMENT_EXISTS');
  assert.throws(() => svc.createEnrollment('ELV-APP-AAAAAAAA', {}), (err) => err.status === 404);
});

test('full lifecycle: Awaiting Start → Active → Suspended → Active → Completed, with real dates', () => {
  const a = apply(asha, { id: 'ELV-WD-002', durationDays: 30 });
  applications.setStatus(a.id, 'Under Review'); applications.setStatus(a.id, 'Approved');
  const e0 = svc.createEnrollment(a.id, {});
  assert.equal(states(timelineOf(a, asha)), 'completed,completed,completed,current,pending,pending,pending');

  const e1 = svc.changeEnrollmentStatus(e0.id, { status: 'Active', startDate: '2026-12-01' });
  assert.equal(e1.status, 'Active');
  assert.equal(e1.startDate, '2026-12-01');
  assert.equal(e1.expectedEndDate, '2026-12-31'); // start + 30 days
  assert.ok(e1.activatedAt);
  let t = timelineOf(a, asha);
  assert.equal(states(t), 'completed,completed,completed,completed,current,pending,pending');
  assert.equal(t[3].date, e1.activatedAt);

  const e2 = svc.changeEnrollmentStatus(e0.id, { status: 'Suspended' });
  assert.ok(e2.suspendedAt);
  assert.equal(states(timelineOf(a, asha)), 'completed,completed,completed,completed,current,pending,pending');
  assert.match(timelineOf(a, asha)[4].note, /suspended/i);

  const e3 = svc.changeEnrollmentStatus(e0.id, { status: 'Active' });
  assert.equal(e3.suspendedAt, null);
  assert.equal(e3.activatedAt, e1.activatedAt); // original activation date is kept

  const e4 = svc.changeEnrollmentStatus(e0.id, { status: 'Completed' });
  assert.ok(e4.completedAt);
  t = timelineOf(a, asha);
  assert.equal(states(t), 'completed,completed,completed,completed,completed,completed,pending');
  assert.equal(t[5].date, e4.completedAt);
  assert.equal(t[6].date, null);
  assert.equal(t[6].state, 'pending'); // no certificate exists
});

test('invalid transitions are rejected', () => {
  const a = apply(ravi, { id: 'ELV-WD-003' });
  applications.setStatus(a.id, 'Approved');
  const e = svc.createEnrollment(a.id, {});
  for (const bad of ['Completed', 'Suspended', 'Awaiting Start']) {
    assert.throws(() => svc.changeEnrollmentStatus(e.id, { status: bad }), (err) => err.status === 409 && err.code === 'INVALID_TRANSITION', bad);
  }
  assert.throws(() => svc.changeEnrollmentStatus(e.id, { status: 'Nonsense' }), (err) => err.status === 400);
  assert.throws(() => svc.changeEnrollmentStatus(e.id, { status: 'Active', startDate: '2026-02-30' }), (err) => err.status === 400);
  svc.changeEnrollmentStatus(e.id, { status: 'Cancelled' });
  assert.equal(states(timelineOf(a, ravi)), 'completed,completed,completed,stopped,pending,pending,pending');
  assert.throws(() => svc.changeEnrollmentStatus(e.id, { status: 'Active' }), (err) => err.code === 'INVALID_TRANSITION'); // terminal
  assert.throws(() => svc.updateEnrollmentDetails(e.id, {}), (err) => err.code === 'ENROLLMENT_CLOSED');
});

test('Certificate Issued is completed only when an official certificate record exists', () => {
  const a = apply(asha, { id: 'ELV-AI-001' });
  applications.setStatus(a.id, 'Approved');
  const e = svc.createEnrollment(a.id, { startDate: '2026-12-01' });
  svc.changeEnrollmentStatus(e.id, { status: 'Active' });
  svc.changeEnrollmentStatus(e.id, { status: 'Completed' });
  assert.equal(timelineOf(a, asha)[6].state, 'pending');
  db.prepare("UPDATE enrollments SET certificate_id = 'ELV-CERT-TEST0001', certificate_issued_at = '2027-02-01T00:00:00.000Z' WHERE id = ?").run(e.id);
  const t = timelineOf(a, asha);
  assert.equal(t[6].state, 'completed');
  assert.equal(t[6].date, '2027-02-01T00:00:00.000Z');
});

test('ownership: a student only ever sees their own enrollments', () => {
  const mine = enrollments.listForStudent(asha.id);
  const theirs = enrollments.listForStudent(ravi.id);
  assert.ok(mine.length >= 2 && theirs.length >= 1);
  assert.ok(mine.every((e) => e.studentId === asha.id));
  assert.ok(theirs.every((e) => e.studentId === ravi.id));
  const raviApp = theirs[0].applicationId;
  assert.ok(!enrollments.findForApplicationOwned(raviApp, asha.id));
  assert.ok(!applications.findOwned(raviApp, asha.id));
});

test('student view hides internal fields and carries the timeline', () => {
  const list = svc.listStudentInternships(asha);
  assert.ok(list.length >= 2);
  for (const v of list) {
    assert.equal(v.studentId, undefined);
    assert.equal(v.applicationStatus, undefined);
    assert.equal(v.timeline.length, 7);
  }
  assert.ok(!JSON.stringify(list).match(/password|student_id|studentId|email|phone/i));
});

test('an enrollment disappears from the student view if its application is no longer approved', () => {
  const before = enrollments.listForStudent(asha.id).length;
  const a = apply(asha, { id: 'ELV-DS-001' });
  applications.setStatus(a.id, 'Approved');
  svc.createEnrollment(a.id, {});
  assert.equal(enrollments.listForStudent(asha.id).length, before + 1);
  applications.setStatus(a.id, 'Cancelled'); // the admin route blocks this; the read path must still hold if data changes
  assert.equal(enrollments.listForStudent(asha.id).length, before);
  assert.equal(enrollments.countByStatusForStudent(asha.id)['Awaiting Start'] ?? 0, 0);
});

test('list pagination and filter are scoped to the student', () => {
  const all = applications.pageForStudent(asha.id, { limit: 3, offset: 0 });
  assert.ok(all.total > 3 && all.rows.length === 3);
  assert.ok(all.rows.every((r) => r.status));
  const rej = applications.pageForStudent(asha.id, { status: 'Rejected', limit: 10, offset: 0 });
  assert.equal(rej.total, 1);
  assert.equal(rej.rows[0].status, 'Rejected');
  const none = applications.pageForStudent(ravi.id, { status: 'Rejected', limit: 10, offset: 0 });
  assert.equal(none.total, 0);
});

test('the migration backfills history for applications that existed before it', () => {
  // Simulate a pre-migration row: no history, status already changed.
  const a = apply(ravi, { id: 'ELV-DS-002' });
  db.prepare('DELETE FROM application_status_history WHERE application_id = ?').run(a.id);
  db.prepare("UPDATE applications SET status = 'Approved', updated_at = '2026-10-10T10:00:00.000Z' WHERE id = ?").run(a.id);
  db.exec(`INSERT INTO application_status_history (application_id, status, changed_at) SELECT id, 'Submitted', submitted_at FROM applications WHERE id = '${a.id}';
    INSERT INTO application_status_history (application_id, status, changed_at) SELECT id, status, updated_at FROM applications WHERE id = '${a.id}' AND status <> 'Submitted';`);
  const d = applications.statusDates(a.id);
  assert.equal(d.Approved, '2026-10-10T10:00:00.000Z');
  assert.equal(d['Under Review'], undefined); // never recorded, so unknown rather than invented
});
