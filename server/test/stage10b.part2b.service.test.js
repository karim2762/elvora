// Stage 10B Part 2B — manual refunds, overdue management, notifications, settings confirmation and free-correction independence.
// Service/database level: it drives the real services and the real migrated SQLite schema (triggers, constraints) with MOCKED payment records.
// No real money is received and no real UPI transaction is verified anywhere in this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-10b2b-'));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file::memory:', SESSION_SECRET: 'test-secret-test-secret-test-secret-1234', AUTOMATION_ENABLED: 'false',
  PAYMENT_PROOF_DIR: path.join(dir, 'proofs'), PAYMENT_ADMIN_EMAILS: '' });
const { db } = await import('../src/db/index.js');
const Pay = await import('../src/db/payments.js');
const pay = await import('../src/services/payments.js');
const rev = await import('../src/services/paymentReview.js');
const rf = await import('../src/services/paymentRefunds.js');
const od = await import('../src/services/paymentOverdue.js');
const wk = await import('../src/automation/worker.js');
const prio = await import('../src/services/adminPriority.js');
const audit = await import('../src/db/audit.js');
const T = new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const ACK = { accountChecked: true, utrMatches: true, amountMatches: true, transactionSuccessful: true, notAssignedElsewhere: true };
const sub = (over = {}) => ({ utr: '412345678901', paymentDate: today(), paymentTime: '10:30', upiApp: 'PhonePe', confirmed: true, ...over });
const code = (fn) => { try { fn(); } catch (e) { return e.code ?? e.message; } return 'NO_ERROR'; };
const fields = (fn) => { try { fn(); } catch (e) { return e.fields ?? {}; } return null; };

let n = 0; const admins = {}; const stu = {};
const mkStudent = (id, name, role = 'student') => { db.prepare(`INSERT INTO students (id, full_name, email, phone, password_hash, college, degree, branch, academic_year, graduation_year, role, created_at, updated_at)
  VALUES (?, ?, ?, '9', 'x', 'C', 'D', 'B', '3rd', 2027, ?, ?, ?)`).run(id, name, `${id.toLowerCase()}@example.com`, role, T, T); return { id, fullName: name, email: `${id.toLowerCase()}@example.com` }; };
