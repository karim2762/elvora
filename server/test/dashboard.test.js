import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const ADMIN_KEY = 'a-long-random-admin-key-for-tests-1234567890';
let srv, asha, ravi, newbie, anon;
before(async () => {
  srv = await startServer({ ADMIN_API_KEY: ADMIN_KEY, RATE_LIMIT_APPLY_MAX: '1000' });
  [asha, ravi, newbie, anon] = [1, 2, 3, 4].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  assert.equal((await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar' }))).status, 201);
  assert.equal((await newbie.post('/auth/register', validStudent({ email: 'new@example.com', fullName: 'New Student' }))).status, 201);
});
after(() => srv.close());

test('dashboard requires a signed-in student', async () => {
  const r = await anon.get('/student/dashboard');
  assert.equal(r.status, 401);
});

test('admin key alone does not open the student dashboard', async () => {
  assert.equal((await anon.get('/student/dashboard', { 'X-Admin-Key': ADMIN_KEY })).status, 401);
});

test('a student with no applications gets zero counts and an empty list', async () => {
  const r = await newbie.get('/student/dashboard');
  assert.equal(r.status, 200);
  assert.equal(r.data.stats.totalApplications, 0);
  assert.equal(r.data.stats.approvedApplications, 0);
  assert.deepEqual(r.data.recentApplications, []);
  assert.equal(r.data.student.fullName, 'New Student');
});

test('statistics and recent applications come from the signed-in student only', async () => {
  const a = (await asha.post('/applications', validApplication())).data.application;
  await ravi.post('/applications', validApplication({ internshipId: 'ELV-PY-001', fullName: 'Ravi Kumar' }));
  assert.equal((await anon.patch(`/admin/applications/${a.id}/status`, { status: 'Approved' }, { 'X-Admin-Key': ADMIN_KEY })).status, 200);

  const mine = (await asha.get('/student/dashboard')).data;
  assert.equal(mine.stats.totalApplications, 1);
  assert.equal(mine.stats.approvedApplications, 1);
  assert.equal(mine.recentApplications.length, 1);
  assert.equal(mine.recentApplications[0].id, a.id);
  assert.equal(mine.recentApplications[0].status, 'Approved');

  const theirs = (await ravi.get('/student/dashboard')).data;
  assert.equal(theirs.stats.totalApplications, 1);
  assert.equal(theirs.stats.approvedApplications, 0);
  assert.notEqual(theirs.recentApplications[0].id, a.id);
});

test('student IDs supplied by the caller are ignored', async () => {
  const me = (await asha.get('/auth/me')).data.user;
  const r = await ravi.get(`/student/dashboard?studentId=${me.id}`, { 'X-Student-Id': me.id });
  assert.equal(r.data.student.fullName, 'Ravi Kumar');
});

test('internship counts come from the student’s enrollment records (zero is a real zero now)', async () => {
  const s = (await asha.get('/student/dashboard')).data.stats;
  assert.equal(s.internshipsTracked, true);
  assert.equal(s.activeInternships, 0);
  assert.equal(s.completedInternships, 0);
});

test('response carries no private fields and is not cached', async () => {
  const r = await asha.get('/student/dashboard');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.ok(!JSON.stringify(r.data).match(/password|hash|student_id|studentId|phone|email/i));
});
