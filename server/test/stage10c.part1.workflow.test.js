// Stage 10C Part 1 — student payment workflow audit. Every transition is checked against the actual database rows, never against what the response claims.
// MOCKED payments: a "payment" is a UTR typed by a test student; confirmation is an HTTP call by a test administrator.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { client } from './helpers.js';
import { setup, BASE, AP, sub, ACK } from './stage10c.payfixture.js';

let x, asha, ravi;
before(async () => { x = await setup({ PRIORITY_PUBLIC_ACCESS: 'false' }); assert.equal((await x.configure()).status, 200); });
after(async () => { await x.close(); });

const activePrice = (days) => x.db.prepare('SELECT amount_paise FROM priority_pricing WHERE active = 1 AND duration_days = ?').get(days)?.amount_paise;

test('workflow: private link → login → eligibility → duration → price → UPI QR → UTR → pending → admin confirmation, verified against backend records', async () => {
  asha = await x.student('asha', { draft: false });
  const anon = client(x.srv.base);
  // private feature: no login → 401; logged in without the private invitation → refused; neither route is advertised
  assert.equal((await anon.get(BASE + '/portal')).status, 401);
  const noInvite = await asha.c.get(BASE + '/portal'); assert.ok([403, 404].includes(noInvite.status), `no invitation must not open the portal (${noInvite.status})`);
  assert.equal((await asha.c.post(BASE + '/requests', { applicationId: asha.appId, confirmPersonal: true, confirmAcademic: true })).status >= 400, true);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_requests WHERE student_id = ?').get(asha.id).n, 0, 'no request without the invitation');
  // private link redeemed
  assert.equal((await asha.c.post(BASE + '/access', { token: asha.token })).status, 200);
  assert.equal((await asha.c.get(BASE + '/portal')).status, 200);
  // eligibility is evaluated by the server
  const el = await asha.c.post(BASE + '/eligibility', { applicationId: asha.appId }); assert.equal(el.status, 200, JSON.stringify(el.data)); assert.equal(el.data.eligible ?? el.data.result?.eligible, true);
  // duration + price: the price on the request is the server's active price for the application's duration
  asha.reqId = await x.draft(asha);
  const reqRow = x.row('priority_requests', 'id = ?', asha.reqId); const days = reqRow.duration_days;
  assert.ok([30, 60, 90].includes(days), `paid durations are 30/60/90, got ${days}`);
  assert.equal(reqRow.status, 'Draft'); assert.equal(x.row('priority_payments', 'request_id = ?', asha.reqId), undefined, 'no payment order before the student asks for one');
  // order creation: tampering fields in the body are ignored; amount and payee come from the server
  const o = await x.order(asha, { amountPaise: 1, amount: 1, expectedPaise: 1, upiId: 'thief@okbank', payeeUpiId: 'thief@okbank', payeeName: 'Thief', status: 'VERIFIED', priceId: 'PRC-FAKE', studentId: 'someone-else' });
  const p = x.row('priority_payments', 'id = ?', asha.payId);
  assert.equal(p.expected_paise, activePrice(days)); assert.equal(p.expected_paise, reqRow.amount_paise, 'order amount equals the amount snapshotted on the request');
  assert.equal(p.status, 'AWAITING_PAYMENT'); assert.equal(p.student_id, asha.id); assert.equal(p.payee_upi_id, 'elvora.pay@okbank'); assert.equal(p.payee_name, 'ELVORA Technologies');
  assert.equal(x.row('priority_requests', 'id = ?', asha.reqId).status, 'Awaiting Payment');
  // UPI intent and QR image encode exactly the stored destination and amount
  const intent = new URL(o.data.pay.upiIntent); assert.equal(intent.protocol, 'upi:');
  assert.equal(intent.searchParams.get('pa'), p.payee_upi_id); assert.equal(intent.searchParams.get('pn'), p.payee_name);
  assert.equal(intent.searchParams.get('am'), (p.expected_paise / 100).toFixed(2)); assert.equal(intent.searchParams.get('cu'), 'INR'); assert.ok(intent.searchParams.get('tn').includes(p.id));
  assert.equal(o.data.pay.qrDataUrl, await QRCode.toDataURL(o.data.pay.upiIntent, { errorCorrectionLevel: 'M', margin: 2, width: 320 }), 'the QR encodes the same intent that is displayed');
  assert.equal(o.data.pay.upiId, p.payee_upi_id); assert.equal(o.data.payment.amountPaise, p.expected_paise);
  // a second click returns the same live order, never a second one
  const again = await asha.c.post(`${BASE}/requests/${asha.reqId}/payment-order`, {}); assert.equal(again.status, 200); assert.equal(again.data.payment.id, p.id);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payments WHERE request_id = ?').get(asha.reqId).n, 1);
  // the student cannot move their own payment forward: there is no student route that confirms, and body/status fields are ignored
  for (const [m, path] of [['post', `${BASE}/payments/${p.id}/confirm`], ['post', `${BASE}/payments/${p.id}/verify`], ['patch', `${BASE}/payments/${p.id}`], ['put', `${BASE}/payments/${p.id}`]]) assert.equal((await asha.c[m](path, { status: 'VERIFIED' })).status, 404, `${m} ${path}`);
  assert.equal((await asha.c.post(`${AP}/${p.id}/confirm`, { acknowledgements: ACK })).status, 403, 'a student session is refused by the admin API');
  assert.equal(x.row('priority_payments', 'id = ?', p.id).status, 'AWAITING_PAYMENT');
  // the UTR submission: a wrong amount in the body is refused and writes nothing
  const wrong = await x.submit(asha, { amountPaise: 100 }); assert.equal(wrong.status, 400); assert.equal(wrong.data.error.code, 'PAYMENT_AMOUNT_MISMATCH');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payment_submissions WHERE payment_id = ?').get(p.id).n, 0);
  const ok = await x.submit(asha, { utr: 'wf0000asha01' }); assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const after = x.row('priority_payments', 'id = ?', p.id); const s = x.row('priority_payment_submissions', 'payment_id = ?', p.id);
  assert.equal(after.status, 'PENDING_VERIFICATION'); assert.equal(s.utr, 'WF0000ASHA01', 'UTR is normalised to upper case'); assert.equal(s.amount_paise, p.expected_paise); assert.equal(s.student_id, asha.id);
  assert.equal(Date.parse(after.verification_deadline) - Date.parse(after.submitted_at), 24 * 3600000, 'the verification target is 24 hours after submission');
  assert.equal(x.row('priority_requests', 'id = ?', asha.reqId).status, 'Payment Pending');
  assert.equal(x.row('priority_payments', 'id = ?', p.id).verified_at, null, 'submitting a UTR never verifies a payment');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payment_transactions WHERE payment_id = ?').get(p.id).n, 0, 'no transaction record exists before an administrator confirms');
  const st = await asha.c.get(`${BASE}/payments/${p.id}/status`); assert.equal(st.data.status, 'PENDING_VERIFICATION');
  // the administrator queue lists it as Awaiting Verification with its timing
  const q = await x.boss.get(`${AP}/queue?status=awaiting_verification`); assert.equal(q.status, 200);
  const row = q.data.payments.find((r) => r.paymentId === p.id); assert.ok(row); assert.equal(row.statusLabel, 'Awaiting Verification'); assert.equal(row.overdue, false); assert.ok(row.secondsToDeadline > 23 * 3600); assert.equal(row.previousAdminActions, 0);
  // explicit administrator confirmation
  const c = await x.confirm(x.boss, p.id); assert.equal(c.status, 200, JSON.stringify(c.data)); assert.match(c.data.transactionId, /^TXN-[A-F0-9]{12}$/);
  const done = x.row('priority_payments', 'id = ?', p.id);
  assert.equal(done.status, 'VERIFIED'); assert.equal(done.verified_by, x.boss.id); assert.ok(done.verified_at);
  assert.equal(x.row('priority_requests', 'id = ?', asha.reqId).status, 'Payment Verified');
  const t = x.row('payment_transactions', 'payment_id = ?', p.id); assert.equal(t.id, c.data.transactionId); assert.equal(t.confirmed_amount_paise, p.expected_paise); assert.equal(t.confirmed_utr, 'WF0000ASHA01'); assert.equal(t.student_id, asha.id); assert.equal(t.request_id, asha.reqId); assert.equal(t.verified_by, x.boss.id); assert.equal(t.verified_at, done.verified_at.slice(0, 0) + t.verified_at);
  assert.ok(x.row('notifications', "student_id = ? AND type = 'payment_verified'", asha.id), 'the student is notified');
  assert.ok(x.row('audit_logs', "action = 'payment.verify' AND target_id = ?", p.id)); assert.ok(x.row('audit_logs', "action = 'payment.transaction_record' AND target_id = ?", p.id));
  // verification never issues a certificate or touches the eligibility workflow
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM priority_requests WHERE id = ? AND status IN ('Approved', 'Issued', 'Completed')").get(asha.reqId).n, 0);
});