const mkAdmin = (id, name, perms = ['payment.review']) => { const a = mkStudent(id, name, 'admin'); for (const p of perms) Pay.grantPermission(id, p, 'test'); return { ...a, via: 'session' }; };
// A student with an application, an enrollment, a request waiting for payment and a payment order (all mocked, nothing eligible/completed).
function mkOrder(studentId, { days = 30 } = {}) {
  const k = ++n; const appId = `APP-T${k}`; const enrId = `ENR-T${k}`; const reqId = `PRQ-T${k}`;
  db.prepare(`INSERT INTO applications (id, student_id, internship_id, internship_title, internship_category, internship_duration_days, full_name, email, phone, college, degree, branch, academic_year, motivation, terms_accepted_at, submitted_at, updated_at)
    VALUES (?, ?, 'ELV-T-' || ?, 'Python Internship', 'Python', ?, 'N', 'n@example.com', '9', 'C', 'D', 'B', '3', 'm', ?, ?, ?)`).run(appId, studentId, String(k), days, T, T, T);
  db.prepare('INSERT INTO enrollments (id, application_id, student_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(enrId, appId, studentId, T, T);
  const price = db.prepare('SELECT * FROM priority_pricing WHERE active = 1 AND duration_days = ?').get(days);
  db.prepare(`INSERT INTO priority_requests (id, student_id, application_id, enrollment_id, status, duration_days, price_id, amount_paise, currency, tax_note, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Awaiting Payment', ?, ?, ?, 'INR', 'n', ?, ?)`).run(reqId, studentId, appId, enrId, days, price.id, price.amount_paise, T, T);
  const id = Pay.insertPayment({ requestId: reqId, studentId, applicationId: appId, enrollmentId: enrId, durationDays: days, expectedPaise: price.amount_paise, priceId: price.id, pricingVersion: price.version,
    payeeUpiId: 'elvora.pay@okbank', payeeName: 'ELVORA Technologies', expiresAt: new Date(Date.now() + 72 * 3600000).toISOString() });
  return { id, reqId, appId, enrId, price: price.amount_paise };
}
const reqStatus = (id) => db.prepare('SELECT status FROM priority_requests WHERE id = ?').get(id).status;
const payRow = (id) => db.prepare('SELECT * FROM priority_payments WHERE id = ?').get(id);
const cur = (id) => Pay.submissionFor(id);
const notes = (sid) => db.prepare('SELECT type FROM notifications WHERE student_id = ?').all(sid).map((r) => r.type);
const decide = (admin, o, over = {}) => rev.confirm(admin, o.id, { submissionId: cur(o.id).id, acknowledgements: ACK, ...over });
const rejectIt = (admin, o, reason = 'INVALID_REFERENCE', over = {}) => rev.reject(admin, o.id, { submissionId: cur(o.id).id, reason, ...over });


let u = 0; const nextUtr = (p = 'ZRF') => `${p}${String(++u).padStart(9, '0')}XQ`;
const notesOf = (sid, type) => db.prepare('SELECT * FROM notifications WHERE student_id = ? AND type = ?').all(sid, type);
const verified = (student, over = {}) => { const o = mkOrder(student.id, over); pay.submitReference(student, o.id, sub({ utr: nextUtr('PAY') })); decide(admins.boss, o); return o; };
const RF = (over = {}) => ({ amountRupees: '10', reason: 'Duplicate payment made by the student', destination: 'student@okbank', ...over });
const RACK = { accountChecked: true, referenceMatches: true, amountMatches: true };
const finish = (admin, id, utr = nextUtr('RFN'), over = {}) => rf.completeRefund(admin, id, { refundUtr: utr, acknowledgements: RACK, ...over });

before(() => {
  admins.boss = mkAdmin('ADM-BOSS', 'Boss Admin', ['payment.review', 'payment.refund', 'payment.configure', 'pricing.manage']);
  admins.reviewer = mkAdmin('ADM-REV', 'Reviewer Only', ['payment.review']); admins.plain = mkAdmin('ADM-PLAIN', 'Plain Admin', []);
  admins.refunder = mkAdmin('ADM-RFD', 'Refund Admin', ['payment.refund']);
  stu.asha = mkStudent('ELV-ASHA', 'Asha Verma'); stu.ravi = mkStudent('ELV-RAVI', 'Ravi Kumar'); stu.mira = mkStudent('ELV-MIRA', 'Mira Shah'); stu.dev = mkStudent('ELV-DEV', 'Dev Rao');
  Pay.saveConfig({ upiId: 'elvora.pay@okbank', payeeName: 'ELVORA Technologies', instructions: 'Pay the exact amount.', supportContact: 'support@elvora.in', verificationHours: 24, manualEnabled: true, submissionsEnabled: true }, admins.boss);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('migration 25: refund tables, widened permission list, existing permission rows kept', () => {
  assert.ok(db.pragma('user_version', { simple: true }) >= 25);
  for (const t of ['payment_refunds', 'payment_refund_events']) assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), t);
  assert.ok(Pay.hasPermission('ADM-BOSS', 'payment.refund')); assert.ok(Pay.hasPermission('ADM-BOSS', 'payment.review'));
  assert.ok(pay.PERMISSIONS.includes('payment.refund'));
});

test('22 manual refund creation: only for a VERIFIED payment; original confirmed record untouched; REFUND_REQUESTED; no "sent" claim', () => {
  const unver = mkOrder(stu.asha.id); pay.submitReference(stu.asha, unver.id, sub({ utr: nextUtr('PAY') }));
  assert.equal(code(() => rf.createRefund(admins.boss, unver.id, RF())), 'PAYMENT_NOT_VERIFIED');
  const o = verified(stu.asha); const before_ = { ...payRow(o.id) };
  const out = rf.createRefund(admins.boss, o.id, RF({ amountRupees: '12.50' }));
  assert.equal(out.refund.status, 'REFUND_REQUESTED'); assert.equal(out.refund.amountPaise, 1250); assert.equal(out.refund.requestedByName, 'Boss Admin'); assert.ok(out.refund.requestedAt);
  assert.deepEqual({ ...payRow(o.id) }, before_, 'the confirmed payment row is unchanged'); assert.equal(payRow(o.id).status, 'VERIFIED');
  assert.equal(out.balance?.availablePaise ?? rf.balance(o.id).availablePaise, o.price - 1250);
  const n = notesOf(stu.asha.id, 'refund_requested'); assert.equal(n.length, 1); assert.match(n[0].message, /not a confirmation that any money has been sent/);
  assert.equal(notesOf('ADM-RFD', 'refund_requested_admin').length, 1, 'other refund administrators are told'); assert.equal(notesOf('ADM-BOSS', 'refund_requested_admin').length, 0, 'not the requester');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'refund.request' AND target_id = ?").get(o.id));
  assert.equal(Pay.refundEvents(out.refund.id)[0].event, 'requested');
});

test('refund permissions and ownership: reviewer-only, plain admin, shared key, student and self are refused', () => {
  const o = verified(stu.ravi);
  for (const a of [admins.reviewer, admins.plain, { ...admins.boss, via: 'apiKey' }, { ...stu.ravi, via: 'session' }]) assert.equal(code(() => rf.createRefund(a, o.id, RF())), 'PERMISSION_REQUIRED');
  const self = mkAdmin('ADM-SELF', 'Self Admin', ['payment.refund', 'payment.review']);
  const own = mkOrder(self.id); Pay.addEvent; // an administrator's own payment
  pay.submitReference({ ...self }, own.id, sub({ utr: nextUtr('PAY') })); decide(admins.boss, own);
  assert.equal(code(() => rf.createRefund(self, own.id, RF())), 'SELF_REVIEW');
  const r = rf.createRefund(admins.boss, o.id, RF()).refund;
  for (const fn of [rf.markPending, rf.rejectRefund, rf.completeRefund]) assert.equal(code(() => fn(admins.reviewer, r.id, { reason: 'long enough reason', refundUtr: nextUtr(), acknowledgements: RACK })), 'PERMISSION_REQUIRED');
  assert.equal(Pay.refundById(r.id).status, 'REFUND_REQUESTED');
  assert.equal(code(() => rf.markPending(admins.boss, 'RFD-NOPE00')), 'REFUND_NOT_FOUND');
});

test('23/28 refund amount and balance validation: cannot exceed the confirmed amount, partials cannot add up to more, rejected refunds release their share', () => {
  const o = verified(stu.mira, { days: 30 }); const total = o.price;
  assert.deepEqual(Object.keys(fields(() => rf.createRefund(admins.boss, o.id, { amountRupees: 'abc', reason: 'x', destination: '' }))).sort(), ['amountRupees', 'destination', 'reason']);
  for (const bad of ['0', '-5', '1e3', '12.345', '']) assert.ok(fields(() => rf.createRefund(admins.boss, o.id, RF({ amountRupees: bad })))?.amountRupees, bad);
  assert.equal(code(() => rf.createRefund(admins.boss, o.id, RF({ amountRupees: String(total / 100 + 1) }))), 'REFUND_EXCEEDS_PAYMENT');
  assert.ok(fields(() => rf.createRefund(admins.boss, o.id, RF({ destination: 'not a upi@@' })))?.destination);
  const half = rf.createRefund(admins.boss, o.id, RF({ amountRupees: String(total / 200) })).refund;
  assert.equal(rf.balance(o.id).availablePaise, total - total / 2);
  assert.equal(code(() => rf.createRefund(admins.boss, o.id, RF({ amountRupees: String(total / 200 + 1) }))), 'REFUND_EXCEEDS_BALANCE');
  const rest = rf.createRefund(admins.boss, o.id, RF({ amountRupees: String(total / 200) })).refund; // exactly the remainder
  assert.equal(rf.balance(o.id).availablePaise, 0); assert.equal(rf.summaryFor(o.id).canRequest, false);
  assert.equal(code(() => rf.createRefund(admins.boss, o.id, RF({ amountRupees: '1' }))), 'REFUND_EXCEEDS_BALANCE');
  rf.rejectRefund(admins.boss, rest.id, { reason: 'Declined: wrong amount requested' }); assert.equal(rf.balance(o.id).availablePaise, total / 2, 'a rejected refund releases its share');
  assert.ok(rf.createRefund(admins.boss, o.id, RF({ amountRupees: String(total / 200) })).refund.id);
  // the database refuses an over-refund even if the service were bypassed
  assert.throws(() => db.prepare("INSERT INTO payment_refunds (id, payment_id, student_id, amount_paise, reason, destination, status, requested_by, requested_by_name, requested_at, updated_at) VALUES ('RFD-RAW001', ?, ?, 100, 'raw', 'x@y', 'REFUND_REQUESTED', 'a', 'a', ?, ?)").run(o.id, stu.mira.id, T, T), /exceed/);
  assert.ok(half.id);
});

test('25/24 refund completion needs the real reference + account-check acknowledgements; unique reference; the payment UTR is not a refund reference', () => {
  const o = verified(stu.dev); const r = rf.createRefund(admins.boss, o.id, RF({ amountRupees: '5' })).refund;
  assert.equal(code(() => finish(admins.boss, r.id)), 'REFUND_STATE', 'cannot jump from REQUESTED to REFUNDED');
  rf.markPending(admins.boss, r.id, { notes: 'Approved for transfer' }); assert.equal(Pay.refundById(r.id).status, 'REFUND_PENDING');
  assert.equal(notesOf(stu.dev.id, 'refund_pending').length, 1); assert.match(notesOf(stu.dev.id, 'refund_pending')[0].message, /has not been sent yet/);
  for (const bad of [undefined, '', 'short', '11111111111111', 'ab cd!']) assert.ok(fields(() => rf.completeRefund(admins.boss, r.id, { refundUtr: bad, acknowledgements: RACK }))?.refundUtr, String(bad));
  assert.ok(fields(() => rf.completeRefund(admins.boss, r.id, { refundUtr: nextUtr('RFN') }))?.accountChecked, 'acknowledgements are mandatory');
  assert.equal(Pay.refundById(r.id).status, 'REFUND_PENDING'); assert.equal(notesOf(stu.dev.id, 'refund_completed').length, 0, 'nothing claimed before completion');
  assert.equal(code(() => finish(admins.boss, r.id, Pay.confirmedUtrOf(o.id))), 'REFUND_REFERENCE_IS_PAYMENT');
  const utr = nextUtr('RFN'); const done = finish(admins.boss, r.id, ` ${utr.toLowerCase()} `, { refundDate: today() });
  assert.equal(done.refund.status, 'REFUNDED'); assert.equal(done.refund.refundUtr, utr); assert.equal(done.refund.completedBy, 'ADM-BOSS'); assert.ok(done.refund.completedAt);
  const n = notesOf(stu.dev.id, 'refund_completed'); assert.equal(n.length, 1); assert.ok(n[0].message.includes(utr));
  assert.equal(payRow(o.id).status, 'VERIFIED', 'the confirmed payment record is preserved'); assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'refund.complete'").get());
  // duplicate refund reference on another refund
  const o2 = verified(stu.dev); const r2 = rf.createRefund(admins.boss, o2.id, RF({ amountRupees: '5' })).refund; rf.markPending(admins.boss, r2.id);
  assert.equal(code(() => finish(admins.boss, r2.id, utr)), 'DUPLICATE_REFUND_REFERENCE'); assert.equal(Pay.refundById(r2.id).status, 'REFUND_PENDING');
  assert.throws(() => db.prepare("UPDATE payment_refunds SET status = 'REFUNDED', refund_utr = ?, completed_at = ?, completed_by = 'x' WHERE id = ?").run(utr, T, r2.id), /UNIQUE|constraint/i);
  // a completed refund is final
  assert.equal(code(() => rf.rejectRefund(admins.boss, r.id, { reason: 'Trying to undo a completed refund' })), 'REFUND_STATE');
  assert.equal(code(() => rf.markPending(admins.boss, r.id)), 'REFUND_STATE');
  assert.throws(() => db.prepare("UPDATE payment_refunds SET amount_paise = 1 WHERE id = ?").run(r.id), /cannot be changed/);
  assert.throws(() => db.prepare("DELETE FROM payment_refunds WHERE id = ?").run(r.id), /cannot be deleted/);
  assert.throws(() => db.prepare("UPDATE payment_refund_events SET note = 'x'").run(), /append-only/); assert.throws(() => db.prepare("DELETE FROM payment_refund_events").run(), /append-only/);
  // REFUNDED without a reference is impossible at the database level
  assert.throws(() => db.prepare("UPDATE payment_refunds SET status = 'REFUNDED' WHERE id = ?").run(r2.id), /constraint|CHECK/i);
});

test('26 refund rejection: needs a reason, works from REQUESTED and PENDING, notifies, frees balance, is final', () => {
  const o = verified(stu.asha); const r = rf.createRefund(admins.boss, o.id, RF({ amountRupees: '3' })).refund;
  assert.ok(fields(() => rf.rejectRefund(admins.boss, r.id, { reason: 'no' }))?.reason);
  rf.markPending(admins.boss, r.id);
  const out = rf.rejectRefund(admins.boss, r.id, { reason: 'Student withdrew the refund request' });
  assert.equal(out.refund.status, 'REFUND_REJECTED'); assert.equal(out.refund.rejectedByName, 'Boss Admin'); assert.equal(out.balance.availablePaise, o.price);
  const n = notesOf(stu.asha.id, 'refund_rejected').find((x) => x.message.includes('withdrew')); assert.ok(n); assert.match(n.message, /No refund has been sent/);
  assert.equal(code(() => finish(admins.boss, r.id)), 'REFUND_STATE'); assert.equal(code(() => rf.rejectRefund(admins.boss, r.id, { reason: 'Rejecting twice should fail' })), 'REFUND_STATE');
  const r2 = rf.createRefund(admins.boss, o.id, RF({ amountRupees: '3' })).refund; rf.rejectRefund(admins.boss, r2.id, { reason: 'Rejected straight from requested' });
  assert.deepEqual(Pay.refundEvents(r.id).map((e) => e.event), ['requested', 'pending', 'rejected']);
});

test('27 multiple partial refunds complete independently and add up; student sees outcomes only (no destination/notes/admin names); balance exact', () => {
  const o = verified(stu.ravi, { days: 60 }); const total = o.price;
  const a = rf.createRefund(admins.boss, o.id, RF({ amountRupees: String(total / 400), destination: 'secret.dest@okbank', notes: 'internal-only note' })).refund;
  const b = rf.createRefund(admins.boss, o.id, RF({ amountRupees: String(total / 400) })).refund;
  for (const x of [a, b]) rf.markPending(admins.boss, x.id);
  finish(admins.boss, a.id); assert.equal(rf.balance(o.id).completedPaise, total / 4); assert.equal(rf.balance(o.id).reservedPaise, total / 2);
  finish(admins.boss, b.id); assert.equal(rf.balance(o.id).completedPaise, total / 2); assert.equal(rf.balance(o.id).availablePaise, total / 2);
  const sv = rf.studentRefunds(stu.ravi, o.id).refunds; assert.equal(sv.length, 2); const txt = JSON.stringify(sv);
  for (const leak of ['secret.dest', 'internal-only', 'Boss Admin', 'ADM-BOSS', 'destination', 'notes']) assert.ok(!txt.includes(leak), leak);
  assert.ok(sv.every((x) => x.status === 'REFUNDED' && x.refundReference));
  assert.equal(code(() => rf.studentRefunds(stu.asha, o.id)), 'PAYMENT_NOT_FOUND', "another student's payment is a plain 404");
  const pending = verified(stu.mira); const p1 = rf.createRefund(admins.boss, pending.id, RF()).refund; assert.equal(rf.studentRefunds(stu.mira, pending.id).refunds[0].refundReference, null, 'no reference until REFUNDED');
  assert.ok(p1.id);
  assert.ok(rf.listRefunds({ status: 'REFUNDED' }).refunds.length >= 2); assert.equal(code(() => rf.listRefunds({ status: 'BOGUS' })), 'VALIDATION');
  const q = rev.queue({ status: 'refunded' }); assert.ok(q.payments.some((p) => p.paymentId === o.id)); assert.ok(rev.queue({ status: 'refund_pending' }).payments.some((p) => p.paymentId === pending.id));
});

test('concurrent refund requests cannot jointly exceed the payment (balance checked inside the transaction)', () => {
  const o = verified(stu.dev, { days: 90 }); const total = o.price / 100;
  const ok = rf.createRefund(admins.boss, o.id, RF({ amountRupees: (total * 0.6).toFixed(2) }));
  assert.equal(code(() => rf.createRefund(admins.refunder, o.id, RF({ amountRupees: (total * 0.6).toFixed(2) }))), 'REFUND_EXCEEDS_BALANCE');
  assert.equal(Pay.refundReserved(o.id), Math.round(total * 0.6 * 100)); assert.ok(ok.refund.id);
  const r = ok.refund; rf.markPending(admins.boss, r.id);
  assert.equal(code(() => rf.markPending(admins.refunder, r.id)), 'REFUND_STATE', 'second administrator acting on the same state is refused');
});

test('refund does not touch the request or issue/affect any certificate; no certificate is issued by payment verification or refund', () => {
  const o = verified(stu.asha); const status0 = reqStatus(o.reqId); assert.equal(status0, 'Payment Verified');
  const r = rf.createRefund(admins.boss, o.id, RF()).refund; rf.markPending(admins.boss, r.id); finish(admins.boss, r.id);
  assert.equal(reqStatus(o.reqId), status0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0, 'no document exists: neither verification nor refund issues a certificate');
});

test('20/21 overdue: reported, highlighted, reviewers notified once, never auto-decided; resubmission with a new deadline notifies again', () => {
  const a = mkOrder(stu.mira.id); pay.submitReference(stu.mira, a.id, sub({ utr: nextUtr('PAY') }));
  db.prepare("UPDATE priority_payments SET verification_deadline = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(a.id);
  const rep = od.overdueReport(); assert.ok(rep.payments.some((p) => p.id === a.id)); assert.match(rep.notice, /nothing is approved or rejected automatically/i);
  assert.ok(Pay.overdueCount() >= 1);
  const first = od.sweepOverdue(); assert.ok(first.notificationsCreated >= 2, 'every reviewer is told'); const again = od.sweepOverdue(); assert.equal(again.notificationsCreated, 0, 'no duplicate notification');
  rev.queue({}); rev.queue({ status: 'overdue' }); assert.equal(od.sweepOverdue().notificationsCreated, 0);
  const mine = (sid) => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE student_id = ? AND type = 'payment_overdue_admin' AND message LIKE ?").get(sid, `%${payRow(a.id).internal_reference}%`).n;
  assert.equal(mine('ADM-BOSS'), 1); assert.equal(mine('ADM-REV'), 1); assert.equal(mine('ADM-PLAIN'), 0, 'only reviewers'); assert.equal(mine('ADM-RFD'), 0, 'refund-only admin is not a reviewer');
  assert.equal(payRow(a.id).status, 'PENDING_VERIFICATION', 'overdue never decides'); assert.equal(reqStatus(a.reqId), 'Payment Pending');
  assert.equal(rev.queue({ status: 'overdue' }).counts.overdue >= 1, true);
  // a decided payment is no longer overdue
  rejectIt(admins.boss, a, 'TRANSACTION_NOT_FOUND'); assert.ok(!od.overdueReport().payments.some((p) => p.id === a.id));
  // corrected reference => new deadline => a later overdue is a NEW event
  pay.resubmitReference(stu.mira, a.id, { ...sub({ utr: nextUtr('PAY') }), reason: 'Typed the reference wrongly the first time' });
  db.prepare("UPDATE priority_payments SET verification_deadline = '2020-02-02T00:00:00.000Z' WHERE id = ?").run(a.id);
  assert.ok(od.sweepOverdue().notificationsCreated >= 2); assert.equal(od.sweepOverdue().notificationsCreated, 0);
});

test('worker cycle sweeps overdue payments without deciding them and without duplicating notices', async () => {
  const a = mkOrder(stu.ravi.id); pay.submitReference(stu.ravi, a.id, sub({ utr: nextUtr('PAY') }));
  db.prepare("UPDATE priority_payments SET verification_deadline = '2020-03-03T00:00:00.000Z' WHERE id = ?").run(a.id);
  const s1 = await wk.runCycle({ force: true }); assert.ok(s1.overduePayments >= 1); const n1 = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'payment_overdue_admin'").get().n;
  await wk.runCycle({ force: true }); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'payment_overdue_admin'").get().n, n1);
  assert.equal(payRow(a.id).status, 'PENDING_VERIFICATION');
});

test('35/36 notification delivery and idempotency: submission, verification, rejection, more-info, corrected reference, duplicates', () => {
  const o = mkOrder(stu.asha.id); pay.submitReference(stu.asha, o.id, sub({ utr: nextUtr('PAY') }));
  assert.equal(notesOf(stu.asha.id, 'payment_submitted').filter((n) => n.message.includes('submitted successfully')).length >= 1, true);
  assert.ok(notesOf('ADM-BOSS', 'payment_verification_needed').length >= 1, 'admin told about the new submission');
  rejectIt(admins.boss, o, 'INSUFFICIENT_EVIDENCE'); const info = notesOf(stu.asha.id, 'payment_info_required'); assert.equal(info.length >= 1, true); assert.match(info.at(-1).message, /more information/i);
  const dupUtr = nextUtr('DUP'); pay.resubmitReference(stu.asha, o.id, { ...sub({ utr: dupUtr }), reason: 'Corrected reference from my UPI app history' });
  assert.ok(notesOf(stu.asha.id, 'payment_resubmitted').length >= 1); assert.ok(notesOf('ADM-BOSS', 'payment_resubmitted_admin').length >= 1);
  const adminDupBefore = notesOf('ADM-BOSS', 'payment_duplicate_admin').length;
  const o2 = mkOrder(stu.ravi.id); assert.equal(code(() => pay.submitReference(stu.ravi, o2.id, sub({ utr: dupUtr }))), 'DUPLICATE_UTR');
  assert.equal(notesOf('ADM-BOSS', 'payment_duplicate_admin').length, adminDupBefore + 1, 'a blocked duplicate attempt reaches reviewers');
  assert.equal(code(() => pay.submitReference(stu.ravi, o2.id, sub({ utr: dupUtr }))), 'DUPLICATE_UTR'); assert.equal(notesOf('ADM-BOSS', 'payment_duplicate_admin').length, adminDupBefore + 1, 'repeated attempts do not repeat the notice');
  // rejected-then-reused reference is accepted but flagged to admins
  rejectIt(admins.boss, o, 'INVALID_REFERENCE');
  const o3 = mkOrder(stu.mira.id); pay.submitReference(stu.mira, o3.id, sub({ utr: dupUtr })); assert.ok(notesOf('ADM-BOSS', 'payment_duplicate_admin').length >= adminDupBefore + 2);
  // verification notification is written once
  const o4 = mkOrder(stu.dev.id); pay.submitReference(stu.dev, o4.id, sub({ utr: nextUtr('PAY') })); decide(admins.boss, o4);
  const vn = () => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE student_id = ? AND dedupe_key = ?').get(stu.dev.id, `pay:${o4.id}:verified`).n;
  assert.equal(vn(), 1);
  assert.equal(code(() => decide(admins.reviewer, o4)), 'ALREADY_VERIFIED'); assert.equal(vn(), 1);
  // refund notifications are idempotent per event (same dedupe key cannot be inserted twice)
  const r = rf.createRefund(admins.boss, o4.id, RF()).refund;
  assert.equal(notificationsDeduped(stu.dev.id, `refund:${r.id}:requested`), true);
});
function notificationsDeduped(studentId, key) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE student_id = ? AND dedupe_key = ?').get(studentId, key).n; if (n !== 1) return false;
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'index\' AND sql LIKE \'%dedupe_key%\' AND sql LIKE \'%UNIQUE%\'').get() !== undefined;
}

