// Stage 10C Part 1 — financial record audit: one transaction record per confirmed payment, exact reporting figures, free-correction exclusion, migration backfill and the admin-only CSV export.
// MOCKED payments only: nothing here proves real money moved; the figures are the test administrators' own confirmations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client } from './helpers.js';
import { setup, BASE, AP, RACK, sub } from './stage10c.payfixture.js';

let x, reporter, reviewer, s = {};
const PRICE = 4900; // the seeded 30-day price, in paise; every test student below applies to the same 30-day internship
const AC = '/admin/priority-certificates';
const refund = async (pay, rupees, reason = 'Duplicate payment by the student') => { const r = await x.boss.post(`${AP}/${pay}/refunds`, { amountRupees: rupees, reason, destination: 'original payment account' }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.refund.id; };
const approve = async (id) => assert.equal((await x.boss.post(`${AP}/refunds/${id}/pending`, {})).status, 200);
const complete = async (id, utr) => assert.equal((await x.boss.post(`${AP}/refunds/${id}/complete`, { refundUtr: utr, acknowledgements: RACK })).status, 200);

before(async () => {
  x = await setup(); assert.equal((await x.configure()).status, 200);
  reporter = await x.makeAdmin('reporter@example.com', 'Report Only', ['payment.report']); reviewer = await x.makeAdmin('reviewer@example.com', 'Review Only', ['payment.review']);
  s.one = await x.confirmed('one', 'FIN000000001'); s.two = await x.confirmed('two', 'FIN000000002'); s.three = await x.confirmed('three', 'FIN000000003');
  s.pending = await x.student('pend'); await x.order(s.pending); await x.submit(s.pending, { utr: 'FIN000000004' });
  s.rejected = await x.student('rej'); await x.order(s.rejected); await x.submit(s.rejected, { utr: 'FIN000000005' }); assert.equal((await x.reject(x.boss, s.rejected.payId, { reason: 'TRANSACTION_FAILED' })).status, 200);
  s.awaiting = await x.student('await'); await x.order(s.awaiting);
  await approve(await refund(s.two.payId, String(PRICE / 100))); // placeholder replaced below; keeps ids deterministic
});
after(async () => { await x.close(); });

test('every confirmed payment has exactly one unique internal transaction record with the required fields; nothing else does', async () => {
  const confirmed = [s.one, s.two, s.three];
  const ids = new Set();
  for (const st of confirmed) {
    const p = x.row('priority_payments', 'id = ?', st.payId); const sb = x.row('priority_payment_submissions', 'payment_id = ?', st.payId); const t = x.row('payment_transactions', 'payment_id = ?', st.payId); assert.ok(t, 'transaction record exists');
    assert.match(t.id, /^TXN-[A-F0-9]{12}$/); ids.add(t.id);
    assert.equal(t.student_id, st.id); assert.equal(t.request_id, st.reqId); assert.equal(t.payment_id, st.payId); assert.equal(t.confirmed_amount_paise, PRICE); assert.equal(t.confirmed_utr, sb.utr); assert.equal(t.submission_id, sb.id);
    assert.equal(t.verified_by, x.boss.id); assert.equal(t.verified_by_name, 'Boss Admin'); assert.equal(t.verified_at, p.verified_at); assert.equal(t.currency, 'INR');
  }
  assert.equal(ids.size, 3, 'transaction ids are unique');
  for (const st of [s.pending, s.rejected, s.awaiting]) assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payment_transactions WHERE payment_id = ?').get(st.payId).n, 0, 'pending, rejected and unpaid orders have no transaction record');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payment_transactions').get().n, 3);
  assert.deepEqual(Object.values(x.payDb.financialIntegrity()), Object.values(x.payDb.financialIntegrity()).map(() => 0), 'integrity checks are all clean');
  const one = await x.detail(x.boss, s.one.payId); assert.equal(one.transaction.id, x.row('payment_transactions', 'payment_id = ?', s.one.payId).id);
});

