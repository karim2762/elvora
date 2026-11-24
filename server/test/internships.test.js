// Stage 05B HTTP tests: My Applications listing/filter/pagination/ownership and My Internship visibility.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const ADMIN_KEY = 'a-long-random-admin-key-for-tests-1234567890';
const adminH = { 'X-Admin-Key': ADMIN_KEY };
let srv, asha, ravi, anon, ashaApps, ravi1;

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: ADMIN_KEY, RATE_LIMIT_APPLY_MAX: '1000' });
  [asha, ravi, anon] = [1, 2, 3].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  assert.equal((await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar' }))).status, 201);
  const ids = ['ELV-PY-001', 'ELV-PY-002', 'ELV-JV-001', 'ELV-JV-002', 'ELV-WD-001'];
  ashaApps = [];
  for (const internshipId of ids) {
    const r = await asha.post('/applications', validApplication({ internshipId }));
    assert.equal(r.status, 201);
    ashaApps.push(r.data.application);
  }
  ravi1 = (await ravi.post('/applications', validApplication({ fullName: 'Ravi Kumar' }))).data.application;
});
after(() => srv.close());

const setStatus = (id, status) => anon.patch(`/admin/applications/${id}/status`, { status }, adminH);

test('applications list requires sign-in', async () => {
  assert.equal((await anon.get('/applications/my')).status, 401);
  assert.equal((await anon.get('/student/internships')).status, 401);
  assert.equal((await anon.get('/student/internships', adminH)).status, 401);
});

test('list returns only my applications, with counts and pagination', async () => {
  const r = await asha.get('/applications/my');
  assert.equal(r.status, 200);
  assert.equal(r.data.applications.length, 5);
  assert.equal(r.data.counts.All, 5);
  assert.equal(r.data.counts.Submitted, 5);
  assert.deepEqual(r.data.pagination, { page: 1, pageSize: 10, total: 5, totalPages: 1 });
  assert.ok(!r.data.applications.some((a) => a.id === ravi1.id));
});

test('pagination splits the list and clamps a page past the end', async () => {
  const p1 = (await asha.get('/applications/my?page=1&pageSize=2')).data;
  const p3 = (await asha.get('/applications/my?page=3&pageSize=2')).data;
  assert.equal(p1.applications.length, 2);
  assert.equal(p3.applications.length, 1);
  assert.equal(p1.pagination.totalPages, 3);
  const far = (await asha.get('/applications/my?page=99&pageSize=2')).data;
  assert.equal(far.pagination.page, 3);
  assert.equal(far.applications.length, 1);
  const ids = new Set([...p1.applications, ...(await asha.get('/applications/my?page=2&pageSize=2')).data.applications, ...p3.applications].map((a) => a.id));
  assert.equal(ids.size, 5);
});

test('status filter works for every status and rejects unknown values', async () => {
  await setStatus(ashaApps[0].id, 'Under Review');
  await setStatus(ashaApps[1].id, 'Approved');
  await setStatus(ashaApps[2].id, 'Rejected');
  await setStatus(ashaApps[3].id, 'Cancelled');
  const expected = { Submitted: 1, 'Under Review': 1, Approved: 1, Rejected: 1, Cancelled: 1 };
  for (const [status, n] of Object.entries(expected)) {
    const r = await asha.get(`/applications/my?status=${encodeURIComponent(status)}`);
    assert.equal(r.status, 200, status);
    assert.equal(r.data.applications.length, n, status);
    assert.ok(r.data.applications.every((a) => a.status === status));
    assert.equal(r.data.counts[status], n);
  }
  assert.equal((await asha.get('/applications/my?status=All')).data.applications.length, 5);
  assert.equal((await asha.get('/applications/my?status=Hacked')).status, 400);
  assert.equal((await asha.get('/applications/my?page=0')).status, 400);
  assert.equal((await asha.get('/applications/my?pageSize=500')).status, 400);
  assert.equal((await asha.get("/applications/my?status=Approved' OR '1'='1")).status, 400);
});

test('the filter never leaks another student’s rows, even with injected IDs', async () => {
  const me = (await asha.get('/auth/me')).data.user;
  const r = await ravi.get(`/applications/my?studentId=${me.id}`, { 'X-Student-Id': me.id });
  assert.equal(r.data.applications.length, 1);
  assert.equal(r.data.applications[0].id, ravi1.id);
});

