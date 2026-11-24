import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const ADMIN_KEY = 'a-long-random-admin-key-for-tests-1234567890';
let srv, asha, ravi, anon;
before(async () => {
  srv = await startServer({ ADMIN_API_KEY: ADMIN_KEY, RATE_LIMIT_APPLY_MAX: '1000' });
  asha = client(srv.base); ravi = client(srv.base); anon = client(srv.base);
  assert.equal((await asha.post('/auth/register', validStudent({ skills: [] }))).status, 201); // profile has no skills yet
  assert.equal((await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar' }))).status, 201);
});
after(() => srv.close());

test('every application endpoint requires sign-in', async () => {
  assert.equal((await anon.post('/applications', validApplication())).status, 401);
  assert.equal((await anon.get('/applications/my')).status, 401);
  assert.equal((await anon.get('/applications/ELV-APP-AAAAAAAA')).status, 401);
});

test('submit: saved with a unique ID, status Submitted, linked to the signed-in student and internship', async () => {
  const r = await asha.post('/applications', validApplication());
  assert.equal(r.status, 201);
  const a = r.data.application;
  assert.match(a.id, /^ELV-[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(a.status, 'Submitted');
  assert.equal(a.internship.id, 'ELV-PY-001');
  assert.equal(a.internship.title, 'Python Programming Essentials');
  assert.equal(a.responses.email, 'asha@example.com'); // identity comes from the session
  assert.equal(a.responses.phone, '9876543210'); // normalised
  assert.ok(a.submittedAt && a.updatedAt);
  assert.ok(!JSON.stringify(r.data).match(/password|hash|studentId|student_id/i));
  const me = await asha.get('/auth/me');
  assert.deepEqual(me.data.user.skills, ['Python', 'SQL']); // missing profile detail was filled in
});

test('submit: duplicate application is rejected and points at the existing one', async () => {
  const first = (await asha.get('/applications/my')).data.applications[0];
  const r = await asha.post('/applications', validApplication());
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'ALREADY_APPLIED');
  assert.equal(r.data.error.details.applicationId, first.id);
  assert.equal((await asha.get('/applications/my')).data.applications.length, 1);
});

test('submit: concurrent double-submit creates exactly one application', async () => {
  const results = await Promise.all([1, 2, 3, 4].map(() => ravi.post('/applications', validApplication({ internshipId: 'ELV-WD-001' }))));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.ok(results.every((r) => r.status === 201 || r.status === 409));
  assert.equal((await ravi.get('/applications/my')).data.applications.length, 1);
});

test('submit: validation errors come back per field', async () => {
  const empty = await ravi.post('/applications', {});
  assert.equal(empty.status, 400);
  for (const f of ['fullName', 'phone', 'college', 'degree', 'branch', 'academicYear', 'skills', 'motivation', 'termsAccepted', 'privacyAccepted', 'internshipId']) assert.ok(empty.data.error.fields[f], f);
  const bad = await ravi.post('/applications', validApplication({ internshipId: 'ELV-JV-001', phone: '12345', motivation: 'too short', skills: [], termsAccepted: false, privacyAccepted: false, email: 'someone-else@example.com' }));
  assert.equal(bad.status, 400);
  for (const f of ['phone', 'motivation', 'skills', 'termsAccepted', 'privacyAccepted', 'email']) assert.ok(bad.data.error.fields[f], f);
  assert.equal((await ravi.post('/applications', validApplication({ internshipId: 'ELV-JV-001', motivation: 'x'.repeat(1001) }))).status, 400);
  assert.equal((await ravi.get('/applications/my')).data.applications.length, 1); // nothing was saved
});

test('submit: unknown, closed and upcoming internships are refused', async () => {
  const none = await ravi.post('/applications', validApplication({ internshipId: 'ELV-NOPE-9' }));
  assert.equal(none.status, 404); assert.equal(none.data.error.code, 'INTERNSHIP_NOT_FOUND');
  const closed = await ravi.post('/applications', validApplication({ internshipId: 'ELV-C-002' })); // deadline passed
  assert.equal(closed.status, 409); assert.equal(closed.data.error.code, 'APPLICATIONS_CLOSED');
  assert.equal((await ravi.post('/applications', validApplication({ internshipId: 'ELV-AI-001' }))).data.error.code, 'APPLICATIONS_CLOSED'); // opens soon
});

test('submit: a student ID, status or application ID in the body is ignored', async () => {
  const ravisId = (await ravi.get('/auth/me')).data.user.id;
  const r = await asha.post('/applications', validApplication({ internshipId: 'ELV-JV-001', studentId: ravisId, status: 'Approved', id: 'ELV-APP-AAAAAAAA' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.application.status, 'Submitted');
  assert.notEqual(r.data.application.id, 'ELV-APP-AAAAAAAA');
  assert.equal((await ravi.get(`/applications/${r.data.application.id}`)).status, 404); // it belongs to Asha, not Ravi
});

test('my applications: only your own, newest first', async () => {
  const mine = (await asha.get('/applications/my')).data.applications;
  assert.equal(mine.length, 2);
  assert.ok(mine[0].submittedAt >= mine[1].submittedAt);
  assert.ok(mine.every((a) => a.responses.email === 'asha@example.com'));
  const theirs = (await ravi.get('/applications/my')).data.applications;
  assert.equal(theirs.length, 1);
  assert.ok(theirs.every((a) => a.responses.email === 'ravi@example.com'));
});

test('get one: owner sees it; another student gets the same 404 as a missing ID', async () => {
  const id = (await asha.get('/applications/my')).data.applications[0].id;
  assert.equal((await asha.get(`/applications/${id}`)).data.application.id, id);
  const other = await ravi.get(`/applications/${id}`);
  const missing = await ravi.get('/applications/ELV-APP-ZZZZZZZZ');
  assert.equal(other.status, 404);
  assert.deepEqual(other.data, missing.data); // indistinguishable, so IDs can't be probed
  assert.equal((await ravi.get('/applications/not-an-id')).status, 404);
  assert.equal((await ravi.get("/applications/x'%20OR%20'1'='1")).status, 404);
});

test('students cannot change status: there is no student route that writes it', async () => {
  const id = (await asha.get('/applications/my')).data.applications[0].id;
  for (const [method, path] of [['put', `/applications/${id}`], ['patch', `/applications/${id}`], ['patch', `/applications/${id}/status`]]) {
    const r = await asha[method](path, { status: 'Approved' });
    assert.ok([404, 401].includes(r.status), `${method} ${path} -> ${r.status}`);
  }
  assert.equal((await asha.get(`/applications/${id}`)).data.application.status, 'Submitted');
  // a student session is not admin access
  assert.equal((await asha.patch(`/admin/applications/${id}/status`, { status: 'Approved' })).status, 403);
});

test('admin: key required; valid key updates status; bad values and unknown IDs are rejected', async () => {
  const id = (await asha.get('/applications/my')).data.applications[0].id;
  const path = `/admin/applications/${id}/status`;
  assert.equal((await anon.patch(path, { status: 'Approved' })).status, 401);
  assert.equal((await anon.patch(path, { status: 'Approved' }, { 'x-admin-key': 'wrong' })).status, 401);
  assert.equal((await anon.patch(path, { status: 'Approved' }, { 'x-admin-key': 'wrong-but-same-length-as-the-real-key-123' })).status, 401);
  const bad = await anon.patch(path, { status: 'Hacked' }, { 'x-admin-key': ADMIN_KEY });
  assert.equal(bad.status, 400);
  assert.equal((await anon.patch('/admin/applications/ELV-APP-ZZZZZZZZ/status', { status: 'Approved' }, { 'x-admin-key': ADMIN_KEY })).status, 404);
  const ok = await anon.patch(path, { status: 'Under Review' }, { 'x-admin-key': ADMIN_KEY });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.application.status, 'Under Review');
  const seen = (await asha.get(`/applications/${id}`)).data.application;
  assert.equal(seen.status, 'Under Review'); // the student sees the admin's change
  assert.ok(seen.updatedAt >= seen.submittedAt);
  // Stage 07B: only allowed transitions succeed (Under Review -> Approved -> Rejected -> Under Review -> Cancelled).
  for (const s of ['Approved', 'Rejected', 'Under Review', 'Cancelled']) assert.equal((await anon.patch(path, { status: s }, { 'x-admin-key': ADMIN_KEY })).data.application.status, s);
  assert.equal((await anon.patch(path, { status: 'Submitted' }, { 'x-admin-key': ADMIN_KEY })).data.error.code, 'INVALID_TRANSITION');
});
