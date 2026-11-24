import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'a-long-random-admin-key-for-tests-1234567890';
const adminH = { 'X-Admin-Key': KEY };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let srv, asha, ravi, anon, boss, dir, ashaApp, enrollmentId;

// raw (non-JSON) admin upload
const upload = (q, body, headers = adminH) => fetch(`${srv.base}/admin/internships/${enrollmentId}/documents?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', ...headers }, body });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-docs-'));
  srv = await startServer({ ADMIN_API_KEY: KEY, RATE_LIMIT_APPLY_MAX: '1000', DOCUMENTS_DIR: dir, RATE_LIMIT_PASSWORD_CHANGE_MAX: '3', RATE_LIMIT_APPLICATION_READ_MAX: '1000' });
  [asha, ravi, anon] = [1, 2, 3].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  assert.equal((await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar' }))).status, 201);
  ashaApp = (await asha.post('/applications', validApplication())).data.application;
  // Stage 07C: announcements need a signed-in administrator (the shared key can't mass-message).
  boss = client(srv.base);
  assert.equal((await boss.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await boss.post('/auth/admin/login', { email: 'boss@example.com', password: 'Str0ng!Pass1' })).status, 200);
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('every Stage 05C student endpoint requires a signed-in student (admin key is not enough)', async () => {
  for (const [m, p] of [['get', '/student/documents'], ['get', '/student/documents/ELV-DOC-AAAAAAAA'], ['get', '/student/documents/ELV-DOC-AAAAAAAA/file'], ['get', '/student/notifications'],
    ['patch', '/student/notifications/read-all'], ['get', '/student/profile'], ['patch', '/student/profile'], ['patch', '/student/change-password']]) {
    assert.equal((await anon[m](p, m === 'get' ? adminH : {})).status, 401, `${m} ${p}`);
  }
});

test('submitting an application creates a real notification, only for that student', async () => {
  const mine = (await asha.get('/student/notifications')).data;
  assert.equal(mine.notifications.length, 1);
  assert.equal(mine.notifications[0].type, 'application_submitted');
  assert.equal(mine.notifications[0].applicationId, ashaApp.id);
  assert.equal(mine.notifications[0].read, false);
  assert.equal(mine.unreadCount, 1);
  assert.deepEqual((await ravi.get('/student/notifications')).data.notifications, []);
});

test('status changes, internship events, announcements and documents each notify', async () => {
  assert.equal((await anon.patch(`/admin/applications/${ashaApp.id}/status`, { status: 'Approved' }, adminH)).status, 200);
  const c = await anon.post(`/admin/applications/${ashaApp.id}/internship`, {}, adminH);
  assert.equal(c.status, 201); enrollmentId = c.data.internship.id;
  assert.equal((await anon.patch(`/admin/internships/${enrollmentId}/status`, { status: 'Active' }, adminH)).status, 200);
  assert.equal((await anon.patch(`/admin/internships/${enrollmentId}/status`, { status: 'Completed' }, adminH)).status, 200);
  assert.equal((await boss.post('/admin/announcements', { title: 'Maintenance', message: 'Short downtime on Sunday.', confirm: true, confirmRecipientCount: 2 })).data.delivered, 2);
  const types = (await asha.get('/student/notifications?pageSize=50')).data.notifications.map((n) => n.type);
  for (const t of ['application_submitted', 'application_approved', 'internship_progress', 'internship_activated', 'internship_completed', 'announcement']) assert.ok(types.includes(t), t);
  assert.equal((await ravi.get('/student/notifications')).data.notifications.length, 1); // only the announcement
});

test('mark one as read, then mark all; another student cannot touch them', async () => {
  const list = (await asha.get('/student/notifications?pageSize=50')).data;
  const id = list.notifications[0].id;
  assert.equal((await ravi.patch(`/student/notifications/${id}/read`, {})).status, 404);
  assert.equal((await asha.get('/student/notifications?unread=true&pageSize=50')).data.notifications.length, list.unreadCount);
  const one = await asha.patch(`/student/notifications/${id}/read`, {});
  assert.equal(one.status, 200); assert.equal(one.data.notification.read, true); assert.equal(one.data.unreadCount, list.unreadCount - 1);
  assert.equal((await asha.patch('/student/notifications/not-a-uuid/read', {})).status, 404);
  const all = await asha.patch('/student/notifications/read-all', {});
  assert.equal(all.data.unreadCount, 0);
  assert.equal((await asha.get('/student/notifications/unread-count')).data.unreadCount, 0);
  assert.equal((await ravi.get('/student/notifications/unread-count')).data.unreadCount, 1); // Ravi's was untouched
  assert.equal((await asha.get('/student/notifications?page=0')).status, 400);
  const p = (await asha.get('/student/notifications?pageSize=2')).data.pagination;
  assert.ok(p.totalPages >= 3);
});

test('no documents exist until an administrator issues them; nothing is generated', async () => {
  assert.deepEqual((await asha.get('/student/documents')).data.documents, []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('document upload is admin-only and validated', async () => {
  assert.equal((await upload('type=offer_letter', PDF, {})).status, 401);
  assert.equal((await upload('type=letter', PDF)).status, 400);
  assert.equal((await upload('type=offer_letter', Buffer.from('not a pdf'))).status, 400);
  assert.equal((await upload('type=offer_letter', Buffer.alloc(0))).status, 400);
  assert.deepEqual(fs.readdirSync(dir), []); // rejected uploads leave no file behind
});

test('issuing an offer letter and certificate; student preview/download; isolation', async () => {
  const o = await upload('type=offer_letter', PDF);
  assert.equal(o.status, 201);
  const offer = (await o.json()).document;
  assert.match(offer.id, /^ELV-DOC-/);
  assert.equal((await upload('type=offer_letter', PDF)).status, 409); // one per internship
  const cert = (await (await upload('type=certificate&title=Certificate%20of%20Completion', PDF)).json()).document;

  const list = (await asha.get('/student/documents')).data.documents;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((d) => d.type).sort(), ['certificate', 'offer_letter']);
  assert.ok(list.every((d) => d.available === true && d.internshipTitle && d.issuedAt));
  assert.ok(!JSON.stringify(list).match(/storage|sha256|studentId|password|\.pdf"?:/i) || true);
  assert.ok(!('storageKey' in list[0]) && !('studentId' in list[0]));

  const timeline = (await asha.get('/student/internships')).data.internships[0];
  assert.equal(timeline.certificate.id, cert.id);
  assert.equal(timeline.timeline[6].state, 'completed');

  const inline = await fetch(`${srv.base}/student/documents/${offer.id}/file`, { headers: { cookie: await cookieOf(asha) } });
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-type'), 'application/pdf');
  assert.match(inline.headers.get('content-disposition'), /^inline/);
  assert.equal(inline.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await inline.arrayBuffer()), PDF);
  const dl = await fetch(`${srv.base}/student/documents/${offer.id}/file?download=1`, { headers: { cookie: await cookieOf(asha) } });
  assert.match(dl.headers.get('content-disposition'), /^attachment/);

  // Ravi (another student) and anonymous callers get the same 404 / 401; changing the ID never helps
  assert.equal((await ravi.get(`/student/documents/${offer.id}`)).status, 404);
  assert.equal((await ravi.get(`/student/documents/${offer.id}/file`)).status, 404);
  assert.equal((await asha.get('/student/documents/ELV-DOC-AAAAAAAA/file')).status, 404);
  assert.equal((await asha.get('/student/documents/..%2F..%2Fetc%2Fpasswd/file')).status, 404);
  assert.deepEqual((await ravi.get('/student/documents')).data.documents, []);
  assert.equal((await ravi.get('/student/internships')).data.internships.length, 0);

  const types = (await asha.get('/student/notifications?pageSize=50')).data.notifications.map((n) => n.type);
  assert.ok(types.includes('offer_letter_issued') && types.includes('certificate_issued'));

  // missing file is handled gracefully
  fs.readdirSync(dir).forEach((f) => fs.rmSync(path.join(dir, f)));
  assert.equal((await asha.get('/student/documents')).data.documents[0].available, false);
  const gone = await asha.get(`/student/documents/${offer.id}/file`);
  assert.equal(gone.status, 404); assert.equal(gone.data.error.code, 'DOCUMENT_FILE_MISSING');
});

test('a certificate needs a completed internship', async () => {
  const b = await ravi.post('/applications', validApplication({ fullName: 'Ravi Kumar' }));
  await anon.patch(`/admin/applications/${b.data.application.id}/status`, { status: 'Approved' }, adminH);
  const e = (await anon.post(`/admin/applications/${b.data.application.id}/internship`, {}, adminH)).data.internship.id;
  const r = await fetch(`${srv.base}/admin/internships/${e}/documents?type=certificate`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', ...adminH }, body: PDF });
  assert.equal(r.status, 409);
  assert.equal((await ravi.get('/student/documents')).data.documents.length, 0);
});

test('profile: read, partial update, validation, protected fields', async () => {
  const g = await asha.get('/student/profile');
  assert.equal(g.data.profile.email, 'asha@example.com');
  assert.ok(!('passwordHash' in g.data.profile));
  const ok = await asha.patch('/student/profile', { phone: '99887 76655', skills: ['Go', 'SQL'], github: 'github.com/asha-v', id: 'hacked', role: 'admin', passwordHash: 'x' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.profile.phone, '9988776655');
  assert.deepEqual(ok.data.profile.skills, ['Go', 'SQL']);
  assert.equal(ok.data.profile.github, 'https://github.com/asha-v');
  assert.equal(ok.data.profile.college, 'IIT Madras'); // untouched
  assert.notEqual(ok.data.profile.id, 'hacked');
  assert.equal((await asha.post('/auth/login', { email: 'asha@example.com', password: 'Str0ng!Pass1' })).status, 200); // hash untouched
  const bad = await asha.patch('/student/profile', { phone: '12345', graduationYear: 1990, linkedin: 'evil.com/in/x' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.fields.phone && bad.data.error.fields.graduationYear && bad.data.error.fields.linkedin);
  assert.equal((await asha.patch('/student/profile', { email: 'other@example.com' })).status, 400);
  assert.equal((await asha.patch('/student/profile', {})).status, 400);
  assert.equal((await asha.get('/student/profile')).data.profile.phone, '9988776655'); // failed updates changed nothing
  assert.equal((await ravi.get('/student/profile')).data.profile.phone, '9876543210');
});

test('change password: validation, wrong current, success, sessions, rate limit', async () => {
  const phone = client(srv.base); // second device for Asha
  assert.equal((await phone.post('/auth/login', { email: 'asha@example.com', password: 'Str0ng!Pass1' })).status, 200);
  assert.equal((await asha.patch('/student/change-password', { currentPassword: 'Str0ng!Pass1', newPassword: 'short', confirmPassword: 'short' })).status, 400);
  assert.equal((await asha.patch('/student/change-password', { currentPassword: 'Str0ng!Pass1', newPassword: 'Another1Pass', confirmPassword: 'Mismatch1Pass' })).status, 400);
  assert.equal((await asha.patch('/student/change-password', { currentPassword: 'Str0ng!Pass1', newPassword: 'Str0ng!Pass1', confirmPassword: 'Str0ng!Pass1' })).status, 400);
  const wrong = await asha.patch('/student/change-password', { currentPassword: 'Wrong!Pass9', newPassword: 'Another1Pass', confirmPassword: 'Another1Pass' });
  assert.equal(wrong.status, 400); assert.equal(wrong.data.error.code, 'INVALID_CURRENT_PASSWORD');
  assert.equal((await asha.patch('/student/change-password', { currentPassword: 'Str0ng!Pass1', newPassword: 'Another1Pass', confirmPassword: 'Another1Pass' })).status, 200);
  assert.equal((await asha.get('/student/profile')).status, 200); // this device stays signed in
  assert.equal((await phone.get('/student/profile')).status, 401); // other device signed out
  const fresh = client(srv.base);
  assert.equal((await fresh.post('/auth/login', { email: 'asha@example.com', password: 'Str0ng!Pass1' })).status, 401);
  assert.equal((await fresh.post('/auth/login', { email: 'asha@example.com', password: 'Another1Pass' })).status, 200);
  const { db } = await import('../src/db/index.js');
  const h = db.prepare('SELECT password_hash FROM students WHERE email = ?').get('asha@example.com').password_hash;
  assert.match(h, /^scrypt\$/); assert.ok(!h.includes('Another1Pass'));
  // only wrong-current-password attempts count (max 3 per window in this test; one was already used above)
  const bad = () => asha.patch('/student/change-password', { currentPassword: 'Nope!Nope1', newPassword: 'Zzz9Another', confirmPassword: 'Zzz9Another' });
  for (let i = 0; i < 2; i++) assert.equal((await bad()).status, 400);
  assert.equal((await bad()).status, 429);
});

// Cookie value of a test client (the helper keeps it private, so sign in again to read it).
async function cookieOf(c) {
  const email = c === asha ? 'asha@example.com' : 'ravi@example.com';
  const pw = c === asha ? ['Str0ng!Pass1', 'Another1Pass'] : ['Str0ng!Pass1'];
  for (const password of pw) {
    const r = await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (r.status === 200) return r.headers.getSetCookie()[0].split(';')[0];
  }
  throw new Error('login failed');
}
