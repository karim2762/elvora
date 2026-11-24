// Stage 10C Part 1 — payment security audit: pricing, ownership, admin permissions, UTR rules, duplicate/concurrent confirmation, uploads, private proofs, refunds, injection, CSRF.
// MOCKED payments only. Each test checks the DATABASE after the HTTP call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { client } from './helpers.js';
import { setup, BASE, AP, PNG, ACK, RACK, sub } from './stage10c.payfixture.js';

let x, reviewer, refunder, plain, asha, ravi;
before(async () => {
  x = await setup({ ADMIN_API_KEY: 'k'.repeat(40) });
  assert.equal((await x.configure()).status, 200);
  reviewer = await x.makeAdmin('reviewer@example.com', 'Review Only', ['payment.review']);
  refunder = await x.makeAdmin('refunder@example.com', 'Refund Only', ['payment.refund']);
  plain = await x.makeAdmin('plain@example.com', 'Plain Admin');
  asha = await x.student('asha'); ravi = await x.student('ravi'); await x.order(asha); await x.order(ravi);
});
after(async () => { await x.close(); });

test('1. price calculation is server-side: the active price decides every order, a new price version affects only new orders, and the client cannot influence it', async () => {
  const days = x.row('priority_requests', 'id = ?', asha.reqId).duration_days;
  const price = x.db.prepare('SELECT amount_paise FROM priority_pricing WHERE active = 1 AND duration_days = ?').get(days).amount_paise;
  assert.equal(x.row('priority_payments', 'id = ?', asha.payId).expected_paise, price);
  const before = x.db.prepare('SELECT COUNT(*) n FROM priority_pricing_versions').get().n;
  const up = await x.boss.put(`${AP}/pricing`, { prices: [{ durationDays: days, amountRupees: '777' }], confirm: true }); assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_pricing_versions').get().n, before + 1);
  assert.equal(x.row('priority_payments', 'id = ?', asha.payId).expected_paise, price, 'an existing order keeps the price it was created with');
  const neo = await x.student('neo'); await x.order(neo, { amountPaise: 100 });
  assert.equal(x.row('priority_payments', 'id = ?', neo.payId).expected_paise, 77700, 'a new order uses the new active price');
  assert.equal(x.row('priority_payments', 'id = ?', neo.payId).pricing_version, before + 1);
  // students and plain admins cannot change prices; nonsense amounts are refused
  assert.equal((await neo.c.put(`${AP}/pricing`, { prices: [{ durationDays: days, amountRupees: '1' }], confirm: true })).status, 403);
  assert.equal((await plain.put(`${AP}/pricing`, { prices: [{ durationDays: days, amountRupees: '1' }], confirm: true })).status, 403);
  for (const amountRupees of ['0', '-5', '1.234', 'abc', '99999999', '', null, '1e3']) assert.equal((await x.boss.put(`${AP}/pricing`, { prices: [{ durationDays: days, amountRupees }], confirm: true })).status, 400, String(amountRupees));
  assert.equal((await x.boss.put(`${AP}/pricing`, { prices: [{ durationDays: days, amountRupees: '1500' }] })).status, 400, 'a save needs explicit confirmation');
  await x.boss.put(`${AP}/pricing`, { prices: [{ durationDays: days, amountRupees: String(price / 100) }], confirm: true }); // restore
});

test('2. invalid durations are rejected: no 7-day (or any unlisted) paid option can be priced or ordered', async () => {
  const versions = x.db.prepare('SELECT COUNT(*) n FROM priority_pricing_versions').get().n;
  for (const durationDays of [7, 0, -30, 45, 31, 365, '30abc', null, 3.5]) assert.equal((await x.boss.put(`${AP}/pricing`, { prices: [{ durationDays, amountRupees: '100' }], confirm: true })).status, 400, String(durationDays));
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_pricing_versions').get().n, versions, 'a refused change never creates a version');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_pricing WHERE active = 1 AND duration_days NOT IN (30, 60, 90)').get().n, 0);
  assert.equal((await x.boss.put(`${AP}/pricing`, { prices: [] , confirm: true })).status, 400);
  // a 7-day internship cannot be paid for
  const week = await x.student('week', { draft: false, over: { internshipId: 'ELV-WD-002' } });
  const dr = await week.c.post(BASE + '/requests', { applicationId: week.appId, confirmPersonal: true, confirmAcademic: true });
  if (dr.status < 300) { const o = await week.c.post(`${BASE}/requests/${dr.data.request.id}/payment-order`, {}); assert.ok(o.status >= 400, 'no order for a 7-day internship'); assert.ok(['NO_PAID_OPTION', 'PRIORITY_NOT_ELIGIBLE'].includes(o.data.error.code), o.data.error.code); }
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payments WHERE student_id = ?').get(week.id).n, 0);
});