test('14. financial calculations: gross receipts, pending, rejected, refund-pending, completed refunds and Net Collections = Gross − Completed Refunds', async () => {
  // s.two: the whole payment refunded (completed). s.three: one partial refund completed, one requested, one approved.
  const [two] = x.db.prepare("SELECT id FROM payment_refunds WHERE payment_id = ?").all(s.two.payId).map((r) => r.id); await complete(two, 'FINREF000001');
  const a = await refund(s.three.payId, '10'); await approve(a); await complete(a, 'FINREF000002'); await refund(s.three.payId, '5'); await approve(await refund(s.three.payId, '7'));
  const r = await reporter.get(`${AP}/reports/summary`); assert.equal(r.status, 200, JSON.stringify(r.data)); const d = r.data;
  assert.equal(d.confirmedGrossReceipts.amount.paise, 3 * PRICE); assert.equal(d.confirmedGrossReceipts.count, 3);
  assert.equal(d.completedRefunds.amount.paise, PRICE + 1000); assert.equal(d.completedRefunds.count, 2);
  assert.equal(d.netCollections.amount.paise, 3 * PRICE - (PRICE + 1000)); assert.equal(d.netCollections.amount.paise, d.confirmedGrossReceipts.amount.paise - d.completedRefunds.amount.paise);
  assert.equal(d.refundPending.requested.paise, 500); assert.equal(d.refundPending.approved.paise, 700); assert.equal(d.refundPending.amount.paise, 1200); assert.equal(d.refundPending.count, 2);
  assert.equal(d.pending.count, 1); assert.equal(d.pending.amount.paise, PRICE); assert.equal(d.pending.overdue, 0);
  assert.equal(d.rejected.decisions, 1); assert.equal(d.rejected.paymentsCurrentlyRejected, 1); assert.equal(d.rejected.amount.paise, PRICE);
  assert.equal(d.awaitingPayment.count, 1); assert.equal(d.awaitingPayment.amount.paise, PRICE);
  assert.equal(d.submissions.total, 5); assert.equal(d.submissions.payments, 5);
  assert.equal(d.netCollections.amount.display, '₹88'); assert.equal(d.integrity.ok, true); assert.match(d.notice, /not proof of payment/);
  // the figures are recomputed from the database, not from the summary: cross-check independently
  const gross = x.db.prepare('SELECT SUM(confirmed_amount_paise) n FROM payment_transactions').get().n; const done = x.db.prepare("SELECT SUM(amount_paise) n FROM payment_refunds WHERE status = 'REFUNDED'").get().n; assert.equal(d.netCollections.amount.paise, gross - done);
  // pending, rejected and unpaid money never counts: confirming nothing changes nothing, and a rejected payment cannot become revenue
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM payment_transactions t JOIN priority_payments p ON p.id = t.payment_id WHERE p.status IN ('PENDING_VERIFICATION', 'REJECTED', 'AWAITING_PAYMENT', 'EXPIRED')").get().n, 0);
  // a requested refund is not deducted until the transfer is recorded
  assert.equal(d.completedRefunds.amount.paise, 5900);
  // date filters
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10); const today = new Date().toISOString().slice(0, 10);
  assert.equal((await reporter.get(`${AP}/reports/summary?from=${tomorrow}`)).data.confirmedGrossReceipts.amount.paise, 0);
  assert.equal((await reporter.get(`${AP}/reports/summary?from=${today}&to=${tomorrow}`)).data.confirmedGrossReceipts.amount.paise, 3 * PRICE);
  for (const q of ['from=2026-13-40', 'to=yesterday', `from=${tomorrow}&to=${today}`]) assert.equal((await reporter.get(`${AP}/reports/summary?${q}`)).status, 400, q);
  assert.ok(x.row('audit_logs', "action = 'payment.report_view' AND admin_id = ?", reporter.id), 'report views are audited');
});

