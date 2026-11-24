// Stage 10B Part 2A — HTTP-level checks of the administrator verification routes (authentication, permission, validation, wiring). MOCKED payments only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1'; const BASE = '/priority-certificate'; const AP = '/admin/priority-payments';
let srv, dir, db, svc, boss, plain, second, asha, ravi, anon, ids = {}, apps = {}, enr = {}, reqs = {};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const raw = (method, p, body, type, cookieOwner) => fetch(srv.base + p, { method, headers: { 'Content-Type': type, cookie: cookieOwner }, body });
const today = () => new Date().toISOString().slice(0, 10);
const sub = (over = {}) => ({ utr: '412345678901', paymentDate: today(), paymentTime: '10:30', upiApp: 'PhonePe', confirmed: true, ...over });

async function makeAdmin(email, name) {
  const c = client(srv.base);
  assert.equal((await c.post('/auth/register', validStudent({ email, fullName: name }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail(email).id, 'admin');
  assert.equal((await c.post('/auth/admin/login', { email, password: PW })).status, 200);
  return c;
}
async function enroll(c, email, name, over = {}) {
  await c.post('/auth/register', validStudent({ email, fullName: name }));
  const a = await c.post('/applications', validApplication({ fullName: name, ...over }));
  const appId = a.data.application.id;
  assert.equal((await boss.patch(`/admin/applications/${appId}/status`, { status: 'Approved' })).status, 200);
  const e = await boss.post(`/admin/applications/${appId}/internship`, { startDate: '2026-01-05' });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  return { appId, enrId: e.data.internship.id };
}
const complete = (enrId) => db.prepare("UPDATE enrollments SET status = 'Completed', start_date = '2026-01-05', completed_at = '2026-06-30T10:00:00.000Z', expected_end_date = '2026-06-30', certificate_decision = 'Approved' WHERE id = ?").run(enrId);
const configure = (over = {}) => boss.put(`${AP}/config`, { confirm: true, upiId: 'elvora.pay@okbank', payeeName: 'ELVORA Technologies', instructions: 'Pay the exact amount and keep the transaction reference.', supportContact: 'support@elvora.in', verificationHours: 24, manualEnabled: true, submissionsEnabled: true, ...over });

const draft = async (c, appId) => { const r = await c.post(BASE + '/requests', { applicationId: appId, confirmPersonal: true, confirmAcademic: true }); assert.ok([200, 201].includes(r.status), JSON.stringify(r.data)); return r.data.request.id; };
const ACK = { accountChecked: true, utrMatches: true, amountMatches: true, transactionSuccessful: true, notAssignedElsewhere: true };
const orderFor = async (c, reqId) => { const r = await c.post(`${BASE}/requests/${reqId}/payment-order`, {}); assert.ok([200, 201].includes(r.status), JSON.stringify(r.data)); return r.data.payment.id; };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-10b2a-'));
  srv = await startServer({ DOCUMENTS_DIR: path.join(dir, 'documents'), PAYMENT_PROOF_DIR: path.join(dir, 'proofs'), PAYMENT_ADMIN_EMAILS: 'boss@example.com,second@example.com', ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org',
    RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000' });
  ({ db } = await import('../src/db/index.js'));
  svc = await import('../src/services/priorityCertificate.js');
  boss = await makeAdmin('boss@example.com', 'Boss Admin'); second = await makeAdmin('second@example.com', 'Second Admin'); plain = await makeAdmin('plain@example.com', 'Plain Admin');
  asha = client(srv.base); ravi = client(srv.base); anon = client(srv.base);
  const a = await enroll(asha, 'asha@example.com', 'Asha Verma'); const r = await enroll(ravi, 'ravi@example.com', 'Ravi Kumar');
  apps = { asha: a.appId, ravi: r.appId }; enr = { asha: a.enrId, ravi: r.enrId };
  for (const n of ['asha', 'ravi']) ids[n] = db.prepare('SELECT id FROM students WHERE email = ?').get(`${n}@example.com`).id;
  complete(enr.asha); complete(enr.ravi);
  for (const [c, id] of [[asha, ids.asha], [ravi, ids.ravi]]) assert.equal((await c.post(BASE + '/access', { token: svc.createInvitation({ studentId: id }).token })).status, 200);
  assert.equal((await configure()).status, 200);
  reqs.asha = await draft(asha, apps.asha); reqs.ravi = await draft(ravi, apps.ravi);
  ids.payAsha = await orderFor(asha, reqs.asha); ids.payRavi = await orderFor(ravi, reqs.ravi);
  assert.equal((await asha.post(`${BASE}/payments/${ids.payAsha}/submit`, sub({ utr: 'HTTP0000ASH1' }))).status, 201);
  assert.equal((await ravi.post(`${BASE}/payments/${ids.payRavi}/submit`, sub({ utr: 'HTTP0000RAV1' }))).status, 201);
});
after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('admin verification routes require authentication AND the payment.review permission', async () => {
  for (const [m, p, b] of [['get', '/queue'], ['get', `/${ids.payAsha}`], ['get', `/${ids.payAsha}/history`], ['get', `/${ids.payAsha}/duplicates`], ['post', `/${ids.payAsha}/confirm`, {}], ['post', `/${ids.payAsha}/reject`, {}]]) {
    assert.equal((await anon[m](AP + p, b)).status, 401, `anon ${p}`);
    assert.ok([401, 403].includes((await asha[m](AP + p, b)).status), `student ${p}`); // a student session is not an administrator session
    assert.equal((await plain[m](AP + p, b)).status, 403, `no permission ${p}`);
  }
  assert.equal((await boss.get(AP + '/PAY-NOTREAL0000')).status, 404);
});

test('queue, detail, filters and search over HTTP; proof and student payloads never leak', async () => {
  const q = await boss.get(AP + '/queue'); assert.equal(q.status, 200); assert.equal(q.data.payments.length, 2); assert.equal(q.data.counts.pending, 2);
  assert.equal((await boss.get(AP + '/queue?q=HTTP0000ASH1')).data.payments.length, 1); assert.equal((await boss.get(AP + '/queue?status=bogus')).status, 400);
  const d = await boss.get(`${AP}/${ids.payAsha}`); assert.equal(d.status, 200); assert.equal(d.data.payment.status, 'PENDING_VERIFICATION'); assert.match(d.data.notice, /actual transaction record/);
  assert.equal(JSON.stringify(d.data).includes('@example.com'), false);
  assert.equal((await asha.get(`${BASE}/payments/${ids.payAsha}`)).data.payment.status, 'PENDING_VERIFICATION');
});

test('confirm: needs acknowledgements and the reviewed submission; student routes cannot verify; one admin wins; request moves to Payment Verified only', async () => {
  const sid = (await boss.get(`${AP}/${ids.payAsha}`)).data.currentSubmission.id;
  assert.equal((await asha.post(`${BASE}/payments/${ids.payAsha}/confirm`, { acknowledgements: ACK })).status, 404);
  assert.equal((await plain.post(`${AP}/${ids.payAsha}/confirm`, { submissionId: sid, acknowledgements: ACK })).status, 403);
  assert.equal((await boss.post(`${AP}/${ids.payAsha}/confirm`, { submissionId: sid, acknowledgements: { ...ACK, accountChecked: false } })).status, 400);
  const docs = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
  const both = await Promise.all([boss.post(`${AP}/${ids.payAsha}/confirm`, { submissionId: sid, acknowledgements: ACK }), second.post(`${AP}/${ids.payAsha}/confirm`, { submissionId: sid, acknowledgements: ACK })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal(db.prepare('SELECT status FROM priority_requests WHERE id = ?').get(reqs.asha).status, 'Payment Verified');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, docs, 'verification never issues a certificate');
  assert.equal((await asha.get(`${BASE}/payments/${ids.payAsha}`)).data.payment.status, 'VERIFIED');
});

test('reject then audited resubmission over HTTP; the original submission stays', async () => {
  const sid = (await boss.get(`${AP}/${ids.payRavi}`)).data.currentSubmission.id;
  assert.equal((await boss.post(`${AP}/${ids.payRavi}/reject`, { submissionId: sid })).status, 400);
  assert.equal((await boss.post(`${AP}/${ids.payRavi}/reject`, { submissionId: sid, reason: 'OTHER' })).status, 400);
  assert.equal((await boss.post(`${AP}/${ids.payRavi}/reject`, { submissionId: sid, reason: 'INVALID_REFERENCE' })).status, 200);
  const R = `${BASE}/payments/${ids.payRavi}/resubmit`;
  assert.equal((await ravi.post(R, sub({ utr: 'HTTP0000RAV2' }))).status, 400); // a replacement reason is required
  assert.equal((await asha.post(R, sub({ utr: 'HTTP0000RAV2', reason: 'Corrected the reference' }))).status, 404); // not the owner
  assert.equal((await anon.post(R, {})).status, 401);
  const ok = await ravi.post(R, sub({ utr: 'HTTP0000RAV2', reason: 'Corrected the reference' })); assert.equal(ok.status, 201, JSON.stringify(ok.data)); assert.equal(ok.data.revision, 2);
  const h = await boss.get(`${AP}/${ids.payRavi}/history`); assert.equal(h.data.submissions.length, 2); assert.equal(h.data.submissions[0].utr, 'HTTP0000RAV1');
  assert.equal((await ravi.post(R, sub({ utr: 'HTTP0000RAV3', reason: 'Trying again right away' }))).status, 409);
});