test('3. student ownership: another student’s payment, request, proof and refunds look exactly like missing records, and nothing changes', async () => {
  const snapshot = () => JSON.stringify([x.row('priority_payments', 'id = ?', asha.payId), x.db.prepare('SELECT COUNT(*) n FROM priority_payment_submissions').get(), x.db.prepare('SELECT COUNT(*) n FROM priority_payment_proofs').get()]);
  const before = snapshot(); const missing = await ravi.c.get(`${BASE}/payments/PAY-AAAAAAAAAAAA`);
  for (const [m, p, b] of [['get', `${BASE}/payments/${asha.payId}`], ['get', `${BASE}/payments/${asha.payId}/status`], ['get', `${BASE}/payments/${asha.payId}/refunds`], ['post', `${BASE}/payments/${asha.payId}/submit`, sub({ utr: 'SEC0000STEAL1' })],
    ['post', `${BASE}/payments/${asha.payId}/resubmit`, { ...sub({ utr: 'SEC0000STEAL2' }), reason: 'trying to hijack it' }], ['post', `${BASE}/requests/${asha.reqId}/payment-order`, {}], ['get', `${BASE}/requests/${asha.reqId}`], ['get', `${BASE}/payments/${asha.payId}/proof/PPF-AAAAAAAAAAAAAAAA`]]) {
    const r = await ravi.c[m](p, b); assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`); if (p.includes('/payments/')) assert.deepEqual(r.data.error.code, ['REQUEST_NOT_FOUND', 'PAYMENT_NOT_FOUND', 'PROOF_NOT_FOUND'].includes(r.data.error.code) ? r.data.error.code : 'x');
  }
  const rawUp = await fetch(`${x.srv.base}${BASE}/payments/${asha.payId}/proof`, { method: 'POST', headers: { 'Content-Type': 'image/png', cookie: await cookieOf(ravi) }, body: PNG }); assert.equal(rawUp.status, 404);
  assert.equal(missing.status, 404); assert.equal(snapshot(), before, 'no row changed');
  // a student cannot attach another student's staged proof to their own submission
  const up = await upload(asha, asha.payId, PNG); assert.equal(up.status, 201);
  const steal = await ravi.c.post(`${BASE}/payments/${ravi.payId}/submit`, sub({ utr: 'SEC0000RAVI01', proofId: up.data.proofId })); assert.equal(steal.status, 400); assert.equal(x.row('priority_payments', 'id = ?', ravi.payId).status, 'AWAITING_PAYMENT');
  // the list endpoint only ever returns the caller's own payments
  assert.ok((await ravi.c.get(`${BASE}/payments`)).data.payments.every((p) => p.id === ravi.payId));
});
// helpers that need the session cookie: the shared client keeps it private, so log in again and capture it
const jar = new Map();
async function cookieOf(s) {
  if (jar.has(s.id)) return jar.get(s.id);
  const res = await fetch(`${x.srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: s.email, password: 'Str0ng!Pass1' }) });
  const c = (res.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; '); jar.set(s.id, c); return c;
}
const upload = async (s, payId, body, type = 'image/png') => { const r = await fetch(`${x.srv.base}${BASE}/payments/${payId}/proof`, { method: 'POST', headers: { 'Content-Type': type, cookie: await cookieOf(s) }, body }); return { status: r.status, data: await r.json().catch(() => null) }; };