test('15. free administrative corrections never appear as paid transactions, revenue or payments', async () => {
  // verification does not issue anything: take the verified request through the normal review and issuance steps, then correct the certificate for free
  const st = (to, extra = {}) => x.boss.post(`${AC}/requests/${s.one.reqId}/status`, { to, ...extra });
  assert.equal(x.row('priority_requests', 'id = ?', s.one.reqId).status, 'Payment Verified');
  assert.equal((await x.boss.post(`${AC}/requests/${s.one.reqId}/review`)).data.eligible, true);
  assert.equal((await st('Under Review')).status, 200, 'review');
  assert.equal((await st('Approved for Issuance', { note: 'Completion, tasks and approval verified on the internship record.' })).status, 200);
  const iss = await x.boss.post(`${AC}/requests/${s.one.reqId}/issue`, {}); assert.equal(iss.status, 200, JSON.stringify(iss.data));
  const totalsBefore = JSON.stringify([x.db.prepare('SELECT COUNT(*) n, SUM(confirmed_amount_paise) s FROM payment_transactions').get(), x.db.prepare('SELECT COUNT(*) n FROM priority_payments').get(), x.db.prepare('SELECT COUNT(*) n FROM priority_payment_submissions').get()]);
  const before = (await reporter.get(`${AP}/reports/summary`)).data;
  const c = await x.boss.post(`${AC}/corrections`, { studentId: s.one.id, documentId: iss.data.document.id, category: 'student_name', corrected: { fullName: 'Corrected Name' }, reason: 'Name was misspelled by ELVORA staff.', evidence: 'Government ID on file shows the corrected spelling.', confirm: true, fee: 500, feePaise: 500, amountPaise: 500 });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const row = x.db.prepare('SELECT * FROM free_corrections').get(); assert.equal(row.fee_paise, 0); assert.throws(() => x.db.prepare('UPDATE free_corrections SET fee_paise = 100').run());
  assert.equal(JSON.stringify([x.db.prepare('SELECT COUNT(*) n, SUM(confirmed_amount_paise) s FROM payment_transactions').get(), x.db.prepare('SELECT COUNT(*) n FROM priority_payments').get(), x.db.prepare('SELECT COUNT(*) n FROM priority_payment_submissions').get()]), totalsBefore, 'a correction creates no payment, submission or transaction');
  const after = (await reporter.get(`${AP}/reports/summary`)).data;
  for (const k of ['confirmedGrossReceipts', 'pending', 'awaitingPayment', 'completedRefunds', 'netCollections', 'refundPending']) assert.deepEqual(after[k], before[k], `${k} unchanged by a free correction`);
  assert.equal(after.freeCorrections.count, 1); assert.equal(after.freeCorrections.feesCollected.paise, 0); assert.match(after.freeCorrections.note, /never paid transactions/);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payment_transactions WHERE student_id = ?').get(s.one.id).n, 1, 'only the real payment has a transaction');
  const csv = await reporter.get(`${AP}/reports/transactions.csv`); assert.equal(csv.status, 200);
  assert.equal(x.payDb.financialIntegrity().freeCorrectionsWithFee, 0);
});

