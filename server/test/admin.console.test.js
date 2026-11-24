// Admin console API: key check, application and internship lists, search, and that students cannot reach any of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'a-long-random-admin-key-for-tests-1234567890';
const adminH = { 'X-Admin-Key': KEY };
let srv, asha, anon, apps;

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, RATE_LIMIT_APPLY_MAX: '1000' });
  [asha, anon] = [1, 2].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  apps = [];
  for (const internshipId of ['ELV-PY-001', 'ELV-PY-002', 'ELV-JV-001']) {
    const r = await asha.post('/applications', validApplication({ internshipId }));
    assert.equal(r.status, 201);
    apps.push(r.data.application);
  }
});
after(() => srv.close());

test('/admin/me accepts only the right key', async () => {
  assert.equal((await anon.get('/admin/me', adminH)).status, 200);
  assert.equal((await anon.get('/admin/me')).status, 401);
  assert.equal((await anon.get('/admin/me', { 'X-Admin-Key': 'x'.repeat(40) })).status, 401);
  assert.equal((await asha.get('/admin/me')).status, 403); // a signed-in student is not an admin
});

test('admin lists every student’s applications with counts, filter and search', async () => {
  const all = await anon.get('/admin/applications', adminH);
  assert.equal(all.status, 200);
  assert.equal(all.data.applications.length, 3);
  assert.equal(all.data.counts.All, 3);
  assert.equal(all.data.applications[0].responses.fullName, 'Asha Verma');
  assert.equal(all.data.applications[0].internshipRecord, null);
  assert.equal((await anon.patch(`/admin/applications/${apps[0].id}/status`, { status: 'Approved' }, adminH)).status, 200);
  const approved = await anon.get('/admin/applications?status=Approved', adminH);
  assert.equal(approved.data.applications.length, 1);
  assert.equal((await anon.get('/admin/applications?status=Hacked', adminH)).status, 400);
  assert.equal((await anon.get(`/admin/applications?q=${encodeURIComponent(apps[1].id)}`, adminH)).data.applications.length, 1);
  assert.equal((await anon.get('/admin/applications?q=asha', adminH)).data.applications.length, 3);
  assert.equal((await anon.get('/admin/applications?q=%25', adminH)).data.applications.length, 0); // % is literal, not a wildcard
  assert.equal((await anon.get("/admin/applications?q=' OR '1'='1", adminH)).data.applications.length, 0);
  assert.equal((await anon.get('/admin/applications')).status, 401);
  assert.equal((await asha.get('/admin/applications')).status, 403);
});

test('admin lists internships with student details and issued documents', async () => {
  assert.deepEqual((await anon.get('/admin/internships', adminH)).data.internships, []);
  const c = await anon.post(`/admin/applications/${apps[0].id}/internship`, { assignedProject: 'CLI app' }, adminH);
  assert.equal(c.status, 201);
  const list = (await anon.get('/admin/internships', adminH)).data.internships;
  assert.equal(list.length, 1);
  assert.equal(list[0].studentName, 'Asha Verma');
  assert.equal(list[0].studentEmail, 'asha@example.com');
  assert.deepEqual(list[0].documents, []);
  assert.equal(list[0].studentId, undefined);
  assert.equal((await anon.get('/admin/applications', adminH)).data.applications.find((a) => a.id === apps[0].id).internshipRecord.status, 'Awaiting Start');
  assert.equal((await anon.get('/admin/internships')).status, 401);
});