test('4. unauthorized admin access: anonymous, student, permission-less admin, review-only admin, refund-only admin and the shared API key are all refused', async () => {
  const sub1 = await x.submit(asha, { utr: 'SEC0000ASHA01' }); assert.equal(sub1.status, 201, JSON.stringify(sub1.data));
  const d = await x.detail(x.boss, asha.payId); const body = { submissionId: d.review.submissionId, acknowledgements: ACK, reason: 'INCORRECT_AMOUNT' };
  const calls = [['get', `${AP}/queue`], ['get', `${AP}/${asha.payId}`], ['get', `${AP}/${asha.payId}/history`], ['post', `${AP}/${asha.payId}/confirm`, body], ['post', `${AP}/${asha.payId}/reject`, body], ['get', `${AP}/${asha.payId}/proof`],
    ['get', `${AP}/config`], ['put', `${AP}/config`, { payeeName: 'Evil' }], ['get', `${AP}/pricing`], ['get', `${AP}/reports/summary`], ['get', `${AP}/reports/transactions.csv`], ['get', `${AP}/refunds`]];
  for (const who of [client(x.srv.base), asha.c]) for (const [m, p, b] of calls) assert.ok([401, 403].includes((await who[m](p, b)).status), `${m} ${p}`);
  for (const [m, p, b] of calls) assert.equal((await client(x.srv.base)[m](p, b, { 'X-Admin-Key': 'k'.repeat(40) })).status >= 401, true, 'the shared key never touches payments');
  assert.equal((await plain.get(`${AP}/queue`)).status, 403); assert.equal((await plain.post(`${AP}/${asha.payId}/confirm`, body)).status, 403);
  assert.equal((await refunder.get(`${AP}/queue`)).status, 403, 'refund permission does not allow reviewing'); assert.equal((await refunder.post(`${AP}/${asha.payId}/confirm`, body)).status, 403);
  assert.equal((await reviewer.get(`${AP}/reports/summary`)).status, 403, 'review permission does not include financial reports'); assert.equal((await reviewer.put(`${AP}/config`, { payeeName: 'Evil' })).status, 403);
  assert.equal((await reviewer.get(`${AP}/refunds`)).status, 403);
  assert.equal(x.row('priority_payments', 'id = ?', asha.payId).status, 'PENDING_VERIFICATION', 'nothing was decided by a refused caller');
  assert.ok(x.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action = 'admin.access_denied'").get().n >= 3, 'refusals are audited');
});

test('5. UTR rules: format, normalisation, injection strings and global uniqueness (the same message whoever owns the other submission)', async () => {
  for (const utr of ['', 'SHORT', 'A'.repeat(36), 'ABC DEF$%^&*', 'AAAAAAAAAAAA', '123456789012', "'; DROP TABLE priority_payments;--", '<script>alert(1)</script>', 'ÀÉÎÕÜ12345678']) {
    const r = await x.submit(ravi, { utr }); assert.equal(r.status, 400, JSON.stringify(utr)); assert.ok(r.data.error.fields.utr);
  }
  assert.ok(x.db.prepare('SELECT COUNT(*) n FROM priority_payments').get().n > 0, 'tables intact after injection attempts');
  // a duplicate of Asha's pending UTR, in any casing/spacing, is refused with the neutral message and flagged to reviewers
  for (const utr of ['SEC0000ASHA01', 'sec0000asha01', ' SEC0000 ASHA01 ']) { const r = await x.submit(ravi, { utr }); assert.equal(r.status, 409); assert.equal(r.data.error.code, 'DUPLICATE_UTR'); assert.doesNotMatch(r.data.error.message, /asha|another student/i); }
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payment_submissions WHERE payment_id = ?').get(ravi.payId).n, 0);
  assert.ok(x.row('audit_logs', "action = 'payment.duplicate_attempt' AND target_id = ?", ravi.payId)); assert.ok(x.row('notifications', "type = 'payment_duplicate_admin'"));
  // the database itself refuses a second confirmed row for one UTR
  assert.throws(() => x.db.prepare("INSERT INTO confirmed_payment_utrs (utr, payment_id, submission_id, admin_id, confirmed_at) VALUES ('SEC0000ASHA01', ?, 'PSB-X', 'a', 'now')").run(ravi.payId));
  assert.equal((await x.submit(ravi, { utr: 'SEC0000RAVI01' })).status, 201);
});

test('6. duplicate confirmation: a second confirmation is refused, and the database refuses a second or mismatching transaction record', async () => {
  const first = await x.confirm(x.boss, asha.payId); assert.equal(first.status, 200, JSON.stringify(first.data));
  const again = await x.boss.post(`${AP}/${asha.payId}/confirm`, { submissionId: x.row('priority_payment_submissions', 'payment_id = ?', asha.payId).id, acknowledgements: ACK });
  assert.equal(again.status, 409); assert.equal(again.data.error.code, 'ALREADY_VERIFIED');
  const other = await reviewer.post(`${AP}/${asha.payId}/confirm`, { submissionId: x.row('priority_payment_submissions', 'payment_id = ?', asha.payId).id, acknowledgements: ACK }); assert.equal(other.status, 409);
  assert.equal((await x.boss.post(`${AP}/${asha.payId}/reject`, { submissionId: x.row('priority_payment_submissions', 'payment_id = ?', asha.payId).id, reason: 'INCORRECT_AMOUNT' })).status, 409, 'a verified payment cannot be rejected afterwards');
  for (const [t, n] of [['payment_transactions', 1], ['priority_payment_reviews', 1], ['confirmed_payment_utrs', 1]]) assert.equal(x.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE payment_id = ?`).get(asha.payId).n, n, t);
  const t = x.row('payment_transactions', 'payment_id = ?', asha.payId);
  const ins = (over = {}) => { const v = { id: 'TXN-DUPLICATE01', payment_id: t.payment_id, request_id: t.request_id, student_id: t.student_id, submission_id: t.submission_id, amt: t.confirmed_amount_paise, utr: t.confirmed_utr, ...over };
    return x.db.prepare("INSERT INTO payment_transactions (id, payment_id, request_id, student_id, submission_id, confirmed_amount_paise, currency, confirmed_utr, verified_by, verified_by_name, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, 'a', 'A', 'now', 'now')").run(v.id, v.payment_id, v.request_id, v.student_id, v.submission_id, v.amt, v.utr); };
  assert.throws(() => ins(), /UNIQUE|constraint/i, 'second record for the same payment');
  assert.throws(() => ins({ payment_id: ravi.payId, amt: 1 }), /match|constraint/i, 'a record that disagrees with the payment is refused');
  assert.throws(() => x.db.prepare("UPDATE payment_transactions SET confirmed_amount_paise = 1 WHERE id = ?").run(t.id), /append-only/);
  assert.throws(() => x.db.prepare('DELETE FROM payment_transactions WHERE id = ?').run(t.id), /append-only/);
  assert.throws(() => x.db.prepare("UPDATE priority_payments SET status = 'PENDING_VERIFICATION' WHERE id = ?").run(asha.payId), /verified payment/);
  assert.throws(() => x.db.prepare('UPDATE priority_payments SET expected_paise = 1 WHERE id = ?').run(asha.payId), /cannot be changed/);
});

test('7. concurrent verification: simultaneous confirm/reject calls from two administrators produce exactly one decision and one transaction record', async () => {
  const cases = [];
  for (const [i, mode] of ['confirm-confirm', 'confirm-reject', 'reject-confirm'].entries()) { const s = await x.student('race'); await x.order(s); assert.equal((await x.submit(s, { utr: `RACE0000000${i}0` })).status, 201); cases.push([s, mode]); }
  for (const [s, mode] of cases) {
    const d = await x.detail(x.boss, s.payId); const sid = d.review.submissionId; const [a, b] = mode.split('-');
    const call = (adm, kind) => kind === 'confirm' ? adm.post(`${AP}/${s.payId}/confirm`, { submissionId: sid, acknowledgements: ACK }) : adm.post(`${AP}/${s.payId}/reject`, { submissionId: sid, reason: 'INCORRECT_AMOUNT' });
    const res = await Promise.all([call(x.boss, a), call(reviewer, b)]);
    const ok = res.filter((r) => r.status === 200); const lost = res.filter((r) => r.status === 409);
    assert.equal(ok.length, 1, `${mode}: exactly one wins (${res.map((r) => r.status)})`); assert.equal(lost.length, 1);
    assert.ok(['ALREADY_VERIFIED', 'NOT_PENDING', 'ALREADY_DECIDED'].includes(lost[0].data.error.code), lost[0].data.error.code);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payment_reviews WHERE payment_id = ?').get(s.payId).n, 1);
    const status = x.row('priority_payments', 'id = ?', s.payId).status; const txns = x.db.prepare('SELECT COUNT(*) n FROM payment_transactions WHERE payment_id = ?').get(s.payId).n;
    assert.equal(txns, status === 'VERIFIED' ? 1 : 0, `${mode}: a transaction exists if and only if the payment is verified`);
    assert.equal(x.db.prepare("SELECT COUNT(*) n FROM notifications WHERE student_id = ? AND type IN ('payment_verified', 'payment_rejected')").get(s.id).n, 1, 'the student is told once');
  }
  // a decision on a superseded submission is refused
  const s = await x.student('stale'); await x.order(s); await x.submit(s, { utr: 'STALE0000001' }); const d = await x.detail(x.boss, s.payId);
  await x.boss.post(`${AP}/${s.payId}/reject`, { submissionId: d.review.submissionId, reason: 'INVALID_REFERENCE' });
  await s.c.post(`${BASE}/payments/${s.payId}/resubmit`, { ...sub({ utr: 'STALE0000002' }), reason: 'Corrected the reference number' });
  const old = await x.boss.post(`${AP}/${s.payId}/confirm`, { submissionId: d.review.submissionId, acknowledgements: ACK }); assert.equal(old.status, 409); assert.equal(old.data.error.code, 'STALE_SUBMISSION');
  assert.equal((await x.boss.post(`${AP}/${s.payId}/confirm`, { acknowledgements: ACK })).status, 409, 'a decision must name the submission that was reviewed');
  assert.equal((await x.boss.post(`${AP}/${s.payId}/confirm`, { submissionId: x.row('priority_payment_submissions', 'payment_id = ? AND revision = 2', s.payId).id, acknowledgements: { ...ACK, amountMatches: false } })).status, 400, 'every acknowledgement is required');
});

test('8. invalid screenshot uploads are refused and leave no file behind', async () => {
  const s = await x.student('shot'); await x.order(s); const dir = path.join(x.dir, 'proofs'); const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0); const n0 = files(); const rows0 = x.db.prepare('SELECT COUNT(*) n FROM priority_payment_proofs').get().n;
  const bad = [[Buffer.from('this is not an image'), 'image/png', 415], [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png', 415], [Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'image/png', 415],
    [Buffer.from('MZ\x90\x00 executable'), 'image/jpeg', 415], [Buffer.from('<?php echo 1; ?>'), 'application/pdf', 415], [Buffer.alloc(4 * 1024 * 1024, 1), 'image/png', 413], [Buffer.alloc(0), 'image/png', 400], [PNG, 'image/svg+xml', 400], [PNG, 'text/html', 400]];
  for (const [body, type, want] of bad) { const r = await upload(s, s.payId, body, type); assert.equal(r.status, want, `${type} ${body.length}B -> ${r.status}`); }
  assert.equal(files(), n0, 'no file written for any refused upload'); assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payment_proofs').get().n, rows0);
  assert.equal((await upload(s, s.payId, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(30, 7)]), 'image/jpeg')).status, 201);
  assert.equal((await upload(s, s.payId, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(30, 7)]), 'application/pdf')).status, 201);
  assert.equal((await upload(s, 'PAY-NOPE00000000', PNG)).status, 404);
  const anon = await fetch(`${x.srv.base}${BASE}/payments/${s.payId}/proof`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG }); assert.equal(anon.status, 401);
  // proof cannot be added to a verified payment
  const v = await x.confirmed('shotv', 'SHOT00000VER1'); assert.equal((await upload(v, v.payId, PNG)).data.error.code, 'PAYMENT_NOT_OPEN');
  // the cap on staged files per payment
  const many = await x.student('many'); await x.order(many); let last; for (let i = 0; i < 6; i++) last = await upload(many, many.payId, PNG); assert.equal(last.status, 429); assert.equal(last.data.error.code, 'PROOF_LIMIT');
});

test('9. payment proofs are private: only the owner and a reviewer can read one, nothing is served statically, and stored names never leave the server', async () => {
  const s = await x.student('priv'); await x.order(s); const up = await upload(s, s.payId, PNG); assert.equal(up.status, 201);
  assert.equal((await x.submit(s, { utr: 'PRIV00000001', proofId: up.data.proofId })).status, 201);
  const stored = x.row('priority_payment_proofs', 'id = ?', up.data.proofId); const file = path.join(x.dir, 'proofs', stored.file_name);
  assert.match(stored.file_name, /^[a-f0-9]{32}\.png$/); assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const own = await fetch(`${x.srv.base}${BASE}/payments/${s.payId}/proof/${up.data.proofId}`, { headers: { cookie: await cookieOf(s) } });
  assert.equal(own.status, 200); assert.match(own.headers.get('content-disposition'), /^attachment/); assert.equal(own.headers.get('x-content-type-options'), 'nosniff'); assert.match(own.headers.get('cache-control'), /no-store/); assert.equal(own.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${x.srv.base}${BASE}/payments/${s.payId}/proof/${up.data.proofId}`, { headers: { cookie: await cookieOf(ravi) } })).status, 404, 'another student');
  assert.equal((await fetch(`${x.srv.base}${BASE}/payments/${s.payId}/proof/${up.data.proofId}`)).status, 401, 'anonymous');
  const adminUrl = `${AP}/${s.payId}/proof/${up.data.proofId}`;
  for (const who of [plain, refunder, s.c]) assert.equal((await who.get(adminUrl)).status, 403);
  assert.equal((await client(x.srv.base).get(adminUrl)).status, 401);
  const rv = await reviewer.get(adminUrl); assert.equal(rv.status, 200); assert.ok(x.row('audit_logs', "action = 'payment.proof_view' AND target_id = ? AND admin_id = ?", s.payId, reviewer.id), 'reviewer proof views are audited');
  assert.equal((await reviewer.get(`${AP}/${asha.payId}/proof/${up.data.proofId}`)).status, 404, 'a proof only opens under its own payment');
  for (const guess of [`/${stored.file_name}`, `/payment-proofs/${stored.file_name}`, `/storage/payment-proofs/${stored.file_name}`, `/uploads/${stored.file_name}`, `${BASE}/proofs/${stored.file_name}`, `${BASE}/payments/${s.payId}/proof/..%2F..%2Fetc%2Fpasswd`]) { const r = await fetch(x.srv.base + guess); assert.ok([401, 404].includes(r.status), `${guess} -> ${r.status}`); }
  const seen = JSON.stringify([(await s.c.get(`${BASE}/payments/${s.payId}`)).data, (await x.boss.get(`${AP}/${s.payId}`)).data, (await x.boss.get(`${AP}/queue`)).data]);
  assert.equal(seen.includes(stored.file_name), false, 'the stored file name is never exposed'); assert.equal(seen.includes(x.dir), false, 'no server path is exposed');
});

