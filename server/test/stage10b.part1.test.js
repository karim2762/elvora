// Stage 10B Part 1 — manual UPI payment foundation. MOCKED payment records only: no real money is moved, received or verified.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1'; const BASE = '/priority-certificate'; const AP = '/admin/priority-payments';
let srv, dir, db, svc, boss, plain, asha, ravi, anon, ids = {}, apps = {}, enr = {}, reqs = {};
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

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-10b1-'));
  srv = await startServer({ DOCUMENTS_DIR: path.join(dir, 'documents'), PAYMENT_PROOF_DIR: path.join(dir, 'proofs'), PAYMENT_ADMIN_EMAILS: 'boss@example.com', ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org',
    RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000' });
  ({ db } = await import('../src/db/index.js'));
  svc = await import('../src/services/priorityCertificate.js');
  boss = await makeAdmin('boss@example.com', 'Boss Admin'); plain = await makeAdmin('plain@example.com', 'Plain Admin');
  (await import('../src/db/payments.js')).grantPermission(db.prepare("SELECT id FROM students WHERE email = 'boss@example.com'").get().id, 'certificate.correct', 'test'); // Stage 10C Part 2: reading corrections needs this permission
  asha = client(srv.base); ravi = client(srv.base); anon = client(srv.base);
  const a = await enroll(asha, 'asha@example.com', 'Asha Verma'); const r = await enroll(ravi, 'ravi@example.com', 'Ravi Kumar');
  apps = { asha: a.appId, ravi: r.appId }; enr = { asha: a.enrId, ravi: r.enrId };
  for (const n of ['asha', 'ravi']) ids[n] = db.prepare('SELECT id FROM students WHERE email = ?').get(`${n}@example.com`).id;
  complete(enr.asha); complete(enr.ravi);
  for (const [c, id] of [[asha, ids.asha], [ravi, ids.ravi]]) assert.equal((await c.post(BASE + '/access', { token: svc.createInvitation({ studentId: id }).token })).status, 200);
  reqs.asha = await draft(asha, apps.asha); reqs.ravi = await draft(ravi, apps.ravi);
});
after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('2/3 missing config and disabled payments show a not-ready state and expose nothing; orders are refused', async () => {
  const a = await asha.get(BASE + '/payment-info'); assert.equal(a.data.state, 'not_ready'); assert.equal(a.data.upiId, undefined); assert.equal(a.data.payeeName, undefined);
  assert.equal((await asha.post(`${BASE}/requests/${reqs.asha}/payment-order`, {})).status, 503);
  // incomplete config cannot be enabled
  const bad = await boss.put(`${AP}/config`, { manualEnabled: true }); assert.equal(bad.status, 400); assert.ok(bad.data.error.fields.manualEnabled);
  assert.equal((await configure({ manualEnabled: false })).status, 200);
  const d = await asha.get(BASE + '/payment-info'); assert.equal(d.data.state, 'disabled'); assert.equal(d.data.upiId, undefined);
  assert.equal((await asha.post(`${BASE}/requests/${reqs.asha}/payment-order`, {})).data.error.code, 'PAYMENTS_DISABLED');
});

test('1 correct UPI configuration; example IDs rejected; students see only the safe subset; no hardcoded IDs', async () => {
  for (const upiId of ['bad id', 'name@example', 'sample@okbank']) assert.equal((await configure({ upiId })).status, 400, upiId);
  const ok = await configure(); assert.equal(ok.status, 200); assert.equal(ok.data.config.ready, true); assert.ok(ok.data.config.updatedAt); assert.equal(ok.data.config.updatedByName, 'Boss Admin');
  const s = (await asha.get(BASE + '/payment-info')).data;
  assert.equal(s.state, 'ready'); assert.equal(s.upiId, 'elvora.pay@okbank'); assert.equal(s.payeeName, 'ELVORA Technologies'); assert.equal(s.verificationHours, 24);
  assert.equal(s.updatedBy, undefined); assert.equal(s.updatedByName, undefined); assert.equal(s.updatedAt, undefined);
  const src = fs.readdirSync(path.resolve('src/services')).map((f) => fs.readFileSync(path.resolve('src/services', f), 'utf8')).join('\n');
  assert.ok(!/@(okbank|oksbi|ybl|paytm|upi)\b/.test(src.replace(/name@bank/g, '')), 'no UPI handle hardcoded in services');
  assert.equal((await anon.get(BASE + '/payment-info')).status, 401);
});

