// Stage 07B (part 2) over HTTP: authorization + API behaviour of student management and the lifecycle actions.
// Needs the server dependencies (npm install). The same rules are covered without Express in stage07b2.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'a-long-random-admin-key-for-tests-1234567890';
const PW = 'Adm1n!Strong#Pass';
let srv, asha, ravi, boss, anon, studentsDb, ashaId, raviId, enrId;
const adminH = { 'X-Admin-Key': KEY };

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, RATE_LIMIT_APPLY_MAX: '1000' });
  studentsDb = await import('../src/db/students.js');
  [asha, ravi, boss, anon] = [1, 2, 3, 4].map(() => client(srv.base));
  ashaId = (await asha.post('/auth/register', validStudent())).data.user.id;
  raviId = (await ravi.post('/auth/register', validStudent({ fullName: 'Ravi Kumar', email: 'ravi@example.com' }))).data.user.id;
  const reg = await boss.post('/auth/register', validStudent({ fullName: 'Kishore Kumar', email: 'boss@example.com', password: PW, confirmPassword: PW }));
  studentsDb.setRole(reg.data.user.id, 'admin'); boss.reset();
  assert.equal((await boss.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  const appId = (await asha.post('/applications', validApplication())).data.application.id;
  assert.equal((await boss.patch(`/admin/applications/${appId}/status`, { status: 'Approved' })).status, 200);
  enrId = (await boss.post(`/admin/applications/${appId}/internship`, {})).data.internship.id;
});
after(() => srv.close());

test('student and lifecycle endpoints reject anonymous callers, students and the shared API key', async () => {
  const calls = [['get', '/admin/students'], ['get', `/admin/students/${ashaId}`], ['patch', `/admin/students/${ashaId}/status`, { status: 'suspended', reason: 'no reason given' }],
    ['get', `/admin/internships/${enrId}/lifecycle`], ['patch', `/admin/internships/${enrId}/activate`, {}], ['patch', `/admin/internships/${enrId}/progress`, { progressPercent: 10 }],
    ['patch', `/admin/internships/${enrId}/suspend`, { reason: 'because I said' }], ['patch', `/admin/internships/${enrId}/cancel`, { reason: 'because I said' }], ['patch', `/admin/internships/${enrId}/complete`, { confirmReviewed: true }]];
  for (const [m, p, b] of calls) {
    for (const [who, h] of [[anon, undefined], [ravi, undefined], [anon, adminH]]) {
      const r = await who[m](p, b, h);
      assert.ok([401, 403].includes(r.status), `${m} ${p} -> ${r.status}`);
    }
  }
  assert.equal(studentsDb.findById(ashaId).accountStatus, 'active');
});

test('admin lists and opens students without secrets; filters and search work', async () => {
  const r = await boss.get('/admin/students?q=ravi');
  assert.equal(r.status, 200); assert.equal(r.data.students.length, 1);
  assert.ok(!JSON.stringify(r.data).toLowerCase().includes('hash'));
  assert.equal((await boss.get('/admin/students?status=bogus')).status, 400);
  const d = await boss.get(`/admin/students/${ashaId}`);
  assert.equal(d.status, 200); assert.equal(d.data.applications.length, 1); assert.ok(!('role' in d.data.student));
  assert.equal((await boss.get('/admin/students/00000000-0000-4000-8000-000000000000')).status, 404);
});

test('suspension signs the student out, blocks login (correct password) and reactivation restores access', async () => {
  assert.equal((await ravi.get('/auth/me')).data.user.email, 'ravi@example.com');
  assert.equal((await boss.patch(`/admin/students/${raviId}/status`, { status: 'suspended' })).status, 400); // reason required
  assert.equal((await boss.patch(`/admin/students/${raviId}/status`, { status: 'suspended', reason: 'Policy violation found' })).status, 200);
  assert.equal((await ravi.get('/auth/me')).data.user, null);
  const login = await ravi.post('/auth/login', { email: 'ravi@example.com', password: 'Str0ng!Pass1' });
  assert.equal(login.status, 403); assert.equal(login.data.error.code, 'ACCOUNT_SUSPENDED');
  assert.equal((await boss.patch(`/admin/students/${raviId}/status`, { status: 'active' })).status, 200);
  assert.equal((await ravi.post('/auth/login', { email: 'ravi@example.com', password: 'Str0ng!Pass1' })).status, 200);
});

test('lifecycle over HTTP: completion blocked until checks pass, then recorded; the student sees progress', async () => {
  assert.equal((await boss.patch(`/admin/internships/${enrId}/activate`, {})).data.internship.status, 'Active');
  const early = await boss.patch(`/admin/internships/${enrId}/complete`, { confirmReviewed: true });
  assert.equal(early.status, 409); assert.equal(early.data.error.code, 'COMPLETION_CHECKS_FAILED');
  assert.equal((await boss.patch(`/admin/internships/${enrId}/progress`, { progressPercent: 100 })).status, 200);
  assert.equal((await asha.get('/student/internships')).data.internships[0].progressPercent, 100);
  // the generic status route must not bypass the checks for a signed-in administrator
  assert.equal((await boss.patch(`/admin/internships/${enrId}/status`, { status: 'Completed' })).status, 400);
  assert.equal((await boss.patch(`/admin/internships/${enrId}/complete`, { confirmReviewed: true })).data.internship.status, 'Completed');
  const view = await boss.get(`/admin/internships/${enrId}/lifecycle`);
  assert.ok(view.data.events.length >= 3 && view.data.events.every((e) => e.by));
});