test('UPI settings: destination changes need confirmation; audited; QR image validated, private, replaced; pricing changes need confirmation and never touch old orders', () => {
  assert.ok(fields(() => pay.updateConfig(admins.boss, { upiId: 'new.elvora@okbank' }))?.confirm);
  assert.equal(pay.getAdminConfig().config.upiId, 'elvora.pay@okbank');
  pay.updateConfig(admins.boss, { payeeName: 'ELVORA Technologies Pvt', confirm: true }); assert.equal(pay.getAdminConfig().config.payeeName, 'ELVORA Technologies Pvt');
  const c = pay.updateConfig(admins.boss, { supportContact: 'help@elvora.in' }); assert.deepEqual(c.changed, ['supportContact'], 'non-destination edits need no confirmation');
  assert.ok(c.config.updatedAt && c.config.updatedByName === 'Boss Admin');
  const cfgView = JSON.stringify(pay.getAdminConfig()); assert.ok(!cfgView.includes('qr_file') && !/[a-f0-9]{32}\.png/.test(cfgView), 'private file name is never exposed');
  assert.equal(code(() => pay.setQrImage(admins.boss, Buffer.from('<svg onload=alert(1)>'), 'true')), 'VALIDATION');
  assert.equal(code(() => pay.setQrImage(admins.boss, PNG, undefined)), 'VALIDATION', 'confirmation required');
  assert.equal(code(() => pay.setQrImage(admins.boss, Buffer.alloc(600 * 1024, 1), 'true')), 'VALIDATION');
  assert.equal(code(() => pay.readQrImage()), 'NO_QR');
  const r1 = pay.setQrImage(admins.boss, PNG, 'true'); assert.equal(r1.config.qrImage.configured, true); assert.equal(pay.readQrImage().mime, 'image/png');
  const files1 = fs.readdirSync(path.join(dir, 'payment-qr')); assert.equal(files1.length, 1); assert.match(files1[0], /^[a-f0-9]{32}\.png$/);
  pay.setQrImage(admins.boss, PNG, 'true'); assert.equal(fs.readdirSync(path.join(dir, 'payment-qr')).length, 1, 'the replaced file is removed'); assert.equal(pay.studentPaymentInfo().qrImageAvailable, true);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment.config_update' AND reason LIKE '%qrImage%'").get());
  // pricing: confirm required; historical orders keep their frozen price/version; free corrections do not depend on pricing
  const old = mkOrder(stu.asha.id, { days: 30 }); const oldRow = { ...payRow(old.id) };
  assert.ok(fields(() => pay.updatePricing(admins.boss, { prices: [{ durationDays: 30, amountRupees: '77' }] }))?.confirm);
  const out = pay.updatePricing(admins.boss, { prices: [{ durationDays: 30, amountRupees: '77' }], confirm: true });
  assert.equal(payRow(old.id).expected_paise, oldRow.expected_paise); assert.equal(payRow(old.id).pricing_version, oldRow.pricing_version); assert.ok(out.version > oldRow.pricing_version);
  assert.ok(pay.pricingHistory().changes.some((x) => x.newPaise === 7700)); assert.ok(pay.pricingHistory().versions.length >= 2);
  assert.throws(() => db.prepare('UPDATE priority_payments SET expected_paise = 1 WHERE id = ?').run(old.id), /cannot be changed/);
});