test('10. rejection reason is mandatory (code from the fixed list, explanation required for Other)', async () => {
  const s = await x.student('why'); await x.order(s); await x.submit(s, { utr: 'WHY000000001' }); const sid = (await x.detail(x.boss, s.payId)).review.submissionId;
  for (const body of [{}, { reason: null }, { reason: 'NOT_A_REASON' }, { reason: 'OTHER' }, { reason: 'OTHER', note: '   ' }]) assert.equal((await x.boss.post(`${AP}/${s.payId}/reject`, { submissionId: sid, ...body })).status, 400, JSON.stringify(body));
  assert.equal(x.row('priority_payments', 'id = ?', s.payId).status, 'PENDING_VERIFICATION');
  const ok = await x.boss.post(`${AP}/${s.payId}/reject`, { submissionId: sid, reason: 'OTHER', note: '<b>Reference belongs to a different amount</b>' }); assert.equal(ok.status, 200);
  const stored = x.row('priority_payments', 'id = ?', s.payId).rejection_note; assert.equal(ok.headers.get('content-type').startsWith('application/json'), true, 'text is returned as JSON data, never as HTML');
  assert.ok(stored.includes('Reference belongs'), 'the explanation is stored');
});

test('11. refund authorization: only a named administrator holding payment.refund can create, advance, complete or decline a refund', async () => {
  const s = await x.confirmed('rfa', 'RFA000000001'); const body = { amountRupees: '10', reason: 'Duplicate payment by the student', destination: 'original payment account' };
  for (const who of [client(x.srv.base), s.c, plain, reviewer]) { const r = await who.post(`${AP}/${s.payId}/refunds`, body); assert.ok([401, 403].includes(r.status), `${r.status}`); }
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payment_refunds WHERE payment_id = ?').get(s.payId).n, 0);
  const made = await refunder.post(`${AP}/${s.payId}/refunds`, body); assert.equal(made.status, 201, JSON.stringify(made.data)); const id = made.data.refund.id;
  assert.equal(x.row('payment_refunds', 'id = ?', id).requested_by, refunder.id, 'the administrator is recorded');
  for (const who of [client(x.srv.base), s.c, plain, reviewer]) for (const p of ['pending', 'complete', 'reject']) assert.ok([401, 403].includes((await who.post(`${AP}/refunds/${id}/${p}`, { reason: 'Because of reasons', refundUtr: 'RFA0000REFUND', acknowledgements: RACK })).status));
  assert.equal(x.row('payment_refunds', 'id = ?', id).status, 'REFUND_REQUESTED');
  assert.equal((await x.boss.post(`${AP}/refunds/${id}/pending`, {})).status, 200);
  assert.equal((await refunder.get(`${AP}/refunds`)).status, 200);
  // the shared admin API key can never move money records
  assert.ok((await client(x.srv.base).post(`${AP}/refunds/${id}/complete`, { refundUtr: 'RFA0000REFUND', acknowledgements: RACK }, { 'X-Admin-Key': 'k'.repeat(40) })).status >= 401);
  assert.equal(x.row('payment_refunds', 'id = ?', id).status, 'REFUND_PENDING');
  // a refund is not marked completed without the real reference and every acknowledgement
  assert.equal((await refunder.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'RFA0000REFUND' })).status, 400);
  assert.equal((await refunder.post(`${AP}/refunds/${id}/complete`, { acknowledgements: RACK })).status, 400);
  assert.equal(x.row('payment_refunds', 'id = ?', id).status, 'REFUND_PENDING');
});