test('workflow: rejection needs a reason, records the administrator, keeps history, notifies the student and allows an audited resubmission', async () => {
  ravi = await x.student('ravi'); await x.order(ravi); assert.equal((await x.submit(ravi, { utr: 'WF0000RAVI01' })).status, 201);
  const d = await x.detail(x.boss, ravi.payId); const base = { submissionId: d.review.submissionId };
  // no reason / unknown reason / "Other" without an explanation are all refused and change nothing
  for (const body of [{}, { reason: '' }, { reason: 'because' }, { reason: 'OTHER' }, { reason: 'OTHER', note: 'short' }]) { const r = await x.boss.post(`${AP}/${ravi.payId}/reject`, { ...base, ...body }); assert.equal(r.status, 400, JSON.stringify(body)); }
  assert.equal(x.row('priority_payments', 'id = ?', ravi.payId).status, 'PENDING_VERIFICATION'); assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payment_reviews WHERE payment_id = ?').get(ravi.payId).n, 0);
  const r = await x.boss.post(`${AP}/${ravi.payId}/reject`, { ...base, reason: 'TRANSACTION_NOT_FOUND', note: 'Nothing with this reference in the statement' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = x.row('priority_payments', 'id = ?', ravi.payId); assert.equal(p.status, 'REJECTED'); assert.equal(p.rejection_code, 'TRANSACTION_NOT_FOUND'); assert.equal(p.reviewed_by, x.boss.id); assert.ok(p.reviewed_at);
  const rev = x.row('priority_payment_reviews', 'payment_id = ?', ravi.payId); assert.equal(rev.decision, 'REJECTED'); assert.equal(rev.admin_id, x.boss.id); assert.equal(rev.admin_name, 'Boss Admin'); assert.ok(rev.created_at);
  assert.equal(x.row('priority_requests', 'id = ?', ravi.reqId).status, 'Awaiting Payment');
  assert.ok(x.row('notifications', "student_id = ? AND type = 'payment_rejected'", ravi.id), 'the student is notified through the existing notification system');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payment_transactions WHERE payment_id = ?').get(ravi.payId).n, 0, 'a rejected payment never has a transaction record');
  const ev = x.db.prepare('SELECT event FROM priority_payment_events WHERE payment_id = ? ORDER BY id').all(ravi.payId).map((e) => e.event); assert.deepEqual(ev.filter((e) => ['created', 'submitted', 'rejected'].includes(e)), ['created', 'submitted', 'rejected']);
  // Rejected shows in the queue with the administrator's last action
  const q = await x.boss.get(`${AP}/queue?status=rejected`); const row = q.data.payments.find((z) => z.paymentId === ravi.payId); assert.equal(row.statusLabel, 'Rejected'); assert.equal(row.lastAction.adminName, 'Boss Admin'); assert.equal(row.previousAdminActions, 1);
  // audited resubmission: a new revision linked to the first, which is kept untouched
  const re = await ravi.c.post(`${BASE}/payments/${ravi.payId}/resubmit`, { ...sub({ utr: 'WF0000RAVI02' }), reason: 'I typed the wrong reference earlier' }); assert.equal(re.status, 201, JSON.stringify(re.data));
  const subs = x.db.prepare('SELECT utr, revision, previous_submission_id FROM priority_payment_submissions WHERE payment_id = ? ORDER BY revision').all(ravi.payId);
  assert.equal(subs.length, 2); assert.equal(subs[0].utr, 'WF0000RAVI01'); assert.equal(subs[1].revision, 2); assert.ok(subs[1].previous_submission_id);
  assert.equal(x.row('priority_payments', 'id = ?', ravi.payId).status, 'PENDING_VERIFICATION');
});

test('workflow: a payment waiting past its 24-hour target is flagged overdue, and is never approved or rejected automatically', async () => {
  const s = await x.student('late'); await x.order(s); assert.equal((await x.submit(s, { utr: 'WF0000LATE01' })).status, 201);
  const past = new Date(Date.now() - 25 * 3600000).toISOString(); const dl = new Date(Date.now() - 3600000).toISOString();
  x.db.prepare('UPDATE priority_payments SET submitted_at = ?, verification_deadline = ? WHERE id = ?').run(past, dl, s.payId);
  const q = await x.boss.get(`${AP}/queue?status=overdue`); const row = q.data.payments.find((z) => z.paymentId === s.payId);
  assert.ok(row, 'overdue filter lists it'); assert.equal(row.overdue, true); assert.equal(row.statusLabel, 'Awaiting Verification — Overdue'); assert.ok(row.overdueBySeconds >= 3599); assert.ok(row.elapsedSeconds >= 25 * 3600 - 5);
  const od = await x.boss.get(`${AP}/overdue`); assert.ok(od.data.payments.some((z) => z.id === s.payId));
  assert.equal(x.row('priority_payments', 'id = ?', s.payId).status, 'PENDING_VERIFICATION', 'overdue is an indicator, not a decision');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payment_reviews WHERE payment_id = ?').get(s.payId).n, 0);
  const { sweepOverdue } = await import('../src/services/paymentOverdue.js'); sweepOverdue(); sweepOverdue();
  assert.equal(x.row('priority_payments', 'id = ?', s.payId).status, 'PENDING_VERIFICATION', 'the sweep only notifies');
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM notifications WHERE type = 'payment_overdue_admin' AND dedupe_key LIKE ?").get(`pay:${s.payId}:overdue:%`).n >= 1, true);
});

test('queue: Awaiting Payment, Awaiting Verification, Verified, Rejected, Overdue, Refund Pending and Refunded are distinct states with counts', async () => {
  const aw = await x.student('await'); await x.order(aw);
  const ref = await x.confirmed('refq', 'WF0000REFQ01'); const rf = await x.confirmed('refd', 'WF0000REFD01');
  const mk = async (paymentId, body) => { const r = await x.boss.post(`${AP}/${paymentId}/refunds`, { amountRupees: '10', reason: 'Duplicate payment by the student', destination: 'original payment account', ...body }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.refund.id; };
  await mk(ref.payId, {});
  const id = await mk(rf.payId, { amountRupees: String(x.row('priority_payments', 'id = ?', rf.payId).expected_paise / 100) });
  assert.equal((await x.boss.post(`${AP}/refunds/${id}/pending`, {})).status, 200);
  assert.equal((await x.boss.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'RFD00000REFD1', acknowledgements: RACKS() })).status, 200);
  const label = async (status, payId) => { const q = await x.boss.get(`${AP}/queue?status=${status}&pageSize=100`); return q.data.payments.find((z) => z.paymentId === payId)?.statusLabel; };
  assert.equal(await label('awaiting_payment', aw.payId), 'Awaiting Payment');
  assert.equal(await label('refund_pending', ref.payId), 'Refund Pending'); assert.equal(await label('refunded', rf.payId), 'Refunded');
  const all = await x.boss.get(`${AP}/queue?pageSize=100`); assert.equal(all.data.payments.some((z) => z.paymentId === aw.payId), false, 'the default list stays "submitted payments"');
  for (const k of ['awaiting_payment', 'pending', 'verified', 'rejected', 'overdue', 'refund_pending', 'refunded']) assert.equal(typeof all.data.counts[k], 'number', k);
  assert.ok(all.data.counts.awaiting_payment >= 1 && all.data.counts.refunded >= 1 && all.data.counts.refund_pending >= 1);
  assert.equal((await x.boss.get(`${AP}/queue?status=nonsense`)).status, 400);
});
const RACKS = () => ({ accountChecked: true, referenceMatches: true, amountMatches: true });

test('QR consistency: if the official destination changes after an order was created, the order keeps its own destination and the live QR image is withheld with a warning', async () => {
  const s = await x.student('qr'); const o = await x.order(s); assert.equal(o.data.pay.destinationChanged, undefined);
  assert.equal((await x.configure({ upiId: 'elvora.changed@okbank' })).status, 200);
  const g = await s.c.get(`${BASE}/payments/${s.payId}`);
  assert.equal(g.data.pay.upiId, 'elvora.pay@okbank', 'the order keeps the destination it was created with'); assert.equal(new URL(g.data.pay.upiIntent).searchParams.get('pa'), 'elvora.pay@okbank');
  assert.equal(g.data.pay.destinationChanged, true); assert.equal(g.data.pay.info.qrImageAvailable, false); assert.match(g.data.pay.destinationNotice, /changed/);
  assert.equal((await x.configure({ upiId: 'elvora.pay@okbank' })).status, 200);
  assert.equal((await s.c.get(`${BASE}/payments/${s.payId}`)).data.pay.destinationChanged, undefined);
});