test('CSV export: admin-only with date and status filters, contains no private data, is safe against spreadsheet formulas, and is audited', async () => {
  const get = (q = '', who = reporter) => fetch(`${x.srv.base}${AP}/reports/transactions.csv${q}`, { headers: { cookie: who.__c } });
  // log in again to capture a cookie for raw fetches
  const cookie = async (email) => { const r = await fetch(`${x.srv.base}/auth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Str0ng!Pass1' }) }); return (r.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; '); };
  reporter.__c = await cookie('reporter@example.com'); reviewer.__c = await cookie('reviewer@example.com');
  const res = await get(); assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /^text\/csv/); assert.match(res.headers.get('content-disposition'), /^attachment; filename="elvora-transactions-\d{4}-\d{2}-\d{2}\.csv"$/); assert.match(res.headers.get('cache-control'), /no-store/); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const body = (await res.text()).replace(/^\uFEFF/, ''); const lines = body.trim().split('\r\n'); assert.equal(lines[0], 'transaction_id,payment_id,payment_reference,request_id,student_id,duration_days,confirmed_amount_inr,currency,confirmed_utr,verified_at,verified_by_id,verified_by_name,payment_status,refunded_inr,refund_pending_inr,net_inr');
  assert.equal(lines.length, 1 + 3); assert.equal(res.headers.get('x-row-count'), '3');
  const rows = Object.fromEntries(lines.slice(1).map((l) => { const c = l.split(','); return [c[1], c]; }));
  assert.equal(rows[s.two.payId][6], '49.00'); assert.equal(rows[s.two.payId][13], '49.00'); assert.equal(rows[s.two.payId][15], '0.00', 'net of a fully refunded payment');
  assert.equal(rows[s.three.payId][13], '10.00'); assert.equal(rows[s.three.payId][14], '12.00'); assert.equal(rows[s.three.payId][15], '39.00'); assert.equal(rows[s.one.payId][15], '49.00');
  // never private or unnecessary data
  for (const st of [s.one, s.two, s.three, s.pending, s.rejected, s.awaiting]) { assert.equal(body.includes(st.email), false); assert.equal(body.includes(st.name), false); }
  for (const secret of ['elvora.pay@okbank', 'ELVORA Technologies', 'support@elvora.in', 'proof', 'password', 'screenshot', '.png', 'FIN000000004', 'FIN000000005']) assert.equal(body.toLowerCase().includes(secret.toLowerCase()), false, secret);
  for (const unpaid of [s.pending.payId, s.rejected.payId, s.awaiting.payId]) assert.equal(body.includes(unpaid), false, 'only confirmed transactions are exported');
  // filters
  const refunded = (await (await get('?status=refunded')).text()).trim().split('\r\n'); assert.equal(refunded.length - 1, 2); // two payments have a completed refund
  assert.equal((await (await get('?status=refund_pending')).text()).trim().split('\r\n').length - 1, 1);
  assert.equal((await (await get('?status=not_refunded')).text()).trim().split('\r\n').length - 1, 1);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10); assert.equal((await (await get(`?from=${tomorrow}`)).text()).trim().split('\r\n').length, 1, 'a future range exports only the header');
  for (const q of ['?status=hacked', '?from=2026-02-30', `?from=${tomorrow}&to=2020-01-01`]) assert.equal((await get(q)).status, 400, q);
  // permission: review-only admins, students and anonymous callers cannot export
  assert.equal((await get('', reviewer)).status, 403); assert.equal((await fetch(`${x.srv.base}${AP}/reports/transactions.csv`)).status, 401);
  assert.equal((await s.one.c.get(`${AP}/reports/transactions.csv`)).status, 403);
  assert.ok(x.row('audit_logs', "action = 'payment.export' AND admin_id = ?", reporter.id)); assert.match(x.row('audit_logs', "action = 'payment.export' ORDER BY seq DESC").reason, /rows \d/);
  // formula injection and quoting
  const { csvCell } = await import('../src/services/paymentFinancials.js');
  assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`); for (const v of ['+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) assert.ok(csvCell(v).replace(/^"/, '').startsWith("'"), JSON.stringify(v));
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('line\nbreak'), '"line\nbreak"'); assert.equal(csvCell(null), ''); assert.equal(csvCell(49), '49');
  // JSON listing agrees
  const j = await reporter.get(`${AP}/reports/transactions?status=refunded`); assert.equal(j.status, 200); assert.equal(j.data.transactions.length, 2); assert.ok(j.data.transactions.every((t) => !('studentName' in t) && !('email' in t)));
});

test('reports: financial permission matrix, and the transaction table is rebuilt from the confirmed payments by migration 26', async () => {
  for (const [who, want] of [[reporter, 200], [x.boss, 200], [reviewer, 403], [client(x.srv.base), 401], [s.one.c, 403]]) assert.equal((await who.get(`${AP}/reports/summary`)).status, want);
  assert.equal((await x.boss.get(`${AP}/permissions`)).data.permissions.includes('payment.report'), true);
  assert.equal((await reviewer.get(`${AP}/permissions`)).data.permissions.includes('payment.report'), false);
  // migration backfill: put the database back to schema 25 (no transaction table) and migrate again
  const { migrate } = await import('../src/db/index.js'); const before = x.db.prepare('SELECT payment_id, confirmed_amount_paise, confirmed_utr, student_id, request_id, verified_by, verified_at FROM payment_transactions ORDER BY payment_id').all();
  x.db.exec('DROP TABLE payment_transactions'); x.db.pragma('user_version = 25');
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'payment_transactions'").get().n, 0);
  migrate(); assert.equal(x.db.pragma('user_version', { simple: true }) >= 26, true);
  const after = x.db.prepare('SELECT payment_id, confirmed_amount_paise, confirmed_utr, student_id, request_id, verified_by, verified_at FROM payment_transactions ORDER BY payment_id').all();
  assert.deepEqual(after, before, 'existing confirmed payments are backfilled with identical amounts, references and reviewers');
  assert.equal(x.db.prepare('SELECT COUNT(DISTINCT id) n FROM payment_transactions').get().n, 3);
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM payment_transactions t JOIN priority_payments p ON p.id = t.payment_id WHERE p.status NOT IN ('VERIFIED','REFUND_PENDING','REFUNDED')").get().n, 0, 'unverified payments are never backfilled');
  assert.throws(() => x.db.prepare("UPDATE payment_transactions SET confirmed_utr = 'X'").run(), /append-only/, 'the rebuilt table is append-only again');
  assert.equal((await reviewer.get(`${AP}/queue`)).status, 200, 'existing permissions survive the rebuild'); assert.equal(x.db.prepare("SELECT COUNT(*) n FROM admin_permissions WHERE permission = 'payment.review'").get().n, 1);
});