test('4/7/9 dynamic price retrieval, default prices, version, no 7-day option, backend-only amount', async () => {
  const p = (await asha.get(BASE + '/pricing')).data; assert.equal(p.pricingVersion, 1);
  assert.deepEqual(p.prices.map((x) => [x.durationDays, x.amountPaise]), [[30, 4900], [60, 9900], [90, 19900]]);
  assert.ok(!p.prices.some((x) => x.durationDays === 7));
  assert.equal((await asha.get(BASE + '/pricing/version')).data.pricingVersion, 1);
  const adm = (await boss.get(`${AP}/pricing`)).data; assert.equal(adm.currency, 'INR'); assert.ok(adm.updatedAt);
});

test('6 unauthorized price/config updates are rejected (student, anonymous, admin without permission, shared key)', async () => {
  const body = { prices: [{ durationDays: 30, amountRupees: 1 }], confirm: true };
  assert.equal((await asha.put(`${AP}/pricing`, body)).status, 403);
  assert.equal((await anon.put(`${AP}/pricing`, body)).status, 401);
  assert.equal((await plain.put(`${AP}/pricing`, body)).data.error.code, 'PERMISSION_REQUIRED');
  assert.equal((await plain.put(`${AP}/config`, { payeeName: 'Evil' })).status, 403);
  assert.equal((await plain.get(`${AP}/pricing/history`)).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM priority_pricing_changes').get().n, 0);
  // granting a permission through the table works
  const { grantPermission } = await import('../src/db/payments.js');
  grantPermission(db.prepare("SELECT id FROM students WHERE email='plain@example.com'").get().id, 'pricing.manage', 'test');
  assert.equal((await plain.get(`${AP}/pricing`)).status, 200); assert.equal((await plain.get(`${AP}/config`)).status, 403);
});

test('5/8 admin price update: validation, preview, confirm, audit, history; existing orders keep their price', async () => {
  // create the order BEFORE the price change
  const o = await asha.post(`${BASE}/requests/${reqs.asha}/payment-order`, { amount: 1, amountPaise: 1, upiId: 'evil@upi', payeeName: 'Evil' }); // untrusted fields must be ignored
  assert.equal(o.status, 201, JSON.stringify(o.data)); ids.payAsha = o.data.payment.id;
  assert.equal(o.data.payment.amountPaise, 4900); assert.equal(o.data.pay.upiId, 'elvora.pay@okbank'); assert.equal(o.data.pay.payeeName, 'ELVORA Technologies');
  assert.match(o.data.pay.upiIntent, /^upi:\/\/pay\?/); const q = new URL(o.data.pay.upiIntent).searchParams; assert.equal(q.get('am'), '49.00'); assert.equal(q.get('pa'), 'elvora.pay@okbank'); assert.equal(q.get('cu'), 'INR');
  assert.match(o.data.pay.qrDataUrl, /^data:image\/png;base64,/);
  for (const bad of [0, -5, 'abc', 10001, '49.999', '']) assert.equal((await boss.put(`${AP}/pricing`, { prices: [{ durationDays: 30, amountRupees: bad }], confirm: true })).status, 400, String(bad));
  assert.equal((await boss.put(`${AP}/pricing`, { prices: [{ durationDays: 7, amountRupees: 10 }], confirm: true })).status, 400);
  const prev = await boss.put(`${AP}/pricing`, { prices: [{ durationDays: 30, amountRupees: 59 }], preview: true });
  assert.equal(prev.status, 200); assert.equal(prev.data.changes[0].nextDisplay, '₹59'); assert.equal((await asha.get(BASE + '/pricing')).data.pricingVersion, 1);
  assert.equal((await boss.put(`${AP}/pricing`, { prices: [{ durationDays: 30, amountRupees: 59 }] })).status, 400); // no confirm
  const sv = await boss.put(`${AP}/pricing`, { prices: [{ durationDays: 30, amountRupees: 59 }, { durationDays: 90, amountRupees: 249.5 }], confirm: true });
  assert.equal(sv.status, 200, JSON.stringify(sv.data)); assert.equal(sv.data.pricingVersion, 2);
  const now = (await asha.get(BASE + '/pricing')).data; assert.deepEqual(now.prices.map((x) => x.amountPaise), [5900, 9900, 24950]);
  const h = (await boss.get(`${AP}/pricing/history`)).data; assert.equal(h.versions.length, 2); assert.equal(h.changes.length, 2);
  const c30 = h.changes.find((c) => c.durationDays === 30); assert.equal(c30.previousPaise, 4900); assert.equal(c30.newPaise, 5900); assert.ok(c30.adminId); assert.ok(c30.at);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'pricing.update'").get());
  assert.throws(() => db.prepare('UPDATE priority_pricing_changes SET new_paise = 1').run()); // append-only
  // the existing order did NOT change
  const again = (await asha.get(`${BASE}/payments/${ids.payAsha}`)).data; assert.equal(again.payment.amountPaise, 4900); assert.equal(again.payment.pricingVersion, 1);
  assert.equal(db.prepare('SELECT amount_paise FROM priority_requests WHERE id = ?').get(reqs.asha).amount_paise, 4900);
  // a NEW request uses the latest price
  const o2 = await ravi.post(`${BASE}/requests/${reqs.ravi}/payment-order`, {}); assert.equal(o2.status, 201); ids.payRavi = o2.data.payment.id;
  assert.equal(o2.data.payment.amountPaise, 5900); assert.equal(o2.data.payment.pricingVersion, 2);
});

test('10/11/17 standard internships stay free; no 7-day paid order; ownership of orders', async () => {
  const noOrder = await boss.get('/admin/applications'); assert.equal(noOrder.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM priority_payments WHERE duration_days = 7").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM priority_payments').get().n, 2);
  assert.equal((await asha.post(`${BASE}/requests/${reqs.ravi}/payment-order`, {})).status, 404);
  assert.equal((await asha.get(`${BASE}/payments/${ids.payRavi}`)).status, 404);
  assert.equal((await asha.get(`${BASE}/payments/${ids.payRavi}/status`)).status, 404);
  assert.equal((await asha.post(`${BASE}/payments/${ids.payRavi}/submit`, sub({ utr: 'STEAL1234567' }))).status, 404);
  assert.equal((await anon.get(`${BASE}/payments`)).status, 401);
  assert.equal((await asha.get(BASE + '/payments')).data.payments.length, 1);
  // the same request returns the same order (idempotent), never a second one
  assert.equal((await asha.post(`${BASE}/requests/${reqs.asha}/payment-order`, {})).data.payment.id, ids.payAsha);
});

test('12/13/16 UTR validation, wrong amount, confirmation; student cannot change status', async () => {
  const P = `${BASE}/payments/${ids.payAsha}`;
  for (const utr of ['12', 'ABC$1234567', '000000000000', '', 'A'.repeat(40)]) assert.equal((await asha.post(`${P}/submit`, sub({ utr }))).data?.error?.fields?.utr !== undefined, true, utr);
  assert.equal((await asha.post(`${P}/submit`, sub({ confirmed: false }))).status, 400);
  assert.equal((await asha.post(`${P}/submit`, sub({ paymentDate: '2020-01-01' }))).status, 400);
  assert.equal((await asha.post(`${P}/submit`, sub({ paymentTime: '25:99' }))).status, 400);
  const wrong = await asha.post(`${P}/submit`, sub({ amountPaise: 100 })); assert.equal(wrong.status, 400); assert.equal(wrong.data.error.code, 'PAYMENT_AMOUNT_MISMATCH');
  const attempt = await asha.post(`${P}/submit`, sub({ status: 'VERIFIED', amountPaise: 4900, expectedPaise: 1 })); // status/expected fields are never read
  assert.equal(attempt.status, 201, JSON.stringify(attempt.data));
  assert.equal(attempt.data.payment.status, 'PENDING_VERIFICATION'); assert.equal(attempt.data.payment.amountPaise, 4900);
  assert.equal(db.prepare('SELECT status FROM priority_requests WHERE id = ?').get(reqs.asha).status, 'Payment Pending');
  assert.equal((await asha.patch(P, { status: 'VERIFIED' })).status, 404); assert.equal((await asha.put(P, { status: 'VERIFIED' })).status, 404);
});

test('12/20/21 submission result: reference, deadline, message, timeline, notifications, audit; resubmission blocked; originals preserved', async () => {
  const s = (await asha.get(`${BASE}/payments/${ids.payAsha}`)).data.payment;
  assert.match(s.internalReference, /^ELV-PAY-\d{8}-[A-F0-9]{6}$/); assert.equal(s.submission.utr, '412345678901'); assert.ok(s.submittedAt);
  assert.equal(Date.parse(s.verificationDeadline) - Date.parse(s.submittedAt), 24 * 3600000);
  assert.match(s.message, /normally within 24 hours/);
  assert.deepEqual(s.timeline.map((t) => [t.key, t.state]), [['created', 'done'], ['awaiting', 'done'], ['submitted', 'done'], ['review', 'current'], ['outcome', 'upcoming']]);
  assert.equal((await asha.get(`${BASE}/payments/${ids.payAsha}/status`)).data.status, 'PENDING_VERIFICATION');
  const n = db.prepare("SELECT student_id, type FROM notifications WHERE type IN ('payment_submitted','payment_verification_needed')").all();
  assert.ok(n.some((x) => x.student_id === ids.asha && x.type === 'payment_submitted')); assert.ok(n.filter((x) => x.type === 'payment_verification_needed').length >= 2);
  const acts = db.prepare("SELECT action FROM audit_logs WHERE target_id = ?").all(ids.payAsha).map((x) => x.action); assert.ok(acts.includes('payment.submit') && acts.includes('payment.order_create'));
  assert.equal((await asha.post(`${BASE}/payments/${ids.payAsha}/submit`, sub({ utr: 'ANOTHER12345' }))).data.error.code, 'ALREADY_SUBMITTED');
  assert.throws(() => db.prepare('UPDATE priority_payment_submissions SET utr = ?').run('X')); assert.throws(() => db.prepare('DELETE FROM priority_payment_submissions').run());
  // not auto-verified when the deadline passes
  db.prepare("UPDATE priority_payments SET verification_deadline = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(ids.payAsha);
  assert.equal((await asha.get(`${BASE}/payments/${ids.payAsha}`)).data.payment.status, 'PENDING_VERIFICATION');
  assert.equal(db.prepare('SELECT document_id FROM priority_requests WHERE id = ?').get(reqs.asha).document_id, null); // no certificate from a pending payment
});

test('14/15 duplicate UTR across students (any formatting) is refused and audited', async () => {
  const P = `${BASE}/payments/${ids.payRavi}`;
  const d = await ravi.post(`${P}/submit`, sub({ utr: ' 4123 4567 8901 ' })); assert.equal(d.status, 409); assert.equal(d.data.error.code, 'DUPLICATE_UTR');
  assert.equal((await ravi.post(`${P}/submit`, sub({ utr: '412345678901'.toLowerCase() }))).status, 409);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment.duplicate_attempt'").get());
  assert.equal(db.prepare("SELECT status FROM priority_payments WHERE id = ?").get(ids.payRavi).status, 'AWAITING_PAYMENT');
});

test('18 private proof: type/size checks, owner-only download, admin download needs permission, not publicly served', async () => {
  const P = `${BASE}/payments/${ids.payRavi}`;
  const cookieOf = async (email) => { const c = client(srv.base); await c.post('/auth/login', { email, password: PW }); return c; };
  const rawAs = async (email, method, p, body, type) => { // log in again to capture the cookie
    const res = await fetch(srv.base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    return fetch(srv.base + p, { method, headers: { ...(type ? { 'Content-Type': type } : {}), cookie }, body });
  };
  void cookieOf;
  assert.equal((await rawAs('ravi@example.com', 'POST', `${P}/proof`, Buffer.from('<script>alert(1)</script>'), 'image/png')).status, 415); // wrong content for the declared type
  assert.equal((await rawAs('ravi@example.com', 'POST', `${P}/proof`, Buffer.from('x'), 'text/html')).status, 400); // body not parsed: no file
  assert.equal((await rawAs('ravi@example.com', 'POST', `${P}/proof`, Buffer.alloc(4 * 1024 * 1024, 1), 'image/png')).status, 413);
  assert.equal((await rawAs('asha@example.com', 'POST', `${P}/proof`, PNG, 'image/png')).status, 404); // not her payment
  const up = await rawAs('ravi@example.com', 'POST', `${P}/proof`, PNG, 'image/png'); assert.equal(up.status, 201); const { proofId } = await up.json();
  const ok = await ravi.post(`${P}/submit`, sub({ utr: 'UTRRAVI98765', proofId })); assert.equal(ok.status, 201, JSON.stringify(ok.data)); assert.equal(ok.data.payment.submission.hasProof, true);
  assert.equal((await rawAs('ravi@example.com', 'GET', `${P}/proof/${proofId}`)).status, 200);
  assert.equal((await rawAs('asha@example.com', 'GET', `${P}/proof/${proofId}`)).status, 404);
  assert.equal((await fetch(`${srv.base}/priority-certificate/payments/${ids.payRavi}/proof/${proofId}`)).status, 401);
  const file = db.prepare('SELECT file_name FROM priority_payment_proofs WHERE id = ?').get(proofId).file_name;
  for (const u of [`/storage/payment-proofs/${file}`, `/${file}`, `/api/v1/${file}`]) assert.notEqual((await fetch(srv.base.replace('/api/v1', '') + u)).status, 200);
  assert.equal((await asha.get(`${AP}/${ids.payRavi}/proof`)).status, 403);
  assert.equal((await plain.get(`${AP}/${ids.payRavi}/proof`)).status, 403);
  const a = await boss.get(`${AP}/${ids.payRavi}/proof`); assert.equal(a.status, 200);
  // a proof can never be reused or taken from another payment
  assert.equal((await asha.post(`${BASE}/payments/${ids.payAsha}/submit`, sub({ proofId }))).status, 409);
});

test('19/20 payment history and timeline for an unsubmitted/expired order', async () => {
  assert.equal((await ravi.get(BASE + '/payments')).data.payments[0].status, 'PENDING_VERIFICATION');
  // expiry is lazy and moves the request back to Draft so a new order can be created
  const { db: d } = { db };
  const stu = await makeAdmin('x@example.com', 'X Admin'); void stu;
  const c = client(srv.base); const e = await enroll(c, 'maya@example.com', 'Maya Rao'); complete(e.enrId);
  const mid = db.prepare('SELECT id FROM students WHERE email = ?').get('maya@example.com').id;
  await c.post(BASE + '/access', { token: svc.createInvitation({ studentId: mid }).token });
  const rid = await draft(c, e.appId); const o = await c.post(`${BASE}/requests/${rid}/payment-order`, {}); assert.equal(o.status, 201);
  assert.deepEqual(o.data.payment.timeline.map((t) => t.state), ['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
  d.prepare("UPDATE priority_payments SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(o.data.payment.id);
  assert.equal((await c.get(`${BASE}/payments/${o.data.payment.id}/status`)).data.status, 'EXPIRED');
  assert.equal(d.prepare('SELECT status FROM priority_requests WHERE id = ?').get(rid).status, 'Draft');
  assert.equal((await c.post(`${BASE}/payments/${o.data.payment.id}/submit`, sub({ utr: 'LATEUTR123456' }))).status, 409);
  assert.equal((await c.post(`${BASE}/requests/${rid}/payment-order`, {})).status, 201); // a fresh order is possible
});

test('submissions can be paused without hiding the order', async () => {
  const c = client(srv.base); const e = await enroll(c, 'nina@example.com', 'Nina Das'); complete(e.enrId);
  await c.post(BASE + '/access', { token: svc.createInvitation({ studentId: db.prepare('SELECT id FROM students WHERE email = ?').get('nina@example.com').id }).token });
  const rid = await draft(c, e.appId); const o = await c.post(`${BASE}/requests/${rid}/payment-order`, {}); assert.equal(o.status, 201);
  assert.equal((await configure({ submissionsEnabled: false })).status, 200);
  assert.equal((await c.get(BASE + '/payment-info')).data.submissionsOpen, false);
  assert.equal((await c.post(`${BASE}/payments/${o.data.payment.id}/submit`, sub({ utr: 'PAUSED1234567' }))).data.error.code, 'SUBMISSIONS_PAUSED');
  assert.equal((await configure({ submissionsEnabled: true })).status, 200);
  // changing the UPI ID later does not touch the stored order snapshot
  assert.equal((await configure({ upiId: 'elvora.new@okbank' })).status, 200);
  assert.equal(db.prepare('SELECT payee_upi_id FROM priority_payments WHERE id = ?').get(o.data.payment.id).payee_upi_id, 'elvora.pay@okbank');
  assert.equal((await c.get(`${BASE}/payments/${o.data.payment.id}`)).data.pay.upiId, 'elvora.pay@okbank');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment.config_update'").get());
});

test('22/23 Stage 10A free correction and certificate eligibility gates are untouched; ineligible students cannot pay', async () => {
  assert.equal((await asha.get(BASE + '/corrections')).status, 200); assert.equal((await boss.get('/admin/priority-certificates/corrections')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM free_corrections WHERE fee_paise <> 0').get().n, 0);
  const c = client(srv.base); const e = await enroll(c, 'zed@example.com', 'Zed Khan'); // not completed
  await c.post(BASE + '/access', { token: svc.createInvitation({ studentId: db.prepare('SELECT id FROM students WHERE email = ?').get('zed@example.com').id }).token });
  assert.equal((await c.post(BASE + '/requests', { applicationId: e.appId, confirmPersonal: true, confirmAcademic: true })).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE type = 'certificate'").get().n, 0); // nothing issued by any payment step
  // the old stage-10A request view no longer says payment is "later"
  assert.doesNotMatch(JSON.stringify((await ravi.get(BASE + '/requests')).data), /later release/);
});
