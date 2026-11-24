// Stage 10C Part 1 — shared fixture for the payment audit suites. MOCKED payments only: nothing here talks to a bank or a payment gateway; every "payment" is a
// UTR string typed by a test student and every confirmation is an HTTP call by a test administrator, exactly like production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

export const PW = 'Str0ng!Pass1'; export const BASE = '/priority-certificate'; export const AP = '/admin/priority-payments';
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
export const ACK = { accountChecked: true, utrMatches: true, amountMatches: true, transactionSuccessful: true, notAssignedElsewhere: true };
export const RACK = { accountChecked: true, referenceMatches: true, amountMatches: true };
export const today = () => new Date().toISOString().slice(0, 10);
export const sub = (over = {}) => ({ utr: '412345678901', paymentDate: today(), paymentTime: '10:30', upiApp: 'PhonePe', confirmed: true, ...over });

export async function setup(env = {}) {
  const x = { counter: 0 };
  x.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-10c1-'));
  x.srv = await startServer({ DOCUMENTS_DIR: path.join(x.dir, 'documents'), PAYMENT_PROOF_DIR: path.join(x.dir, 'proofs'), PAYMENT_ADMIN_EMAILS: 'boss@example.com',
    ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000', ...env });
  x.db = (await import('../src/db/index.js')).db; x.svc = await import('../src/services/priorityCertificate.js'); x.payDb = await import('../src/db/payments.js');
  x.close = async () => { await x.srv.close(); fs.rmSync(x.dir, { recursive: true, force: true }); };
  x.makeAdmin = async (email, name, perms = []) => {
    const c = client(x.srv.base);
    assert.equal((await c.post('/auth/register', validStudent({ email, fullName: name }))).status, 201);
    const { findByEmail, setRole } = await import('../src/db/students.js'); const id = findByEmail(email).id; setRole(id, 'admin');
    assert.equal((await c.post('/auth/admin/login', { email, password: PW })).status, 200);
    for (const p of perms) x.payDb.grantPermission(id, p, 'test');
    c.id = id; return c;
  };
  x.boss = await x.makeAdmin('boss@example.com', 'Boss Admin'); // bootstrap e-mail: holds every permission
  x.payDb.grantPermission(x.boss.id, 'certificate.correct', 'test'); // Stage 10C Part 2: corrections need their own permission (PAYMENT_ADMIN_EMAILS does not imply it)
  x.configure = (over = {}) => x.boss.put(`${AP}/config`, { confirm: true, upiId: 'elvora.pay@okbank', payeeName: 'ELVORA Technologies', instructions: 'Pay the exact amount and keep the transaction reference.', supportContact: 'support@elvora.in', verificationHours: 24, manualEnabled: true, submissionsEnabled: true, ...over });
  // An enrolled student with a completed internship, an invitation redeemed and a draft priority request.
  x.student = async (tag, { draft = true, over = {} } = {}) => {
    const n = ++x.counter; const email = `${tag}${n}@example.com`; const name = `${tag[0].toUpperCase()}${tag.slice(1)} ${'Tester'.split('').map((ch, i) => String.fromCharCode(97 + ((n + i) % 26))).join('')}`; const c = client(x.srv.base);
    assert.equal((await c.post('/auth/register', validStudent({ email, fullName: name }))).status, 201);
    const a = await c.post('/applications', validApplication({ fullName: name, ...over })); assert.equal(a.status, 201, JSON.stringify(a.data));
    const appId = a.data.application.id;
    assert.equal((await x.boss.patch(`/admin/applications/${appId}/status`, { status: 'Approved' })).status, 200);
    const e = await x.boss.post(`/admin/applications/${appId}/internship`, { startDate: '2026-01-05' }); assert.equal(e.status, 201, JSON.stringify(e.data));
    const enrId = e.data.internship.id; const id = x.db.prepare('SELECT id FROM students WHERE email = ?').get(email).id;
    x.db.prepare("UPDATE enrollments SET status = 'Completed', start_date = '2026-01-05', completed_at = '2026-06-30T10:00:00.000Z', expected_end_date = '2026-06-30', certificate_decision = 'Approved' WHERE id = ?").run(enrId);
    const s = { c, id, email, name, appId, enrId };
    s.token = x.svc.createInvitation({ studentId: id }).token;
    if (draft) { assert.equal((await c.post(BASE + '/access', { token: s.token })).status, 200); s.reqId = await x.draft(s); }
    return s;
  };
  x.draft = async (s) => { const r = await s.c.post(BASE + '/requests', { applicationId: s.appId, confirmPersonal: true, confirmAcademic: true }); assert.ok([200, 201].includes(r.status), JSON.stringify(r.data)); return r.data.request.id; };
  x.order = async (s, body = {}) => { const r = await s.c.post(`${BASE}/requests/${s.reqId}/payment-order`, body); assert.ok([200, 201].includes(r.status), JSON.stringify(r.data)); s.payId = r.data.payment.id; return r; };
  x.submit = async (s, over = {}) => s.c.post(`${BASE}/payments/${s.payId}/submit`, sub(over));
  x.detail = async (adm, payId) => { const d = await adm.get(`${AP}/${payId}`); assert.equal(d.status, 200, JSON.stringify(d.data)); return d.data; };
  x.confirm = async (adm, payId, extra = {}) => { const d = await x.detail(adm, payId); return adm.post(`${AP}/${payId}/confirm`, { submissionId: d.review.submissionId, acknowledgements: ACK, ...extra }); };
  x.reject = async (adm, payId, body = {}) => { const d = await x.detail(adm, payId); return adm.post(`${AP}/${payId}/reject`, { submissionId: d.review.submissionId, ...body }); };
  x.row = (table, where, ...args) => x.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...args);
  // submit + confirm in one go; returns the payment id (a CONFIRMED payment).
  x.confirmed = async (tag, utr) => { const s = await x.student(tag); await x.order(s); assert.equal((await x.submit(s, { utr })).status, 201); const r = await x.confirm(x.boss, s.payId); assert.equal(r.status, 200, JSON.stringify(r.data)); return s; };
  return x;
}
