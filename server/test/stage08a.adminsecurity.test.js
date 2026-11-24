// Stage 08A: the shared ADMIN_API_KEY is read-only by default; every data-changing admin route needs an administrator session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'a-long-random-admin-key-for-tests-1234567890';
const ADMIN_PW = 'Adm1n!Strong#Pass';
let srv, asha, boss, anon, db, appId;

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, ADMIN_API_KEY_ALLOW_WRITES: 'false', RATE_LIMIT_APPLY_MAX: '1000' });
  const students = await import('../src/db/students.js');
  ({ db } = await import('../src/db/index.js'));
  [asha, boss, anon] = [1, 2, 3].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  const reg = await boss.post('/auth/register', validStudent({ fullName: 'Kishore Kumar', email: 'boss@example.com', password: ADMIN_PW, confirmPassword: ADMIN_PW }));
  assert.equal(students.setRole(reg.data.user.id, 'admin'), true);
  boss.reset();
  assert.equal((await boss.post('/auth/admin/login', { email: 'boss@example.com', password: ADMIN_PW })).status, 200);
  const ap = await asha.post('/applications', validApplication());
  assert.equal(ap.status, 201);
  appId = ap.data.application.id;
});
after(() => srv.close());

const key = { 'X-Admin-Key': KEY };

test('shared key can still READ the console', async () => {
  assert.equal((await anon.get('/admin/me', key)).status, 200);
  assert.equal((await anon.get('/admin/applications', key)).status, 200);
});

test('shared key cannot change data: status, notes, documents, listings, certificates, automation -> 403 ADMIN_SESSION_REQUIRED', async () => {
  const attempts = [
    ['patch', `/admin/applications/${appId}/status`, { status: 'Approved' }],
    ['post', `/admin/applications/${appId}/notes`, { note: 'hello there' }],
    ['post', `/admin/applications/${appId}/internship`, {}],
    ['patch', '/admin/internships/ELV-INT-000001/status', { status: 'Active' }],
    ['patch', '/admin/internships/ELV-INT-000001/certificate-decision', { decision: 'Approved' }],
    ['post', '/admin/documents/offer-letter', { internshipId: 'ELV-INT-000001' }],
    ['post', '/admin/documents/certificate', { internshipId: 'ELV-INT-000001' }],
    ['patch', '/admin/documents/ELV-DOC-000001/revoke', { reason: 'test reason' }],
    ['post', '/admin/internship-listings', {}],
    ['post', '/admin/automation/run', {}],
  ];
  for (const [m, path, body] of attempts) {
    const r = await anon[m](path, body, key);
    assert.equal(r.status, 403, `${m.toUpperCase()} ${path}`);
    assert.equal(r.data.error.code, 'ADMIN_SESSION_REQUIRED', path);
  }
  // nothing changed
  assert.equal((await boss.get(`/admin/applications/${appId}`)).data.application.status, 'Submitted');
});

test('refused key writes are audited with the key FINGERPRINT only, never the key', () => {
  const rows = db.prepare("SELECT * FROM audit_logs WHERE action = 'admin.access_denied'").all();
  assert.ok(rows.length >= 10);
  for (const r of rows) {
    assert.equal(r.result, 'failure'); assert.equal(r.actor_type, 'key');
    assert.match(r.admin_id, /^key:[0-9a-f]{8}$/);
    assert.ok(!JSON.stringify(r).includes(KEY));
  }
});

test('students are 403 and anonymous callers 401 on admin writes', async () => {
  assert.equal((await asha.patch(`/admin/applications/${appId}/status`, { status: 'Approved' })).status, 403);
  assert.equal((await anon.patch(`/admin/applications/${appId}/status`, { status: 'Approved' })).status, 401);
  assert.equal((await asha.post('/admin/documents/certificate', { internshipId: 'ELV-INT-000001' })).status, 403);
  assert.equal((await asha.patch('/admin/students/x/status', { status: 'suspended' })).status, 403);
});

test('an administrator session can still change data, and the audit rows name the account', async () => {
  const r = await boss.patch(`/admin/applications/${appId}/status`, { status: 'Under Review' });
  assert.equal(r.status, 200);
  assert.equal((await boss.post(`/admin/applications/${appId}/notes`, { note: 'Reviewed the profile.' })).status, 201);
  const rows = db.prepare("SELECT action, actor_type, admin_name FROM audit_logs WHERE action IN ('application.status_change','application.note_add')").all();
  assert.ok(rows.some((x) => x.action === 'application.status_change' && x.actor_type === 'admin' && x.admin_name === 'Kishore Kumar'));
  assert.ok(rows.some((x) => x.action === 'application.note_add' && x.actor_type === 'admin'));
});