test('application details include a timeline; other students’ applications are 404', async () => {
  const mine = await asha.get(`/applications/${ashaApps[1].id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.timeline.length, 7);
  assert.equal(mine.data.timeline[0].state, 'completed');
  assert.equal(mine.data.timeline[2].state, 'completed'); // Approved
  assert.equal(mine.data.timeline[3].state, 'current');   // waiting for an internship to be set up
  assert.equal(mine.data.timeline[6].state, 'pending');
  assert.equal((await ravi.get(`/applications/${ashaApps[1].id}`)).status, 404);
  assert.equal((await ravi.get('/applications/ELV-APP-AAAAAAAA')).status, 404);
  assert.equal((await ravi.get('/applications/..%2f..%2fadmin')).status, 404);
});

test('students have no way to change application or internship status', async () => {
  for (const [m, p] of [['patch', `/applications/${ashaApps[0].id}`], ['put', `/applications/${ashaApps[0].id}`], ['patch', `/applications/${ashaApps[0].id}/status`]]) {
    const r = await asha[m](p, { status: 'Approved' });
    assert.ok([404, 405].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
  assert.equal((await asha.patch(`/admin/applications/${ashaApps[0].id}/status`, { status: 'Approved' })).status, 403);
  assert.equal((await asha.post('/student/internships', { status: 'Active' })).status, 404);
  assert.equal((await asha.patch('/student/internships/ELV-INT-AAAAAAAA', { status: 'Active' })).status, 404);
  assert.equal((await asha.patch('/admin/internships/ELV-INT-AAAAAAAA/status', { status: 'Active' })).status, 403);
  assert.equal((await asha.post(`/admin/applications/${ashaApps[1].id}/internship`, {})).status, 403);
  assert.equal((await asha.get(`/applications/${ashaApps[0].id}`)).data.application.status, 'Under Review'); // unchanged
});

test('no internship is shown until an administrator sets one up on an approved application', async () => {
  assert.deepEqual((await asha.get('/student/internships')).data.internships, []);
  // not approved -> cannot create
  assert.equal((await anon.post(`/admin/applications/${ashaApps[0].id}/internship`, {}, adminH)).status, 409);
  // approved -> created as Awaiting Start
  const c = await anon.post(`/admin/applications/${ashaApps[1].id}/internship`, { assignedProject: 'CLI task manager', learningObjectives: ['Write clean Python'], instructions: 'Read the brief.' }, adminH);
  assert.equal(c.status, 201);
  assert.equal(c.data.internship.status, 'Awaiting Start');
  assert.equal(c.data.internship.studentId, undefined);
  assert.equal((await anon.post(`/admin/applications/${ashaApps[1].id}/internship`, {}, adminH)).status, 409);

  const list = (await asha.get('/student/internships')).data.internships;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, c.data.internship.id);
  assert.equal(list[0].status, 'Awaiting Start');
  assert.equal(list[0].assignedProject, 'CLI task manager');
  assert.equal(list[0].timeline[3].state, 'current');
  assert.equal(list[0].timeline[4].state, 'pending');
  // Ravi cannot see Asha's internship
  assert.deepEqual((await ravi.get('/student/internships')).data.internships, []);
  assert.ok(!JSON.stringify(list).match(/password|student_id|studentId|email|phone/i));
});

test('administrator drives the internship statuses; the student sees each one', async () => {
  const id = (await asha.get('/student/internships')).data.internships[0].id;
  const put = (body) => anon.patch(`/admin/internships/${id}/status`, body, adminH);
  assert.equal((await put({ status: 'Completed' })).status, 409); // can't skip Active
  const act = await put({ status: 'Active', startDate: '2026-12-01' });
  assert.equal(act.status, 200);
  let v = (await asha.get('/student/internships')).data.internships[0];
  assert.equal(v.status, 'Active');
  assert.equal(v.startDate, '2026-12-01');
  assert.equal(v.expectedEndDate, '2026-12-08'); // ELV-PY-002 is a 7-day internship: 1 Dec + 7 days
  assert.equal(v.timeline[3].state, 'completed');
  assert.equal(v.timeline[4].state, 'current');
  assert.equal(v.timeline[5].state, 'pending');

  assert.equal((await put({ status: 'Suspended' })).status, 200);
  assert.equal((await asha.get('/student/internships')).data.internships[0].status, 'Suspended');
  assert.equal((await put({ status: 'Active' })).status, 200);
  assert.equal((await put({ status: 'Completed' })).status, 200);
  v = (await asha.get('/student/internships')).data.internships[0];
  assert.equal(v.status, 'Completed');
  assert.equal(v.timeline[5].state, 'completed');
  assert.equal(v.timeline[6].state, 'pending'); // no certificate exists
  assert.equal(v.certificate, null);
  assert.equal((await put({ status: 'Active' })).status, 409); // terminal
  const dash = (await asha.get('/student/dashboard')).data.stats;
  assert.equal(dash.completedInternships, 1);
  assert.equal(dash.activeInternships, 0);
});

test('an application with an internship cannot be moved away from Approved', async () => {
  assert.equal((await setStatus(ashaApps[1].id, 'Cancelled')).status, 409);
  assert.equal((await setStatus(ashaApps[1].id, 'Approved')).status, 200);
});

test('admin internship routes validate IDs and input', async () => {
  assert.equal((await anon.patch('/admin/internships/not-an-id/status', { status: 'Active' }, adminH)).status, 404);
  assert.equal((await anon.patch('/admin/internships/ELV-INT-AAAAAAAA/status', { status: 'Active' }, adminH)).status, 404);
  assert.equal((await anon.post('/admin/applications/bad-id/internship', {}, adminH)).status, 404);
  assert.equal((await anon.patch('/admin/internships/ELV-INT-AAAAAAAA/status', { status: 'Active' })).status, 401);
});
