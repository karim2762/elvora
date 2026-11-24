// Stage 10B Part 2B — HTTP-level checks of refunds, overdue reporting, QR/config confirmation and student refund visibility. MOCKED payments only.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-10b2b-'));
  srv = await startServer({ DOCUMENTS_DIR: path.join(dir, 'documents'), PAYMENT_PROOF_DIR: path.join(dir, 'proofs'), PAYMENT_ADMIN_EMAILS: 'boss@example.com', ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org',
    RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000' });
  ({ db } = await import('../src/db/index.js'));
  svc = await import('../src/services/priorityCertificate.js');
  boss = await makeAdmin('boss@example.com', 'Boss Admin'); second = await makeAdmin('second@example.com', 'Second Admin'); plain = await makeAdmin('plain@example.com', 'Plain Admin');
  const { grantPermission } = await import('../src/db/payments.js'); const sid = db.prepare('SELECT id FROM students WHERE email = ?').get('second@example.com').id; grantPermission(sid, 'payment.refund', 'test');
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
  const d = await boss.get(`${AP}/${ids.payAsha}`); assert.equal(d.status, 200, JSON.stringify(d.data));
  const ok = await boss.post(`${AP}/${ids.payAsha}/confirm`, { submissionId: d.data.review.submissionId, acknowledgements: ACK }); assert.equal(ok.status, 200, JSON.stringify(ok.data));
});
after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });


const RACK = { accountChecked: true, referenceMatches: true, amountMatches: true };
const RF = (over = {}) => ({ amountRupees: '10', reason: 'Duplicate payment by the student', destination: 'asha@okbank', ...over });

test('refund routes need authentication AND the payment.refund permission (reviewer-only, plain admin, student and anonymous are refused)', async () => {
  const calls = [['get', `${AP}/refunds`], ['get', `${AP}/${ids.payAsha}/refunds`], ['post', `${AP}/${ids.payAsha}/refunds`, RF()], ['post', `${AP}/refunds/RFD-AAAAAAAA/pending`, {}], ['post', `${AP}/refunds/RFD-AAAAAAAA/complete`, {}], ['post', `${AP}/refunds/RFD-AAAAAAAA/reject`, {}]];
  for (const who of [anon, asha, plain]) for (const [m, p, b] of calls) { const r = await who[m](p, b); assert.ok([401, 403].includes(r.status), `${m} ${p} ${r.status}`); }
  assert.equal((await boss.get(`${AP}/permissions`)).data.permissions.includes('payment.refund'), true, 'bootstrap e-mail holds every permission');
  assert.equal((await boss.post(`${AP}/refunds/bad-id/pending`, {})).status, 404);
});

test('22–27 refund lifecycle over HTTP: create, pending, complete; validation, balance, duplicate reference; student sees outcomes only', async () => {
  const bad = await second.post(`${AP}/${ids.payAsha}/refunds`, RF({ amountRupees: '0' })); assert.equal(bad.status, 400); assert.ok(bad.data.error.fields.amountRupees);
  assert.equal((await second.post(`${AP}/${ids.payAsha}/refunds`, RF({ amountRupees: '99999' }))).data.error.code, 'REFUND_EXCEEDS_PAYMENT');
  assert.equal((await second.post(`${AP}/${ids.payRavi}/refunds`, RF())).data.error.code, 'PAYMENT_NOT_VERIFIED');
  const c = await second.post(`${AP}/${ids.payAsha}/refunds`, RF({ amountRupees: '5', destination: 'private.dest@okbank', notes: 'private note' })); assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.refund.id; assert.equal(c.data.refund.status, 'REFUND_REQUESTED');
  assert.equal((await second.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'HTTPRFN00001', acknowledgements: RACK })).data.error.code, 'REFUND_STATE');
  assert.equal((await second.post(`${AP}/refunds/${id}/pending`, { notes: 'go' })).status, 200);
  const noAck = await second.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'HTTPRFN00001' }); assert.equal(noAck.status, 400);
  assert.equal((await second.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'HTTPRFN00001', acknowledgements: RACK })).data.refund.status, 'REFUNDED');
  const c2 = await second.post(`${AP}/${ids.payAsha}/refunds`, RF({ amountRupees: '5' })); await second.post(`${AP}/refunds/${c2.data.refund.id}/pending`, {});
  assert.equal((await second.post(`${AP}/refunds/${c2.data.refund.id}/complete`, { refundUtr: 'httprfn00001', acknowledgements: RACK })).data.error.code, 'DUPLICATE_REFUND_REFERENCE');
  assert.equal((await second.post(`${AP}/refunds/${c2.data.refund.id}/reject`, { reason: 'short' })).status, 400);
  assert.equal((await second.post(`${AP}/refunds/${c2.data.refund.id}/reject`, { reason: 'Declined by finance after review' })).data.refund.status, 'REFUND_REJECTED');
  const h = await second.get(`${AP}/refunds/${id}`); assert.deepEqual(h.data.events.map((e) => e.event), ['requested', 'pending', 'completed']);
  const list = await second.get(`${AP}/refunds?status=REFUNDED`); assert.equal(list.data.refunds.length, 1); assert.equal((await second.get(`${AP}/refunds?status=NOPE`)).status, 400);
  // student: own refunds only, outcome fields only
  const sv = await asha.get(`${BASE}/payments/${ids.payAsha}/refunds`); assert.equal(sv.status, 200); const t = JSON.stringify(sv.data);
  for (const leak of ['private.dest', 'private note', 'Second Admin', 'destination', 'requestedBy']) assert.ok(!t.includes(leak), leak);
  assert.equal((await ravi.get(`${BASE}/payments/${ids.payAsha}/refunds`)).status, 404); assert.equal((await anon.get(`${BASE}/payments/${ids.payAsha}/refunds`)).status, 401);
  const pv = await asha.get(`${BASE}/payments/${ids.payAsha}`); assert.equal(pv.data.payment.refunds.some((r) => r.status === 'REFUNDED' && r.refundReference === 'HTTPRFN00001'), true);
  assert.equal(pv.data.payment.status, 'VERIFIED');
  // a student cannot reach any refund write route
  assert.equal((await asha.post(`${AP}/refunds/${id}/reject`, { reason: 'I want to cancel it' })).status, 403);
});