test('12–13. refund amount validation and duplicate-refund prevention (partial refunds are supported; the total can never exceed the confirmed amount)', async () => {
  const s = await x.confirmed('rfv', 'RFV000000001'); const total = x.row('priority_payments', 'id = ?', s.payId).expected_paise; const rupees = (p) => String(p / 100);
  const mk = (over = {}) => refunder.post(`${AP}/${s.payId}/refunds`, { amountRupees: '10', reason: 'Duplicate payment by the student', destination: 'student@okbank', ...over });
  for (const amountRupees of ['0', '-10', '0.5', '1.234', 'ten', '', null, '1e3', '99999999']) { const r = await mk({ amountRupees }); assert.equal(r.status, 400, String(amountRupees)); }
  for (const over of [{ reason: '' }, { reason: 'short' }, { destination: '' }, { destination: 'bad@' }, { destination: 'x'.repeat(200) }]) assert.equal((await mk(over)).status, 400, JSON.stringify(over));
  assert.equal((await mk({ amountRupees: rupees(total + 100) })).data.error.code, 'REFUND_EXCEEDS_PAYMENT');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payment_refunds WHERE payment_id = ?').get(s.payId).n, 0, 'invalid requests write nothing');
  const pending = await x.student('rfn'); await x.order(pending); await x.submit(pending, { utr: 'RFV000000099' });
  assert.equal((await refunder.post(`${AP}/${pending.payId}/refunds`, { amountRupees: '10', reason: 'Duplicate payment by the student', destination: 'student@okbank' })).data.error.code, 'PAYMENT_NOT_VERIFIED', 'unverified money cannot be refunded');
  // partial refunds add up; the remainder is exact
  const a = await mk({ amountRupees: rupees(total - 1500) }); assert.equal(a.status, 201, JSON.stringify(a.data)); assert.equal(a.data.balance.availablePaise, 1500);
  assert.equal((await mk({ amountRupees: '16' })).data.error.code, 'REFUND_EXCEEDS_BALANCE');
  const b = await mk({ amountRupees: '15' }); assert.equal(b.status, 201); assert.equal(b.data.balance.availablePaise, 0);
  assert.equal((await mk({ amountRupees: '1' })).data.error.code, 'REFUND_EXCEEDS_BALANCE', 'nothing is left to refund');
  assert.throws(() => x.db.prepare("INSERT INTO payment_refunds (id, payment_id, student_id, amount_paise, reason, destination, status, requested_by, requested_by_name, requested_at, updated_at) VALUES ('RFD-DIRECT000001', ?, ?, 100, 'direct insert', 'x', 'REFUND_REQUESTED', 'a', 'A', 'now', 'now')").run(s.payId, s.id), /exceed/i, 'the database enforces the cap too');
  assert.equal(x.payDb.refundReserved(s.payId), total);
  // declining a refund releases its share, and only once
  assert.equal((await x.boss.post(`${AP}/refunds/${b.data.refund.id}/reject`, { reason: 'Declined: raised in error' })).status, 200);
  assert.equal((await x.boss.post(`${AP}/refunds/${b.data.refund.id}/reject`, { reason: 'Declined: raised in error' })).status, 409);
  assert.equal(x.payDb.refundReserved(s.payId), total - 1500);
  // completing: once only, with a unique real reference that is not the payment's own
  const id = a.data.refund.id; assert.equal((await x.boss.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'RFV000000001', acknowledgements: RACK })).data.error.code, 'REFUND_STATE', 'must be approved (pending) first');
  assert.equal((await x.boss.post(`${AP}/refunds/${id}/pending`, {})).status, 200); assert.equal((await x.boss.post(`${AP}/refunds/${id}/pending`, {})).status, 409);
  assert.equal((await x.boss.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'RFV000000001', acknowledgements: RACK })).data.error.code, 'REFUND_REFERENCE_IS_PAYMENT');
  assert.equal((await x.boss.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'bad', acknowledgements: RACK })).status, 400);
  for (const refundDate of ['2026-13-40', '2026-02-31', 'tomorrow']) assert.equal((await x.boss.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'RFV0000REFUND1', refundDate, acknowledgements: RACK })).status, 400, `refund date ${refundDate}`);
  const done = await x.boss.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'RFV0000REFUND1', acknowledgements: RACK }); assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await x.boss.post(`${AP}/refunds/${id}/complete`, { refundUtr: 'RFV0000REFUND2', acknowledgements: RACK })).data.error.code, 'REFUND_STATE', 'a completed refund cannot be completed again');
  assert.equal((await x.boss.post(`${AP}/refunds/${id}/reject`, { reason: 'Changing my mind later' })).status, 409, 'a completed refund cannot be declined');
  assert.throws(() => x.db.prepare('UPDATE payment_refunds SET amount_paise = 1 WHERE id = ?').run(id), /cannot be changed/); assert.throws(() => x.db.prepare('DELETE FROM payment_refunds WHERE id = ?').run(id), /cannot be deleted/);
  const other = await x.confirmed('rfw', 'RFW000000001'); const o = await refunder.post(`${AP}/${other.payId}/refunds`, { amountRupees: '10', reason: 'Duplicate payment by the student', destination: 'student@okbank' }); await x.boss.post(`${AP}/refunds/${o.data.refund.id}/pending`, {});
  assert.equal((await x.boss.post(`${AP}/refunds/${o.data.refund.id}/complete`, { refundUtr: 'RFV0000REFUND1', acknowledgements: RACK })).data.error.code, 'DUPLICATE_REFUND_REFERENCE', 'one refund reference can back only one refund');
  // history is preserved and the confirmed payment itself was never edited
  assert.deepEqual(x.db.prepare('SELECT event FROM payment_refund_events WHERE refund_id = ? ORDER BY id').all(id).map((e) => e.event), ['requested', 'pending', 'completed']);
  assert.equal(x.row('priority_payments', 'id = ?', s.payId).status, 'VERIFIED'); assert.equal(x.row('priority_payments', 'id = ?', s.payId).expected_paise, total);
});