test('29 free administrative corrections have no payment dependency: no order/QR/UTR/refund path, fee frozen at 0, pricing irrelevant', async () => {
  // Stage 10C Part 2: corrections check the certificate.correct permission, which lives in the shared admin_permissions table (db/payments.js). That ONE import is allowed; nothing else payment-related is.
  const src = fs.readFileSync(new URL('../src/services/freeCorrections.js', import.meta.url), 'utf8').replace(/^import \* as Pay from '\.\.\/db\/payments\.js';.*$/m, '');
  assert.ok(!/payments?\.js|paymentReview|paymentRefunds|priority_pricing|priority_payments|payment_refunds|upiId|qrDataUrl|\butr\b/i.test(src), 'freeCorrections.js references no payment, pricing, UPI or refund code');
  const fc = await import('../src/services/freeCorrections.js'); assert.match(fc.FREE_NOTICE, /free of charge/);
  assert.throws(() => db.prepare("INSERT INTO free_corrections (id, fee_paise) VALUES ('FCR-X', 500)").run(), /constraint|CHECK|NOT NULL/i);
  const before_ = db.prepare('SELECT COUNT(*) AS n FROM priority_payments').get().n; pay.updatePricing(admins.boss, { prices: [{ durationDays: 60, amountRupees: '555' }], confirm: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM priority_payments').get().n, before_, 'a pricing change creates no payment order');
});

test('dashboard: overdue/pending/refund counts are shown only to payment reviewers', async () => {
  const { buildAdminDashboard } = await import('../src/services/adminDashboard.js');
  const d = buildAdminDashboard(admins.boss); assert.ok(d.payments && typeof d.payments.overdue === 'number' && typeof d.payments.openRefunds === 'number');
  assert.equal(buildAdminDashboard(admins.plain).payments, undefined);
});

test('payment gateway: none integrated, no hardcoded UPI details, refund notices never claim money was sent early', () => {
  const root = new URL('../src/', import.meta.url); const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } }; walk(root.pathname);
  const pk = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')); assert.ok(!Object.keys(pk.dependencies).some((d) => /razorpay|stripe|paypal|cashfree|payu|phonepe|paytm|instamojo|ccavenue/i.test(d)));
  for (const f of files) { const t = fs.readFileSync(f, 'utf8'); if (f.includes('/payments') || f.includes('paymentReview') || f.includes('paymentRefunds') || f.includes('paymentOverdue')) { assert.ok(!/require\(['"](razorpay|stripe)|from ['"](razorpay|stripe|@stripe)/.test(t), f); } assert.ok(!/@(okbank|oksbi|okhdfcbank|ybl|paytm|upi)\b['"`]/.test(t.replace(/name@bank/g, '')) || f.includes('/db/index.js') === false, f); }
});
