// Stage 07C — the full administrative workflow, step by step, over real HTTP against the real app + in-memory database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1';
let srv, dir, anon, admin, asha, ravi;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const actions = async () => (await admin.get('/admin/audit-logs?pageSize=100')).data.events.map((e) => `${e.action}:${e.result}`);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-e2e-'));
  srv = await startServer({ ADMIN_API_KEY: 'a-long-random-admin-key-for-tests-1234567890', DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000',
    ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Priya Rao', ORG_SIGNATORY_TITLE: 'Director' });
  [anon, admin, asha, ravi] = [1, 2, 3, 4].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  assert.equal((await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar' }))).status, 201);
  assert.equal((await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js'); // roles can only be granted on the server, never over HTTP
  setRole(findByEmail('boss@example.com').id, 'admin');
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('Stage 07 workflow, steps 1-17, plus access, isolation and error checks', async () => {
  // access control first: nobody but a signed-in administrator gets in
  for (const p of ['/admin/dashboard', '/admin/documents', '/admin/audit-logs', '/admin/announcements', '/admin/settings', '/admin/students']) {
    assert.equal((await anon.get(p)).status, 401, `anon ${p}`);
    assert.ok([401, 403].includes((await asha.get(p)).status), `student ${p}`);
  }
  assert.ok((await asha.post('/admin/announcements', { title: 'Spam', message: 'Mass message attempt', confirm: true })).status >= 401);
  assert.equal((await admin.post('/auth/admin/login', { email: 'asha@example.com', password: PW })).status !== 200, true, 'student cannot use admin login');

  // 1-2 login + dashboard
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  assert.equal((await admin.get('/admin/dashboard')).status, 200);

  // 3-4 create + publish an internship listing
  const body = { title: 'E2E Workflow Internship', category: 'python-development', description: 'A listing created and published during the full workflow test.', durationDays: 30, skills: ['Python'], outcomes: ['Build a small tested Python project'], eligibility: { who: 'Any student who wants to learn Python' }, type: 'Project-Based', difficulty: 'Beginner' };
  const created = await admin.post('/admin/internship-listings', body);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const listingId = created.data.internship.id;
  assert.equal((await admin.patch(`/admin/internship-listings/${listingId}/state`, { action: 'publish' })).status, 200);
  const publicList = (await anon.get('/internships')).data;
  assert.ok(publicList.internships.some((i) => i.id === listingId), 'published listing is public (named key)');
  assert.deepEqual(publicList.data, publicList.internships, 'deprecated `data` alias carries identical content');
  const publicOne = (await anon.get(`/internships/${listingId}`)).data;
  assert.equal(publicOne.internship.id, listingId); assert.deepEqual(publicOne.data, publicOne.internship);

  // 5 student applications appear in the admin panel
  const a = await asha.post('/applications', validApplication({ internshipId: listingId }));
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const appId = a.data.application.id;
  const rv = await ravi.post('/applications', validApplication({ internshipId: listingId, fullName: 'Ravi Kumar' }));
  assert.equal(rv.status, 201); const raviApp = rv.data.application.id;
  const list = (await admin.get('/admin/applications?pageSize=50')).data.applications;
  assert.ok(list.some((x) => x.id === appId));

  // 6-8 review, change status, student gets the notification (and only that student)
  assert.equal((await admin.get(`/admin/applications/${appId}`)).status, 200);
  assert.ok([401, 403].includes((await asha.get(`/admin/applications/${appId}`)).status));
  const unread = (c) => c.get('/student/notifications/unread-count').then((r) => r.data.unreadCount);
  const [ashaBefore, raviBefore] = [await unread(asha), await unread(ravi)];
  assert.equal((await admin.patch(`/admin/applications/${appId}/status`, { status: 'Approved', note: 'Strong motivation' })).status, 200);
  assert.equal(await unread(asha), ashaBefore + 1, 'Asha was notified');
  assert.equal(await unread(ravi), raviBefore, 'Ravi was not');
  // invalid transition: a Cancelled application is terminal and cannot be approved
  assert.equal((await admin.patch(`/admin/applications/${raviApp}/status`, { status: 'Cancelled' })).status, 200);
  assert.equal((await admin.patch(`/admin/applications/${raviApp}/status`, { status: 'Approved' })).status, 409);

  // 9 internship record exists after approval, then activate
  const enr = await admin.post(`/admin/applications/${appId}/internship`, {});
  assert.equal(enr.status, 201, JSON.stringify(enr.data));
  const enrId = enr.data.internship.id;
  // certificate before completion is refused
  assert.equal((await admin.post('/admin/documents/certificate', { internshipId: enrId })).status, 409);
  assert.equal((await admin.patch(`/admin/internships/${enrId}/activate`, { startDate: day(-10), expectedEndDate: day(20) })).status, 200);

  // 10 completion needs the review confirmation and 100% progress
  assert.equal((await admin.patch(`/admin/internships/${enrId}/complete`, { confirmReviewed: true })).status, 409, 'progress not 100');
  assert.equal((await admin.patch(`/admin/internships/${enrId}/progress`, { progressPercent: 100 })).status, 200);
  assert.equal((await admin.patch(`/admin/internships/${enrId}/complete`, { confirmReviewed: true, note: 'Done' })).status, 200);

  // 11 certificate through Stage 06 (needs the certificate approval too), duplicates refused
  assert.equal((await admin.post('/admin/documents/certificate', { internshipId: enrId })).status, 409, 'not yet approved for a certificate');
  assert.equal((await admin.patch(`/admin/internships/${enrId}/certificate-decision`, { decision: 'Approved' })).status, 200);
  const cert = await admin.post('/admin/documents/certificate', { internshipId: enrId });
  assert.equal(cert.status, 201, JSON.stringify(cert.data));
  const doc = cert.data.document;
  assert.equal(doc.status, 'Issued');
  assert.equal((await admin.post('/admin/documents/certificate', { internshipId: enrId })).status, 409, 'duplicate issuance');

  // 12 the student can open it; another student cannot
  assert.ok((await asha.get('/student/documents')).data.documents.some((d) => d.id === doc.id));
  assert.equal((await asha.get(`/student/documents/${doc.id}/file`)).status, 200);
  assert.equal((await ravi.get(`/student/documents/${doc.id}`)).status, 404);
  assert.equal((await ravi.get(`/student/documents/${doc.id}/file`)).status, 404);
  assert.equal((await ravi.get('/student/documents')).data.documents.length, 0);

  // 13 verify
  const v = (await admin.get(`/admin/documents/${doc.id}/verify`)).data.verification;
  assert.equal(v.integrity.state, 'match');
  const pub = await (await fetch(`${srv.base}/public/documents/verify/${doc.verificationCode}`)).json();
  assert.match(JSON.stringify(pub), /valid/i);

  // 14 revoke (reason mandatory; students cannot)
  assert.ok((await asha.patch(`/admin/documents/${doc.id}/revoke`, { reason: 'I want it gone' })).status >= 401);
  assert.equal((await admin.patch(`/admin/documents/${doc.id}/revoke`, {})).status, 400);
  assert.equal((await admin.patch(`/admin/documents/${doc.id}/revoke`, { reason: 'Issued in error' })).status, 200);
  assert.equal((await admin.get(`/admin/documents/${doc.id}`)).data.document.status, 'Revoked', 'record kept');

  // 15 public verification reflects revocation without leaking the reason or the student
  const pub2 = JSON.stringify(await (await fetch(`${srv.base}/public/documents/verify/${doc.verificationCode}`)).json());
  assert.match(pub2, /revoked/i);
  assert.ok(!pub2.includes('Issued in error') && !pub2.includes('asha@example.com'));
  // an administrator may deliberately issue a replacement; the revoked record stays and is a separate document
  const again = await admin.post('/admin/documents/certificate', { internshipId: enrId });
  assert.equal(again.status, 201); assert.notEqual(again.data.document.id, doc.id);
  assert.equal((await admin.get(`/admin/documents/${doc.id}`)).data.document.status, 'Revoked', 'revoked record untouched');
  assert.equal((await admin.get(`/admin/documents/${doc.id}/history`)).data.sameInternship.length, 2);

  // announcement: preview, confirm, deliver, withdraw
  const ann = { title: 'Platform notice', message: 'Maintenance this weekend, no action needed.', category: 'important', audience: { type: 'all' } };
  const pv = (await admin.post('/admin/announcements/preview', ann)).data;
  assert.equal(pv.recipientCount, 2); assert.ok(!JSON.stringify(pv).includes('@'));
  assert.equal((await admin.post('/admin/announcements', ann)).status, 400, 'confirmation required');
  const sent = await admin.post('/admin/announcements', { ...ann, confirm: true, confirmRecipientCount: pv.recipientCount });
  assert.equal(sent.status, 201); assert.equal(sent.data.delivered, 2);

  // 16 audit log has the administrative actions, no secrets
  const acts = new Set(await actions());
  for (const x of ['admin.login:success', 'listing.create:success', 'listing.publish:success', 'application.status_change:success', 'internship.activate:success', 'internship.complete:success', 'certificate.issue:success', 'certificate.issue:failure', 'document.revoke:success', 'announcement.send:success']) assert.ok(acts.has(x), `audit has ${x}`);
  const raw = JSON.stringify((await admin.get('/admin/audit-logs?pageSize=100')).data);
  assert.ok(!raw.includes(PW) && !/asha@example\.com|token|password/i.test(raw));
  for (const m of ['PATCH', 'DELETE', 'POST', 'PUT']) assert.ok([404, 405].includes((await admin[m.toLowerCase() === 'delete' ? 'del' : m.toLowerCase()]('/admin/audit-logs/AUD-000000000000', m === 'PATCH' || m === 'POST' || m === 'PUT' ? {} : undefined)).status), `audit log is immutable over ${m}`);

  // 17 logout: the session stops working and the logout is recorded by the server
  assert.equal((await admin.post('/auth/logout', {})).status < 300, true);
  assert.equal((await admin.get('/admin/dashboard')).status, 401);
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  assert.ok((await actions()).includes('admin.logout:success'));
});