test('injection and CSRF: search input is parameterised, cross-origin writes are blocked', async () => {
  for (const q of ["' OR 1=1 --", "%' ; DROP TABLE priority_payments; --", '\\', '%', '_', '<script>alert(1)</script>']) { const r = await x.boss.get(`${AP}/queue?q=${encodeURIComponent(q)}`); assert.equal(r.status, 200, q); assert.equal(r.data.payments.length, 0, `a hostile search matches nothing (${q})`); }
  for (const q of ['from=2026-13-40', 'to=2026-02-31', 'from=2026-00-10']) assert.equal((await x.boss.get(`${AP}/queue?${q}`)).status, 400, `impossible date ${q} is a 400, not a server error`);
  assert.ok(x.db.prepare('SELECT COUNT(*) n FROM priority_payments').get().n > 0);
  const hit = await x.boss.get(`${AP}/queue?q=${encodeURIComponent('SEC0000ASHA01')}`); assert.equal(hit.data.payments.length, 1);
  for (const [url, body] of [[`${BASE}/requests/${asha.reqId}/payment-order`, '{}'], [`${AP}/config`, '{}']]) {
    const evil = await fetch(x.srv.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', cookie: await cookieOf(asha) }, body }); assert.equal(evil.status, 403); assert.equal((await evil.json()).error.code, 'BAD_ORIGIN');
    const site = await fetch(x.srv.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site', cookie: await cookieOf(asha) }, body }); assert.equal(site.status, 403);
  }
  const same = await fetch(`${x.srv.base}${BASE}/payments/${asha.payId}/status`, { headers: { cookie: await cookieOf(asha), 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(same.status, 200, 'reads are unaffected');
});
