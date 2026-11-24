// 1/2/3-month plans with an instant certificate after the administrator verifies the payment. MOCKED payments only (a UTR string + an admin confirm call).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, validStudent } from './helpers.js';
import { setup, BASE, sub } from './stage10c.payfixture.js';

let x; let n = 0; let runCycle;
before(async () => { x = await setup(); ({ runCycle } = await import('../src/automation/worker.js')); assert.equal((await x.configure()).status, 200); });
after(async () => { await x.close(); });

// A brand-new student: no application, no internship, no invitation.
async function newStudent() {
  const email = `plan${++n}@example.com`; const c = client(x.srv.base);
  assert.equal((await c.post('/auth/register', validStudent({ email, fullName: `Plan Student ${'abcdefghij'[n % 10]}` }))).status, 201);
  return c;
}
const body = (months) => ({ months, confirmPersonal: true, confirmAcademic: true });

test('the page offers exactly 1, 2 and 3 months with server prices, and no 7-day plan', async () => {
  const c = await newStudent();
  const r = await c.get(`${BASE}/plans`); assert.equal(r.status, 200);
  assert.deepEqual(r.data.plans.map((p) => [p.months, p.durationDays, p.amountPaise]), [[1, 30, 4900], [2, 60, 9900], [3, 90, 19900]]);
  for (const months of [0, 7, 4, 'x', null]) assert.equal((await c.post(`${BASE}/plans`, body(months))).status, 400, `months=${months}`);
  assert.equal((await c.post(`${BASE}/plans`, { months: 1 })).status, 400, 'confirmations are required');
});

test('choose, pay, admin approves: offer letter now, certificate when the plan period ends', async () => {
  const c = await newStudent();
  const ch = await c.post(`${BASE}/plans`, { ...body(2), amountPaise: 1, fee: 1 }); // a client-sent fee is ignored
  assert.equal(ch.status, 201, JSON.stringify(ch.data));
  const reqId = ch.data.request.id; assert.equal(ch.data.request.durationDays, 60); assert.equal(ch.data.request.price.amountPaise, 9900);
  assert.equal((await c.post(`${BASE}/plans`, body(2))).status, 200, 'choosing again returns the same request');
  const o = await c.post(`${BASE}/requests/${reqId}/payment-order`, {}); assert.equal(o.status, 201, JSON.stringify(o.data));
  const payId = o.data.payment.id; assert.equal(o.data.payment.amountPaise, 9900);
  assert.equal((await c.post(`${BASE}/payments/${payId}/submit`, sub({ utr: `PLAN${n}000000000` }))).status, 201);

  // nothing is issued before an administrator verifies
  let list = (await c.get(`${BASE}/requests`)).data.requests; assert.equal(list.find((r) => r.id === reqId).status, 'Payment Pending');
  const done = await x.confirm(x.boss, payId); assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.certificate?.issued, false, 'no certificate on the day of payment');
  // the student never picks dates: nothing starts, and no offer letter is issued, until an administrator sets them
  assert.equal(done.data.certificate?.awaitingSchedule, true, JSON.stringify(done.data));
  assert.equal(x.row('documents', "type = 'offer_letter' AND student_id = (SELECT student_id FROM priority_requests WHERE id = ?)", reqId), undefined);
  const enrId = x.row('priority_requests', 'id = ?', reqId).enrollment_id;
  const tooOld = new Date(Date.now() - 91 * 86400000).toISOString().slice(0, 10);
  const r91 = await x.boss.patch(`/admin/internships/${enrId}/schedule`, { startDate: tooOld }); assert.equal(r91.status, 400, 'more than 90 days back is refused');
  assert.ok(r91.data.error.fields.startDate);
  assert.equal((await c.patch(`/admin/internships/${enrId}/schedule`, { startDate: tooOld })).status >= 400, true, 'a student cannot set dates');
  const ok = await x.boss.patch(`/admin/internships/${enrId}/schedule`, { startDate: new Date().toISOString().slice(0, 10) }); assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.internship.status, 'Active');
  list = (await c.get(`${BASE}/requests`)).data.requests; assert.equal(list.find((r) => r.id === reqId).status, 'Payment Verified');
  const offer = x.row('documents', "type = 'offer_letter' AND student_id = (SELECT student_id FROM priority_requests WHERE id = ?)", reqId);
  assert.equal(offer?.status, 'Issued', 'offer letter issued immediately');
  assert.equal(x.row('documents', "type = 'certificate' AND student_id = (SELECT student_id FROM priority_requests WHERE id = ?)", reqId), undefined);
  // the plan period (60 days) has not ended: a cycle 10 days later still issues nothing
  await runCycle({ now: new Date(Date.now() + 10 * 86400000), force: true });
  assert.equal(x.row('documents', "type = 'certificate' AND student_id = (SELECT student_id FROM priority_requests WHERE id = ?)", reqId), undefined);
  // after the period the worker completes the internship and issues the certificate
  await runCycle({ now: new Date(Date.now() + 62 * 86400000), force: true });
  list = (await c.get(`${BASE}/requests`)).data.requests; assert.equal(list.find((r) => r.id === reqId).status, 'Certificate Issued');
  const doc = x.row('documents', "type = 'certificate' AND student_id = (SELECT student_id FROM priority_requests WHERE id = ?)", reqId);
  assert.equal(doc.status, 'Issued');
  assert.equal((await c.post(`${BASE}/plans`, body(2))).status, 409, 'the same plan cannot be bought twice');
  assert.equal((await c.post(`${BASE}/plans`, body(3))).status, 201, 'another length can');
});

test('a rejected payment issues nothing', async () => {
  const c = await newStudent();
  const reqId = (await c.post(`${BASE}/plans`, body(1))).data.request.id;
  const payId = (await c.post(`${BASE}/requests/${reqId}/payment-order`, {})).data.payment.id;
  assert.equal((await c.post(`${BASE}/payments/${payId}/submit`, sub({ utr: `REJ${n}0000000000` }))).status, 201);
  assert.equal((await x.reject(x.boss, payId, { reason: 'INSUFFICIENT_EVIDENCE' })).status, 200);
  assert.equal(x.row('documents', 'student_id = (SELECT student_id FROM priority_requests WHERE id = ?)', reqId), undefined);
});
