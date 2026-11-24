// Stage 10B Part 2A — administrator payment verification, duplicate protection and audited resubmission.
// Service/database level: it drives the real services and the real migrated SQLite schema (triggers, constraints) with MOCKED payment records.
// No real money is received and no real UPI transaction is verified anywhere in this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-10b2a-'));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file::memory:', SESSION_SECRET: 'test-secret-test-secret-test-secret-1234', AUTOMATION_ENABLED: 'false',
  PAYMENT_PROOF_DIR: path.join(dir, 'proofs'), PAYMENT_ADMIN_EMAILS: '' });
const { db } = await import('../src/db/index.js');
const Pay = await import('../src/db/payments.js');
const pay = await import('../src/services/payments.js');
const rev = await import('../src/services/paymentReview.js');
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

before(() => {
  admins.boss = mkAdmin('ADM-BOSS', 'Boss Admin'); admins.second = mkAdmin('ADM-TWO', 'Second Admin'); admins.plain = mkAdmin('ADM-PLAIN', 'Plain Admin', []);
  stu.asha = mkStudent('ELV-ASHA', 'Asha Verma'); stu.ravi = mkStudent('ELV-RAVI', 'Ravi Kumar'); stu.mira = mkStudent('ELV-MIRA', 'Mira Shah');
  Pay.saveConfig({ upiId: 'elvora.pay@okbank', payeeName: 'ELVORA Technologies', instructions: 'Pay the exact amount.', supportContact: 'support@elvora.in', verificationHours: 24, manualEnabled: true, submissionsEnabled: true }, admins.boss);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('migration 24 applied; submissions keep their rows and now allow revisions', () => {
  assert.equal(db.pragma('user_version', { simple: true }) >= 24, true);
  const cols = db.pragma('table_info(priority_payment_submissions)').map((c) => c.name);
  for (const c of ['revision', 'previous_submission_id', 'replacement_reason']) assert.ok(cols.includes(c), c);
  for (const t of ['priority_payment_reviews', 'confirmed_payment_utrs']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t);
});

test('1 queue display, filters, search and overdue highlighting (no automatic decision)', () => {
  const a = mkOrder(stu.asha.id); const r = mkOrder(stu.ravi.id, { days: 60 });
  pay.submitReference(stu.asha, a.id, sub({ utr: 'QUEUE000A001' })); pay.submitReference(stu.ravi, r.id, sub({ utr: 'QUEUE000R001' }));
  db.prepare("UPDATE priority_payments SET verification_deadline = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(r.id); // deadline long passed
  const q = rev.queue({});
  const row = q.payments.find((p) => p.paymentId === a.id);
  for (const k of ['studentName', 'studentId', 'requestId', 'applicationId', 'durationDays', 'expectedPaise', 'utr', 'internalReference', 'paymentDate', 'paymentTime', 'upiApp', 'submittedAt', 'verificationDeadline', 'status', 'hasProof']) assert.ok(k in row, k);
  assert.equal(row.studentName, 'Asha Verma'); assert.equal(row.utr, 'QUEUE000A001'); assert.equal(row.status, 'PENDING_VERIFICATION');
  assert.equal(q.payments[0].paymentId, r.id, 'overdue first'); assert.equal(q.payments[0].overdue, true);
  assert.equal(payRow(r.id).status, 'PENDING_VERIFICATION', 'overdue is never auto-decided'); assert.equal(reqStatus(r.reqId), 'Payment Pending');
  assert.equal(rev.queue({ status: 'overdue' }).payments.length, 1);
  assert.equal(rev.queue({ status: 'pending' }).payments.length >= 2, true);
  assert.equal(rev.queue({ status: 'verified' }).payments.length, 0);
  assert.equal(rev.queue({ durationDays: '60' }).payments.every((p) => p.durationDays === 60), true);
  assert.equal(rev.queue({ from: today(), to: today() }).payments.length >= 2, true); assert.equal(rev.queue({ from: '2001-01-01', to: '2001-01-02' }).payments.length, 0);
  for (const [term, id] of [['asha verma', a.id], [stu.asha.id, a.id], ['quEUE000a001', a.id], [payRow(a.id).internal_reference, a.id], [a.reqId, a.id], [' QUEUE 000 A001 ', a.id]])
    assert.ok(rev.queue({ q: term }).payments.some((p) => p.paymentId === id), `search ${term}`);
  assert.equal(rev.queue({ q: 'nobody-here' }).payments.length, 0);
  assert.equal(code(() => rev.queue({ status: 'bogus' })), 'VALIDATION'); assert.equal(code(() => rev.queue({ page: '0' })), 'VALIDATION');
  assert.equal(q.counts.overdue, 1);
  // the unsubmitted order is not in the queue
  const idle = mkOrder(stu.mira.id); assert.equal(rev.queue({ q: idle.id }).payments.length, 0);
});

test('2 detail screen: order, amount, submission, history, warnings, related request, instructions', () => {
  const o = mkOrder(stu.mira.id); pay.submitReference(stu.mira, o.id, sub({ utr: 'DETAIL00M001' }));
  const d = rev.detail(admins.boss, o.id);
  assert.match(d.notice, /actual transaction record/); assert.equal(d.payment.expectedPaise, o.price); assert.equal(d.currentSubmission.utr, 'DETAIL00M001');
  assert.equal(d.request.id, o.reqId); assert.equal(d.request.status, 'Payment Pending'); assert.ok(d.request.history.length >= 1);
  assert.equal(d.review.acknowledgements.length, 5); assert.equal(d.review.rejectReasons.length, 8); assert.equal(d.review.canConfirm, true);
  assert.equal(d.student.fullName, 'Mira Shah'); assert.equal(JSON.stringify(d).includes('@example.com'), false, 'no e-mail leaks to the review screen');
  assert.equal(d.duplicates.warning, false); assert.ok(d.events.some((e) => e.event === 'submitted'));
  assert.equal(code(() => rev.detail(admins.boss, 'PAY-NOPE00000000')), 'PAYMENT_NOT_FOUND');
  // blank/own payment cannot be reviewed by its owner
  const own = rev.detail({ ...admins.boss, id: stu.mira.id }, o.id); assert.equal(own.review.canConfirm, false);
});

test('3/4/7 student ownership, invalid UTR and incorrect amount', () => {
  const o = mkOrder(stu.asha.id);
  assert.equal(code(() => pay.submitReference(stu.ravi, o.id, sub({ utr: 'OWN0000000A1' }))), 'PAYMENT_NOT_FOUND', "another student's order looks missing");
  for (const bad of ['', 'abc', '1234', 'AAAAAAAAAAAA', '1234567890', 'has space!!', 'x'.repeat(40)]) assert.ok(fields(() => pay.submitReference(stu.asha, o.id, sub({ utr: bad })))?.utr, `utr ${bad}`);
  assert.equal(code(() => pay.submitReference(stu.asha, o.id, sub({ utr: 'OWN0000000A1', amountPaise: 1 }))), 'PAYMENT_AMOUNT_MISMATCH');
  assert.equal(payRow(o.id).status, 'AWAITING_PAYMENT');
});

test('5/6 duplicate UTR is refused while another submission is live; a reused rejected reference is allowed but FLAGGED (not proof of fraud)', () => {
  const a = mkOrder(stu.asha.id); const r = mkOrder(stu.ravi.id);
  pay.submitReference(stu.asha, a.id, sub({ utr: 'DUPE0000AAA1' }));
  assert.equal(code(() => pay.submitReference(stu.ravi, r.id, sub({ utr: ' dupe 0000 aaa1 ' }))), 'DUPLICATE_UTR');
  assert.equal(payRow(r.id).status, 'AWAITING_PAYMENT'); assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment.duplicate_attempt' AND target_id = ?").get(r.id));
  rejectIt(admins.boss, a, 'INVALID_REFERENCE'); // the first claim is rejected -> the reference is free to appear again, but flagged
  pay.submitReference(stu.ravi, r.id, sub({ utr: 'DUPE0000AAA1' }));
  const d = rev.detail(admins.boss, r.id);
  assert.equal(d.duplicates.warning, true); assert.equal(d.duplicates.crossStudent, true); assert.equal(d.duplicates.others[0].studentName, 'Asha Verma'); assert.equal(d.duplicates.others[0].decision, 'REJECTED');
  assert.match(d.duplicates.note, /not proof of fraud/); assert.ok(d.events.some((e) => e.event === 'duplicate_flagged'));
  assert.equal(rev.queue({ q: r.id }).payments[0].duplicateWarning, true);
  assert.equal(rev.duplicates(r.id).crossStudent, true);
  assert.equal(payRow(r.id).status, 'PENDING_VERIFICATION', 'a warning never auto-rejects');
});

test('8 private proof: content checked, owner-only for students, admin needs payment.review, traversal names refused', () => {
  const o = mkOrder(stu.asha.id);
  assert.equal(code(() => pay.uploadProof(stu.asha, o.id, Buffer.from('<script>alert(1)</script>'))), 'PROOF_TYPE');
  const up = pay.uploadProof(stu.asha, o.id, PNG);
  assert.equal(code(() => pay.uploadProof(stu.ravi, o.id, PNG)), 'PAYMENT_NOT_FOUND');
  pay.submitReference(stu.asha, o.id, sub({ utr: 'PROOF000AAA1', proofId: up.proofId }));
  assert.equal(pay.readProof(o.id, up.proofId, stu.asha.id).mime, 'image/png');
  assert.equal(code(() => pay.readProof(o.id, up.proofId, stu.ravi.id)), 'PROOF_NOT_FOUND');
  assert.equal(code(() => pay.readProof(o.id, '../../etc/passwd')), 'PROOF_NOT_FOUND');
  assert.equal(code(() => rev.proof(admins.boss, 'PAY-OTHER000000', up.proofId, pay.readProof)), 'PROOF_NOT_FOUND', 'a proof is only served under its own payment');
  assert.equal(rev.proof(admins.boss, o.id, up.proofId, pay.readProof).mime, 'image/png'); assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment.proof_view'").get());
  assert.ok(fs.readdirSync(path.join(dir, 'proofs')).every((f) => /^[a-f0-9]{32}\.(png|jpg|pdf)$/.test(f)), 'random file names, stored outside any static folder');
  const mw = (admin) => { let out; pay.requirePermission('payment.review')({ admin }, null, (e) => { out = e?.status ?? 'next'; }); return out; };
  assert.equal(mw(admins.plain), 403); assert.equal(mw({ via: 'key' }), 403); assert.equal(mw(undefined), 403); assert.equal(mw(admins.boss), 'next');
  assert.equal(mw({ via: 'session', id: stu.asha.id }), 403, 'a student is never a reviewer');
});

test('9/10 students and unauthorized administrators cannot verify', () => {
  const o = mkOrder(stu.ravi.id); pay.submitReference(stu.ravi, o.id, sub({ utr: 'AUTH0000RAV1' }));
  assert.equal(pay.can({ via: 'session', id: stu.ravi.id }, 'payment.review'), false);
  assert.equal(pay.can(admins.plain, 'payment.review'), false); assert.equal(pay.can({ via: 'key' }, 'payment.review'), false);
  assert.equal(code(() => rev.confirm({ via: 'key' }, o.id, { submissionId: cur(o.id).id, acknowledgements: ACK })), 'PERMISSION_REQUIRED');
  assert.equal(code(() => decide({ ...admins.boss, id: stu.ravi.id }, o)), 'SELF_REVIEW', 'an administrator cannot review their own payment');
  assert.equal(payRow(o.id).status, 'PENDING_VERIFICATION');
  // client-supplied status is ignored by every student path
  assert.equal(code(() => pay.submitReference(stu.ravi, o.id, sub({ utr: 'AUTH0000RAV2', status: 'VERIFIED' }))), 'ALREADY_SUBMITTED');
  assert.equal(payRow(o.id).status, 'PENDING_VERIFICATION');
  // the database itself refuses a direct status change to VERIFIED without a confirmed reference
  assert.throws(() => db.prepare("UPDATE priority_payments SET status = 'VERIFIED' WHERE id = ?").run(o.id), /confirmed reference/);
});

test('11 confirmation needs every acknowledgement; success sets all records, notifies, audits and issues NOTHING', () => {
  const o = mkOrder(stu.asha.id); pay.submitReference(stu.asha, o.id, sub({ utr: 'CONF0000AAA1' }));
  const docs = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n; const enr = JSON.stringify(db.prepare('SELECT * FROM enrollments WHERE id = ?').get(o.enrId));
  assert.ok(fields(() => rev.confirm(admins.boss, o.id, { submissionId: cur(o.id).id, acknowledgements: { ...ACK, amountMatches: false } })).amountMatches);
  assert.ok(fields(() => rev.confirm(admins.boss, o.id, { submissionId: cur(o.id).id }))); assert.ok(fields(() => rev.confirm(admins.boss, o.id, { submissionId: cur(o.id).id, acknowledgements: { ...ACK, utrMatches: 'true' } })).utrMatches);
  assert.equal(code(() => rev.confirm(admins.boss, o.id, { acknowledgements: ACK })), 'STALE_SUBMISSION', 'the reviewed submission must be named');
  assert.equal(payRow(o.id).status, 'PENDING_VERIFICATION');
  const r = decide(admins.boss, o, { note: 'Matched statement line' });
  assert.equal(r.verified, true); const p = payRow(o.id);
  assert.equal(p.status, 'VERIFIED'); assert.equal(p.verified_by, admins.boss.id); assert.equal(p.verified_by_name, 'Boss Admin'); assert.ok(p.verified_at);
  assert.equal(reqStatus(o.reqId), 'Payment Verified');
  const rv = Pay.reviewOf(cur(o.id).id); assert.equal(rv.decision, 'VERIFIED'); assert.equal(rv.adminId, admins.boss.id); assert.deepEqual(JSON.parse(db.prepare('SELECT acknowledgements FROM priority_payment_reviews WHERE id = ?').get(rv.id).acknowledgements), ACK);
  assert.equal(Pay.confirmedUtr('CONF0000AAA1'), o.id);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment.verify' AND target_id = ? AND admin_id = ?").get(o.id, admins.boss.id));
  assert.ok(notes(stu.asha.id).includes('payment_verified'));
  assert.ok(Pay.eventsFor(o.id).some((e) => e.event === 'verified' && e.to === 'VERIFIED'));
  // NOT a certificate: no document, no enrollment change, request not approved/issued, and the old gates still hold
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, docs); assert.equal(JSON.stringify(db.prepare('SELECT * FROM enrollments WHERE id = ?').get(o.enrId)), enr);
  assert.equal(code(() => prio.changeStatus(admins.boss, o.reqId, { to: 'Approved for Issuance', note: 'trying to skip the review steps' })), 'INVALID_TRANSITION');
  assert.equal(code(() => prio.changeStatus(admins.boss, o.reqId, { to: 'Under Review' })), 'INVALID_TRANSITION');
  assert.equal(code(() => prio.changeStatus(admins.boss, o.reqId, { to: 'Certificate Issued' })), 'USE_ISSUE_ACTION');
  assert.equal(code(() => prio.changeStatus(admins.boss, o.reqId, { to: 'Payment Verified' })), 'PAYMENT_STAGE_NOT_AVAILABLE', 'an admin still cannot type a payment status onto a request');
  assert.deepEqual(prio.ADMIN_TRANSITIONS['Payment Verified'], ['Eligibility Check'], 'a verified request enters the existing eligibility review');
  assert.equal(JSON.stringify(Pay.getConfig()).includes('elvora'), true);
});

test('12 rejection needs a reason; "Other" needs a note; the submission, proof and ownership of the order are preserved', () => {
  const o = mkOrder(stu.ravi.id); const up = pay.uploadProof(stu.ravi, o.id, PNG); pay.submitReference(stu.ravi, o.id, sub({ utr: 'REJ00000RAV1', proofId: up.proofId }));
  const sid = cur(o.id).id;
  for (const body of [{}, { reason: '' }, { reason: 'because' }]) assert.ok(fields(() => rev.reject(admins.boss, o.id, { submissionId: sid, ...body })).reason, JSON.stringify(body));
  assert.ok(fields(() => rev.reject(admins.boss, o.id, { submissionId: sid, reason: 'OTHER' })).note); assert.ok(fields(() => rev.reject(admins.boss, o.id, { submissionId: sid, reason: 'OTHER', note: 'short' })).note);
  assert.equal(payRow(o.id).status, 'PENDING_VERIFICATION');
  for (const c of Object.keys(pay.REJECT_LABELS)) assert.ok(rev.REJECT_REASONS.some((x) => x.code === c));
  rev.reject(admins.boss, o.id, { submissionId: sid, reason: 'OTHER', note: 'Screenshot shows a different payee name.' });
  const p = payRow(o.id); assert.equal(p.status, 'REJECTED'); assert.equal(p.rejection_code, 'OTHER'); assert.equal(p.reviewed_by, admins.boss.id); assert.ok(p.reviewed_at);
  assert.equal(reqStatus(o.reqId), 'Awaiting Payment'); assert.equal(cur(o.id).utr, 'REJ00000RAV1'); assert.equal(cur(o.id).proofId, up.proofId);
  assert.equal(Pay.reviewOf(sid).note, 'Screenshot shows a different payee name.');
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment.reject' AND target_id = ?").get(o.id)); assert.ok(notes(stu.ravi.id).includes('payment_rejected'));
  assert.equal(code(() => rejectIt(admins.second, o)), 'NOT_PENDING', 'cannot reject twice'); assert.equal(Pay.confirmedUtr('REJ00000RAV1'), null);
  const sv = pay.getPayment ? null : null; const view = pay.statusFor(stu.ravi, o.id); assert.equal(view.status, 'REJECTED');
});

test('13/14 concurrent confirmations: exactly one wins; a reference backs only one confirmed payment (database-enforced)', async () => {
  const o = mkOrder(stu.asha.id); pay.submitReference(stu.asha, o.id, sub({ utr: 'RACE0000AAA1' })); const sid = cur(o.id).id;
  const results = await Promise.allSettled([1, 2, 3, 4].map((i) => Promise.resolve().then(() => rev.confirm(i % 2 ? admins.boss : admins.second, o.id, { submissionId: sid, acknowledgements: ACK }))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); assert.deepEqual([...new Set(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code))], ['ALREADY_VERIFIED']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM priority_payment_reviews WHERE payment_id = ?").get(o.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payment.verify' AND target_id = ?").get(o.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM priority_request_history WHERE request_id = ? AND to_status = 'Payment Verified'").get(o.reqId).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE student_id = ? AND type = 'payment_verified' AND title = 'Payment verified'").get(stu.asha.id).n >= 1, true);
  // concurrent confirm vs reject
  const o2 = mkOrder(stu.ravi.id); pay.submitReference(stu.ravi, o2.id, sub({ utr: 'RACE0000RAV1' })); const s2 = cur(o2.id).id;
  const mixed = await Promise.allSettled([Promise.resolve().then(() => rev.confirm(admins.boss, o2.id, { submissionId: s2, acknowledgements: ACK })), Promise.resolve().then(() => rev.reject(admins.second, o2.id, { submissionId: s2, reason: 'TRANSACTION_FAILED' }))]);
  assert.equal(mixed.filter((r) => r.status === 'fulfilled').length, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM priority_payment_reviews WHERE payment_id = ?').get(o2.id).n, 1);
  // the same reference on two payments (inserted past the service rules, as a corrupted/legacy state would be): the database allows only one confirmation
  const x = mkOrder(stu.mira.id); const y = mkOrder(stu.asha.id);
  for (const [p, s, k] of [[x, stu.mira, 'one'], [y, stu.asha, 'two']]) { const ins = Pay.insertSubmission({ paymentId: p.id, studentId: s.id, utr: 'SAME0000UTR1', amountPaise: p.price, paymentDate: today(), paymentTime: '09:00', upiApp: null, note: k, proofId: null });
    Pay.markSubmitted(p.id, `ELV-PAY-X-${k}`, ins.submittedAt, new Date(Date.now() + 3600000).toISOString()); Pay.moveRequest(p.reqId, 'Awaiting Payment', 'Payment Pending', 't', 'student'); }
  decide(admins.boss, x); assert.equal(code(() => decide(admins.second, y)), 'DUPLICATE_CONFIRMED_UTR'); assert.equal(payRow(y.id).status, 'PENDING_VERIFICATION'); assert.equal(reqStatus(y.reqId), 'Payment Pending', 'the failed confirmation rolled back completely');
  assert.throws(() => Pay.insertConfirmedUtr({ utr: 'SAME0000UTR1', paymentId: y.id, submissionId: cur(y.id).id, adminId: 'x' }), (e) => Pay.isConstraint(e));
  assert.throws(() => db.prepare("UPDATE confirmed_payment_utrs SET utr = 'Z' WHERE utr = 'SAME0000UTR1'").run(), /append-only/); assert.throws(() => db.prepare('DELETE FROM confirmed_payment_utrs').run(), /append-only/);
  assert.equal(rev.detail(admins.boss, y.id).duplicates.confirmedElsewhere, true);
});

test('15 audited resubmission: linked revision, reason required, originals and decisions preserved, admins notified, limits enforced', () => {
  const o = mkOrder(stu.asha.id); const up = pay.uploadProof(stu.asha, o.id, PNG); pay.submitReference(stu.asha, o.id, sub({ utr: 'REV00000AAA1', proofId: up.proofId }));
  const first = cur(o.id); const rbody = (over = {}) => sub({ utr: 'REV00000AAA2', reason: 'I mistyped the reference earlier.', ...over });
  assert.equal(code(() => pay.resubmitReference(stu.asha, o.id, rbody())), 'NOT_REJECTED', 'only a rejected payment can be corrected');
  rejectIt(admins.boss, o, 'INVALID_REFERENCE');
  assert.equal(code(() => pay.submitReference(stu.asha, o.id, sub({ utr: 'REV00000AAA2' }))), 'USE_RESUBMISSION');
  assert.ok(fields(() => pay.resubmitReference(stu.asha, o.id, rbody({ reason: '' }))).reason); assert.ok(fields(() => pay.resubmitReference(stu.asha, o.id, rbody({ reason: 'short' }))).reason);
  assert.equal(code(() => pay.resubmitReference(stu.ravi, o.id, rbody())), 'PAYMENT_NOT_FOUND'); assert.equal(code(() => pay.resubmitReference(stu.asha, o.id, rbody({ utr: 'REV00000AAA1' }))), 'VALIDATION', 'the rejected reference itself is not accepted again');
  assert.equal(code(() => pay.resubmitReference(stu.asha, o.id, rbody({ amountPaise: 5 }))), 'PAYMENT_AMOUNT_MISMATCH');
  const r = pay.resubmitReference(stu.asha, o.id, rbody()); assert.equal(r.revision, 2);
  const subs = Pay.submissionsFor(o.id); assert.equal(subs.length, 2);
  assert.equal(subs[0].utr, 'REV00000AAA1'); assert.equal(subs[0].proofId, up.proofId); assert.equal(subs[1].utr, 'REV00000AAA2'); assert.equal(subs[1].previousSubmissionId, first.id); assert.equal(subs[1].replacementReason, 'I mistyped the reference earlier.'); assert.ok(subs[1].submittedAt);
  assert.equal(Pay.reviewOf(first.id).decision, 'REJECTED', 'the earlier decision is untouched');
  assert.equal(payRow(o.id).status, 'PENDING_VERIFICATION'); assert.equal(reqStatus(o.reqId), 'Payment Pending'); assert.equal(payRow(o.id).rejection_code, null);
  assert.ok(Pay.eventsFor(o.id).some((e) => e.event === 'resubmitted')); assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'payment.resubmit' AND target_id = ?").get(o.id));
  assert.ok(notes(admins.boss.id).includes('payment_resubmitted_admin')); assert.ok(notes(stu.asha.id).includes('payment_resubmitted'));
  assert.equal(rev.detail(admins.boss, o.id).previousAttempts.length, 1);
  assert.equal(code(() => rev.confirm(admins.boss, o.id, { submissionId: first.id, acknowledgements: ACK })), 'STALE_SUBMISSION', 'an admin who reviewed the old revision cannot confirm the new one');
  assert.throws(() => db.prepare("UPDATE priority_payment_submissions SET utr = 'CHANGED00000' WHERE id = ?").run(first.id), /append-only/); assert.throws(() => db.prepare('DELETE FROM priority_payment_submissions WHERE id = ?').run(first.id), /append-only/);
  assert.throws(() => db.prepare('UPDATE priority_payment_reviews SET decision = ? WHERE submission_id = ?').run('VERIFIED', first.id), /append-only/);
  // revision limit
  rejectIt(admins.boss, o, 'INSUFFICIENT_EVIDENCE'); pay.resubmitReference(stu.asha, o.id, rbody({ utr: 'REV00000AAA2' })); // same reference is fine when the problem was the evidence
  rejectIt(admins.boss, o, 'TRANSACTION_FAILED'); assert.equal(code(() => pay.resubmitReference(stu.asha, o.id, rbody({ utr: 'REV00000AAA3' }))), 'RESUBMISSION_LIMIT');
  assert.equal(pay.statusFor(stu.asha, o.id).status, 'REJECTED');
});

test('16 a verified payment cannot be changed, resubmitted, re-decided or reverted', () => {
  const o = mkOrder(stu.mira.id); pay.submitReference(stu.mira, o.id, sub({ utr: 'LOCK0000MIR1' })); decide(admins.boss, o);
  assert.equal(code(() => pay.resubmitReference(stu.mira, o.id, sub({ utr: 'LOCK0000MIR2', reason: 'trying to swap the reference' }))), 'PAYMENT_VERIFIED');
  assert.equal(code(() => pay.submitReference(stu.mira, o.id, sub({ utr: 'LOCK0000MIR3' }))), 'ALREADY_SUBMITTED');
  assert.equal(code(() => rev.confirm(admins.second, o.id, { submissionId: cur(o.id).id, acknowledgements: ACK })), 'ALREADY_VERIFIED');
  assert.equal(code(() => rev.reject(admins.second, o.id, { submissionId: cur(o.id).id, reason: 'TRANSACTION_FAILED' })), 'ALREADY_VERIFIED');
  assert.throws(() => db.prepare("UPDATE priority_payments SET status = 'REJECTED' WHERE id = ?").run(o.id), /cannot be changed back/);
  assert.throws(() => db.prepare("UPDATE priority_payments SET status = 'AWAITING_PAYMENT' WHERE id = ?").run(o.id), /cannot be changed back/);
  assert.throws(() => db.prepare('UPDATE priority_payments SET expected_paise = 100 WHERE id = ?').run(o.id), /cannot be changed/); assert.throws(() => db.prepare("UPDATE priority_payments SET student_id = ? WHERE id = ?").run(stu.asha.id, o.id), /cannot be changed/);
  assert.throws(() => Pay.insertSubmission({ paymentId: o.id, studentId: stu.mira.id, utr: 'LOCK0000MIR9', amountPaise: o.price, paymentDate: today(), paymentTime: '09:00', upiApp: null, note: null, proofId: null, revision: 2, previousSubmissionId: cur(o.id).id, replacementReason: 'x'.repeat(12) }), /verified payment/);
  assert.equal(payRow(o.id).status, 'VERIFIED'); assert.equal(Pay.submissionsFor(o.id).length, 1);
});

test('17/18 status history, audit trail and notification events', () => {
  const o = mkOrder(stu.ravi.id); pay.submitReference(stu.ravi, o.id, sub({ utr: 'HIST0000RAV1' })); rejectIt(admins.boss, o, 'INCORRECT_AMOUNT'); pay.resubmitReference(stu.ravi, o.id, sub({ utr: 'HIST0000RAV2', reason: 'Corrected after checking the app' })); decide(admins.second, o);
  const h = rev.history(o.id);
  assert.deepEqual(h.events.filter((e) => e.to).map((e) => e.to), ['PENDING_VERIFICATION', 'REJECTED', 'PENDING_VERIFICATION', 'VERIFIED']);
  assert.deepEqual(h.reviews.map((r) => r.decision), ['REJECTED', 'VERIFIED']); assert.equal(h.reviews[1].adminName, 'Second Admin'); assert.equal(h.submissions.length, 2);
  assert.ok(h.audit.some((a) => a.action === 'payment.verify') && h.audit.some((a) => a.action === 'payment.reject') && h.audit.some((a) => a.action === 'payment.resubmit'));
  assert.deepEqual(db.prepare('SELECT to_status FROM priority_request_history WHERE request_id = ? ORDER BY id').all(o.reqId).map((r) => r.to_status), ['Payment Pending', 'Awaiting Payment', 'Payment Pending', 'Payment Verified']);
  assert.throws(() => db.prepare('DELETE FROM audit_logs').run()); assert.throws(() => db.prepare('UPDATE priority_payment_events SET note = 1').run(), /append-only/);
  const ts = notes(stu.ravi.id); for (const t of ['payment_submitted', 'payment_rejected', 'payment_resubmitted', 'payment_verified']) assert.ok(ts.includes(t), t);
  const before = db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n; assert.equal(code(() => decide(admins.boss, o)), 'ALREADY_VERIFIED'); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, before, 'a refused repeat sends nothing');
  const body = db.prepare("SELECT message FROM notifications WHERE type = 'payment_verified' AND student_id = ?").get(stu.ravi.id).message; assert.equal(/certificate is issued only after/.test(body), true);
  assert.equal(code(() => rev.history('PAY-NOPE00000000')), 'PAYMENT_NOT_FOUND');
});

test('19/20 Stage 10A rules intact: payment statuses not admin-settable, only listed transitions, certificate issue stays gated', () => {
  assert.deepEqual(Object.keys(prio.ADMIN_TRANSITIONS).sort(), ['Approved for Issuance', 'Correction Required', 'Draft', 'Eligibility Check', 'Payment Verified', 'Under Review']);
  assert.deepEqual(prio.ADMIN_TRANSITIONS['Under Review'], ['Approved for Issuance', 'Correction Required', 'Rejected', 'Cancelled']);
  for (const s of ['Awaiting Payment', 'Payment Pending', 'Refunded']) { const o = mkOrder(stu.mira.id); assert.equal(code(() => prio.changeStatus(admins.boss, o.reqId, { to: s })), 'PAYMENT_STAGE_NOT_AVAILABLE'); }
  const src = fs.readFileSync(new URL('../src/services/paymentReview.js', import.meta.url), 'utf8');
  assert.equal(/issueGenerated|issuance|documents\//.test(src.replace(/\/\/.*$/gm, '')), false, 'the review service never touches document issuance');
  assert.ok(audit.AUDIT_ACTIONS.includes('payment.verify'));
});
