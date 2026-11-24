// Stage 10C Part 1 — API rate limiting on payment endpoints. Limits are lowered through the environment; every limiter is keyed per authenticated account, never shared.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client } from './helpers.js';
import { setup, BASE, AP, PNG, ACK, sub } from './stage10c.payfixture.js';

let x, rev1, rev2, rep1, rep2;
before(async () => {
  x = await setup({ RATE_LIMIT_PAYMENT_WRITE_MAX: '3', RATE_LIMIT_PAYMENT_UPLOAD_MAX: '2', RATE_LIMIT_ADMIN_PAYMENT_WRITE_MAX: '4', RATE_LIMIT_ADMIN_EXPORT_MAX: '2' });
  assert.equal((await x.configure()).status, 200); // 1 of boss's 4 admin writes
  [rev1, rev2] = [await x.makeAdmin('rev1@example.com', 'Reviewer One', ['payment.review']), await x.makeAdmin('rev2@example.com', 'Reviewer Two', ['payment.review'])];
  [rep1, rep2] = [await x.makeAdmin('rep1@example.com', 'Reporter One', ['payment.report']), await x.makeAdmin('rep2@example.com', 'Reporter Two', ['payment.report'])];
});
after(async () => { await x.close(); });
const cookieOf = async (s) => { const r = await fetch(`${x.srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: s.email, password: 'Str0ng!Pass1' }) }); return (r.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; '); };

test('16. student payment writes are limited per student (every attempt counts, including invalid UTRs), reads are not, and other students are unaffected', async () => {
  const a = await x.student('lim'); const b = await x.student('other');
  await x.order(a); // write 1
  assert.equal((await x.submit(a, { utr: 'bad' })).status, 400); // write 2
  assert.equal((await x.submit(a, { utr: 'worse' })).status, 400); // write 3
  const blocked = await x.submit(a, { utr: 'LIM000000001' }); assert.equal(blocked.status, 429); assert.equal(blocked.data.error.code, 'RATE_LIMITED'); assert.ok(blocked.headers.get('ratelimit') || blocked.headers.get('ratelimit-policy'), 'standard rate-limit headers are sent');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payment_submissions WHERE student_id = ?').get(a.id).n, 0, 'the blocked request wrote nothing');
  assert.equal((await a.c.get(`${BASE}/payments/${a.payId}`)).status, 200, 'reads still work');
  assert.equal((await a.c.post(`${BASE}/payments/${a.payId}/resubmit`, {})).status, 429, 'resubmission shares the same budget');
  await x.order(b); assert.equal((await x.submit(b, { utr: 'LIM000000002' })).status, 201, 'another student has their own budget');
});

test('16. proof uploads have their own per-student limit', async () => {
  const s = await x.student('up'); await x.order(s); const ck = await cookieOf(s);
  const up = () => fetch(`${x.srv.base}${BASE}/payments/${s.payId}/proof`, { method: 'POST', headers: { 'Content-Type': 'image/png', cookie: ck }, body: PNG });
  assert.equal((await up()).status, 201); assert.equal((await up()).status, 201);
  const third = await up(); assert.equal(third.status, 429); assert.equal((await third.json()).error.code, 'RATE_LIMITED');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM priority_payment_proofs WHERE payment_id = ?').get(s.payId).n, 2);
});

test('16. administrator payment decisions are limited per administrator, not per IP', async () => {
  const s = await x.student('adm'); await x.order(s); await x.submit(s, { utr: 'ADM000000001' }); const sid = (await x.detail(rev1, s.payId)).review.submissionId;
  for (let i = 0; i < 4; i++) assert.equal((await rev1.post(`${AP}/${s.payId}/reject`, { submissionId: sid })).status, 400, `attempt ${i + 1} reaches validation`); // 4 refused rejects use the whole budget
  const blocked = await rev1.post(`${AP}/${s.payId}/reject`, { submissionId: sid, reason: 'INCORRECT_AMOUNT' }); assert.equal(blocked.status, 429); assert.equal(blocked.data.error.code, 'RATE_LIMITED');
  assert.equal(x.row('priority_payments', 'id = ?', s.payId).status, 'PENDING_VERIFICATION', 'the blocked decision was not applied');
  assert.equal((await rev1.get(`${AP}/queue`)).status, 200, 'reads are not limited by the write budget');
  const ok = await rev2.post(`${AP}/${s.payId}/confirm`, { submissionId: sid, acknowledgements: ACK }); assert.equal(ok.status, 200, 'a different administrator has their own budget');
});

test('16. financial report views and CSV exports are limited per administrator', async () => {
  assert.equal((await rep1.get(`${AP}/reports/summary`)).status, 200); assert.equal((await rep1.get(`${AP}/reports/transactions`)).status, 200);
  const blocked = await rep1.get(`${AP}/reports/summary`); assert.equal(blocked.status, 429); assert.equal(blocked.data.error.code, 'RATE_LIMITED');
  assert.equal((await rep1.get(`${AP}/reports/transactions.csv`)).status, 429, 'the export shares the budget');
  assert.equal((await rep2.get(`${AP}/reports/summary`)).status, 200, 'another administrator is unaffected');
});
