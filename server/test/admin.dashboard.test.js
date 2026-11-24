// Stage 07A: role-based admin access and the admin overview API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'a-long-random-admin-key-for-tests-1234567890';
const ADMIN_PW = 'Adm1n!Strong#Pass';
let srv, asha, boss, anon, students;

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, RATE_LIMIT_APPLY_MAX: '1000' });
  students = await import('../src/db/students.js'); // same in-memory database as the running server
  [asha, boss, anon] = [1, 2, 3].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  // An administrator is created out of band (scripts/create-admin.mjs does exactly this): register, then authorize on the server.
  const reg = await boss.post('/auth/register', validStudent({ fullName: 'Kishore Kumar', email: 'boss@example.com', password: ADMIN_PW, confirmPassword: ADMIN_PW }));
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.role, 'student'); // registering never yields an admin
  assert.equal(students.setRole(reg.data.user.id, 'admin'), true);
  boss.reset();
});
after(() => srv.close());

test('GET /admin/dashboard: anonymous 401, student 403, API key alone 401, administrator 200', async () => {
  assert.equal((await anon.get('/admin/dashboard')).status, 401);
  const s = await asha.get('/admin/dashboard');
  assert.equal(s.status, 403); assert.equal(s.data.error.code, 'ADMIN_REQUIRED');
  assert.equal((await anon.get('/admin/dashboard', { 'X-Admin-Key': KEY })).status, 401); // the shared key is not a dashboard identity
  assert.equal((await boss.post('/auth/admin/login', { email: 'boss@example.com', password: ADMIN_PW })).status, 200);
  const ok = await boss.get('/admin/dashboard');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.data.admin.email, 'boss@example.com');
  assert.ok(!JSON.stringify(ok.data).includes('passwordHash'));
});

test('admin login: students and wrong passwords get the same generic failure and no session', async () => {
  const c = client(srv.base);
  const student = await c.post('/auth/admin/login', { email: 'asha@example.com', password: 'Str0ng!Pass1' }); // correct student password
  assert.equal(student.status, 401); assert.equal(student.data.error.code, 'INVALID_CREDENTIALS'); assert.equal(student.setCookie.length, 0);
  const wrong = await c.post('/auth/admin/login', { email: 'boss@example.com', password: 'Wrong!Pass123' });
  assert.equal(wrong.status, 401); assert.equal(wrong.data.error.message, student.data.error.message);
  assert.equal((await c.post('/auth/admin/login', { email: 'nobody@example.com', password: 'Wrong!Pass123' })).status, 401);
  assert.equal((await c.get('/admin/dashboard')).status, 401);
});

test('a role can not be granted through any request field', async () => {
  const c = client(srv.base);
  const r = await c.post('/auth/register', validStudent({ fullName: 'Mallory', email: 'm@example.com', role: 'admin', isAdmin: true }));
  assert.equal(r.status, 201); assert.equal(r.data.user.role, 'student');
  const put = await c.put('/students/me', { fullName: 'Mallory', phone: '+91 98765 43210', college: 'X College', degree: 'B.Tech', branch: 'CSE', academicYear: '3rd Year', graduationYear: new Date().getFullYear() + 1, skills: [], role: 'admin' });
  assert.ok([200, 400].includes(put.status));
  assert.equal((await c.get('/auth/me')).data.user.role, 'student');
  assert.equal((await c.get('/admin/dashboard')).status, 403);
});

test('statistics are real counts; administrators are not students', async () => {
  const before0 = (await boss.get('/admin/dashboard')).data.stats;
  assert.equal(before0.totalStudents, 2); // Asha and Mallory, not the administrator
  assert.equal(before0.totalApplications, 0); assert.equal(before0.documentsIssued, 0);
  assert.ok(before0.totalInternships > 0);
  const a1 = await asha.post('/applications', validApplication({ internshipId: 'ELV-PY-001' }));
  const a2 = await asha.post('/applications', validApplication({ internshipId: 'ELV-PY-002' }));
  assert.equal(a1.status, 201); assert.equal(a2.status, 201);
  assert.equal((await boss.patch(`/admin/applications/${a1.data.application.id}/status`, { status: 'Approved' })).status, 200); // admin session also works on the existing console API
  const d = (await boss.get('/admin/dashboard')).data;
  assert.equal(d.stats.totalApplications, 2); assert.equal(d.stats.approvedApplications, 1); assert.equal(d.stats.pendingApplications, 1);
  assert.equal(d.breakdown.applications.Approved, 1);
});

test('recent activity lists real events, newest first, with references', async () => {
  const { recentActivity } = (await boss.get('/admin/dashboard')).data;
  const types = recentActivity.map((e) => e.type);
  for (const t of ['student_registered', 'application_submitted', 'application_status']) assert.ok(types.includes(t), `missing ${t}`);
  assert.ok(recentActivity.length <= 10);
  const times = recentActivity.map((e) => e.at); assert.deepEqual(times, [...times].sort().reverse());
  assert.ok(recentActivity.every((e) => e.description && e.reference && !Number.isNaN(Date.parse(e.at))));
  assert.ok(!recentActivity.some((e) => /Kishore Kumar/.test(e.description) && e.type === 'student_registered')); // the administrator's own sign-up is not a student event
});

test('an administrator session reaches the existing console API; students and anonymous users do not', async () => {
  assert.equal((await boss.get('/admin/me')).status, 200);
  assert.equal((await asha.get('/admin/me')).status, 403); // key is configured, student has none
  assert.equal((await asha.get('/admin/applications')).status, 403);
  assert.equal((await anon.get('/admin/me', { 'X-Admin-Key': KEY })).status, 200); // existing key access is unchanged
});

test('announcements reach students only, never administrator accounts', async () => {
  const r = await boss.post('/admin/announcements', { title: 'Welcome', message: 'Hello everyone', confirm: true, confirmRecipientCount: 2 });
  assert.equal(r.status, 201); assert.equal(r.data.delivered, 2);
});

test('logging out ends administrator access', async () => {
  assert.equal((await boss.post('/auth/logout')).status, 204);
  assert.equal((await boss.get('/admin/dashboard')).status, 401);
});