test('20 overdue report over HTTP needs payment.review; reports without deciding', async () => {
  db.prepare("UPDATE priority_payments SET verification_deadline = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(ids.payRavi);
  assert.equal((await plain.get(`${AP}/overdue`)).status, 403); assert.equal((await anon.get(`${AP}/overdue`)).status, 401);
  const o = await boss.get(`${AP}/overdue`); assert.equal(o.status, 200); assert.ok(o.data.payments.some((p) => p.id === ids.payRavi));
  const q = await boss.get(`${AP}/queue?status=overdue`); assert.equal(q.data.payments.length, 1); assert.equal(q.data.payments[0].status, 'PENDING_VERIFICATION');
  const dash = await boss.get('/admin/dashboard'); if (dash.status === 200) assert.ok(dash.data.payments === undefined || typeof dash.data.payments.overdue === 'number');
});

test('config: destination change needs confirm over HTTP; QR upload is permission-protected, validated, private; student QR route needs access', async () => {
  assert.equal((await boss.put(`${AP}/config`, { upiId: 'elvora.other@okbank' })).status, 400);
  assert.equal((await boss.put(`${AP}/config`, { upiId: 'elvora.other@okbank', confirm: true })).status, 200);
  assert.equal((await configure()).status, 200);
  // raw upload via a fresh login cookie of boss
  const login = await fetch(`${srv.base}/auth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'boss@example.com', password: PW }) });
  const ck = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const up = (type, body, q = '?confirm=true', cookieOwner = ck) => raw('PUT', `/admin/priority-payments/config/qr${q}`, body, type, cookieOwner);
  assert.equal((await up('image/png', PNG, '')).status, 400, 'confirmation required');
  assert.equal((await up('image/svg+xml', Buffer.from('<svg onload=alert(1)/>'))).status, 400, 'SVG is refused');
  assert.equal((await up('image/png', Buffer.from('not an image at all'))).status, 400);
  assert.equal((await up('image/png', PNG, '?confirm=true', '')).status, 401);
  const ok = await up('image/png', PNG); assert.equal(ok.status, 200); const body = await ok.json(); assert.equal(body.config.qrImage.configured, true); assert.ok(!JSON.stringify(body).includes('qr_file'));
  assert.equal((await plain.get(`${AP}/config/qr`)).status, 403);
  const g = await fetch(`${srv.base}/admin/priority-payments/config/qr`, { headers: { cookie: ck } }); assert.equal(g.status, 200); assert.equal(g.headers.get('content-type'), 'image/png'); assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await anon.get(`${BASE}/payment-info`)).status, 401);
  const sq = await fetch(`${srv.base}${BASE}/payment-qr`, { headers: { cookie: await (async () => { const l = await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: PW }) }); return l.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); })() } });
  assert.equal(sq.status, 200); assert.equal((await fetch(`${srv.base}${BASE}/payment-qr`)).status, 401);
  assert.equal((await fetch(`${srv.base}/uploads/payment-qr`)).status, 404);
});

test('pricing over HTTP: confirmation required, audited, history kept, orders keep their price; no permission = 403', async () => {
  const before_ = (await asha.get(`${BASE}/payments/${ids.payAsha}`)).data.payment.amountPaise;
  assert.equal((await boss.put(`${AP}/pricing`, { prices: [{ durationDays: 30, amountRupees: '88' }] })).status, 400);
  assert.equal((await boss.put(`${AP}/pricing`, { prices: [{ durationDays: 30, amountRupees: '88' }], confirm: true })).status, 200);
  assert.equal((await asha.get(`${BASE}/payments/${ids.payAsha}`)).data.payment.amountPaise, before_);
  assert.ok((await boss.get(`${AP}/pricing/history`)).data.changes.length >= 1); assert.equal((await plain.put(`${AP}/pricing`, { prices: [], confirm: true })).status, 403);
});
