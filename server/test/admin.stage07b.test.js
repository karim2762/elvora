// Stage 07B over HTTP: authorization + API behaviour of internship listings and application review.
// Needs the server dependencies (npm install). The same rules are covered without Express in stage07b.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'a-long-random-admin-key-for-tests-1234567890';
const PW = 'Adm1n!Strong#Pass';
let srv, asha, boss, anon, students, appId;
const body = (o = {}) => ({
  title: 'HTTP Listing Test', category: 'data-science', description: 'A listing created through the admin API in tests.', durationDays: 30, skills: ['SQL'],
  outcomes: ['Query data'], eligibility: { who: 'Anyone curious about data.', knowledge: [] }, type: 'Self-Paced', difficulty: 'Beginner', ...o,
});

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, RATE_LIMIT_APPLY_MAX: '1000' });
  students = await import('../src/db/students.js');
  [asha, boss, anon] = [1, 2, 3].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  const reg = await boss.post('/auth/register', validStudent({ fullName: 'Kishore Kumar', email: 'boss@example.com', password: PW, confirmPassword: PW }));
  students.setRole(reg.data.user.id, 'admin'); boss.reset();
  assert.equal((await boss.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  appId = (await asha.post('/applications', validApplication())).data.application.id;
});
after(() => srv.close());

test('every 07B admin endpoint rejects anonymous callers and students', async () => {
  const calls = [['get', '/admin/internship-listings'], ['post', '/admin/internship-listings', body()], ['patch', '/admin/internship-listings/ELV-PY-001', { title: 'x' }],
    ['patch', '/admin/internship-listings/ELV-PY-001/state', { action: 'archive' }], ['delete', '/admin/internship-listings/ELV-PY-001'],
    ['get', `/admin/applications/${appId}`], ['post', `/admin/applications/${appId}/notes`, { note: 'x' }], ['patch', `/admin/applications/${appId}/status`, { status: 'Approved' }]];
  for (const [m, p, b] of calls) {
    for (const who of [anon, asha]) {
      const r = m === 'delete' ? await who.del(p) : await who[m](p, b);
      assert.ok([401, 403, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
    }
  }
  assert.equal((await asha.get('/admin/internship-listings')).status, 403); // a student session is not an admin credential (no key)
});

test('listing lifecycle through the API, and public pages reflect it', async () => {
  const c = await boss.post('/admin/internship-listings', body());
  assert.equal(c.status, 201); const id = c.data.internship.id;
  assert.equal((await anon.get(`/internships/${id}`)).status, 404); // draft is not public
  assert.equal((await boss.patch(`/admin/internship-listings/${id}/state`, { action: 'publish' })).status, 200);
  assert.equal((await anon.get(`/internships/${id}`)).data.data.title, 'HTTP Listing Test');
  assert.ok((await anon.get('/internships')).data.data.some((i) => i.id === id));
  assert.equal((await boss.patch(`/admin/internship-listings/${id}`, { title: 'HTTP Listing Renamed' })).status, 200);
  assert.equal((await anon.get(`/internships/${id}`)).data.data.title, 'HTTP Listing Renamed');
  assert.equal((await boss.post('/admin/internship-listings', body({ durationDays: 45 }))).status, 400);
  assert.equal((await boss.del(`/admin/internship-listings/${id}`)).status, 409); // published: not deletable
});

test('application review over HTTP: details, validated transition, history, notes, notification', async () => {
  const d = await boss.get(`/admin/applications/${appId}`);
  assert.equal(d.status, 200); assert.equal(d.data.application.student.email, 'asha@example.com'); assert.ok(d.data.application.responses.motivation);
  const bad = await boss.patch(`/admin/applications/${appId}/status`, { status: 'Submitted' });
  assert.equal(bad.status, 200); assert.equal(bad.data.changed, false); // same status: no-op
  const ok = await boss.patch(`/admin/applications/${appId}/status`, { status: 'Under Review', note: 'checking' });
  assert.equal(ok.status, 200); assert.equal(ok.data.application.history.at(-1).changedBy, 'Kishore Kumar');
  assert.equal((await boss.patch(`/admin/applications/${appId}/status`, { status: 'Submitted' })).data.error.code, 'INVALID_TRANSITION');
  assert.equal((await boss.post(`/admin/applications/${appId}/notes`, { note: 'Good fit' })).status, 201);
  assert.equal((await boss.post(`/admin/applications/${appId}/notes`, { note: '' })).status, 400);
  const notes = (await asha.get('/student/notifications')).data;
  assert.ok(JSON.stringify(notes).includes('Under Review'));
  assert.ok(!JSON.stringify((await asha.get(`/applications/${appId}`)).data).includes('Good fit')); // notes never reach the student
});
