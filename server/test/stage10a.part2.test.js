// Stage 10A Part 2 — admin priority request management, free corrections, document supersession, notifications, audit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1'; const BASE = '/priority-certificate'; const AP = '/admin/priority-certificates';
let srv, dir, db, svc, boss, checker, asha, ravi, anon, ids = {}, apps = {}, enr = {}, reqId, certDoc;
const KEY = 'k'.repeat(40);

async function makeAdmin(email, name) {
  const c = client(srv.base);
  assert.equal((await c.post('/auth/register', validStudent({ email, fullName: name }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail(email).id, 'admin');
  assert.equal((await c.post('/auth/admin/login', { email, password: PW })).status, 200);
  return c;
}
async function enroll(c, email, name) {
  await c.post('/auth/register', validStudent({ email, fullName: name }));
  const a = await c.post('/applications', validApplication({ fullName: name }));
  const appId = a.data.application.id;
  assert.equal((await boss.patch(`/admin/applications/${appId}/status`, { status: 'Approved' })).status, 200);
  const e = await boss.post(`/admin/applications/${appId}/internship`, { startDate: '2026-01-05' });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  return { appId, enrId: e.data.internship.id };
}
const complete = (enrId) => db.prepare("UPDATE enrollments SET status = 'Completed', start_date = '2026-01-05', completed_at = '2026-06-30T10:00:00.000Z', expected_end_date = '2026-06-30', certificate_decision = 'Approved' WHERE id = ?").run(enrId);
const adminFetch = (method, p, body, headers = {}) => fetch(srv.base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
const actions = () => db.prepare('SELECT action, target_id, result FROM audit_logs').all();
const verify = (code) => fetch(`${srv.base}/public/documents/verify/${code}`).then(async (r) => ({ status: r.status, data: await r.json() }));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-10a2-'));
  srv = await startServer({ ADMIN_API_KEY: KEY, DOCUMENTS_DIR: path.join(dir, 'documents'), ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Priya Rao', ORG_SIGNATORY_TITLE: 'Director', RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000' });
  ({ db } = await import('../src/db/index.js'));
  svc = await import('../src/services/priorityCertificate.js');
  boss = await makeAdmin('boss@example.com', 'Boss Admin');
  // Stage 10C Part 2: corrections need the 'certificate.correct' permission and a SECOND administrator to approve (the creator may not). `boss` creates, `checker` approves.
  checker = await makeAdmin('checker@example.com', 'Checker Admin');
  { const { findByEmail } = await import('../src/db/students.js'); const { grantPermission } = await import('../src/db/payments.js');
    for (const e of ['boss@example.com', 'checker@example.com']) grantPermission(findByEmail(e).id, 'certificate.correct', 'test'); }
  asha = client(srv.base); ravi = client(srv.base); anon = client(srv.base);
  const a = await enroll(asha, 'asha@example.com', 'Asha Verma'); const r = await enroll(ravi, 'ravi@example.com', 'Ravi Kumar');
  apps = { asha: a.appId, ravi: r.appId }; enr = { asha: a.enrId, ravi: r.enrId };
  ids.asha = db.prepare('SELECT id FROM students WHERE email = ?').get('asha@example.com').id;
  ids.ravi = db.prepare('SELECT id FROM students WHERE email = ?').get('ravi@example.com').id;
  complete(enr.asha); complete(enr.ravi);
  for (const [c, id] of [[asha, ids.asha], [ravi, ids.ravi]]) assert.equal((await c.post(BASE + '/access', { token: svc.createInvitation({ studentId: id }).token })).status, 200);
  const d = await asha.post(BASE + '/requests', { applicationId: apps.asha, confirmPersonal: true, confirmAcademic: true });
  assert.equal(d.status, 201, JSON.stringify(d.data)); reqId = d.data.request.id;
});
after(() => srv.close());

test('security: public, student and shared-key callers cannot use the admin priority API', async () => {
  for (const [m, p] of [['GET', '/requests'], ['GET', `/requests/${reqId}`], ['POST', `/requests/${reqId}/status`], ['GET', '/corrections'], ['POST', '/corrections']]) {
    assert.equal((await adminFetch(m, AP + p, m === 'GET' ? undefined : {})).status, 401, `anon ${m} ${p}`);
    assert.equal((await adminFetch(m, AP + p, m === 'GET' ? undefined : {}, { 'X-Admin-Key': KEY })).status, 401, `key ${m} ${p}`);
    const s = m === 'GET' ? await asha.get(AP + p) : await asha.post(AP + p, {});
    assert.equal(s.status, 403, `student ${m} ${p}`);
  }
});

test('student sees their own request received notification; another student cannot read the request', async () => {
  const n = await asha.get('/student/notifications');
  assert.ok(JSON.stringify(n.data).includes('Priority request received'));
  assert.equal((await ravi.get(`${BASE}/requests/${reqId}`)).status, 404);
});

test('list: search by student / application / request id, filters, pagination, validation', async () => {
  await ravi.post(BASE + '/requests', { applicationId: apps.ravi, confirmPersonal: true, confirmAcademic: true });
  const all = await boss.get(AP + '/requests'); assert.equal(all.status, 200); assert.equal(all.data.pagination.total, 2);
  assert.equal((await boss.get(AP + '/requests?student=asha')).data.requests.length, 1);
  assert.equal((await boss.get(`${AP}/requests?applicationId=${apps.ravi}`)).data.requests[0].studentName, 'Ravi Kumar');
  assert.equal((await boss.get(`${AP}/requests?requestId=${reqId}`)).data.requests.length, 1);
  assert.equal((await boss.get(AP + '/requests?status=Draft')).data.requests.length, 2);
  assert.equal((await boss.get(AP + '/requests?status=Rejected')).data.requests.length, 0);
  assert.equal((await boss.get(AP + '/requests?durationDays=60')).data.requests.length, 0);
  assert.equal((await boss.get(`${AP}/requests?from=2020-01-01&to=2020-01-02`)).data.requests.length, 0);
  const p = await boss.get(AP + '/requests?pageSize=1&page=2'); assert.equal(p.data.requests.length, 1); assert.equal(p.data.pagination.totalPages, 2);
  assert.equal((await boss.get(AP + '/requests?status=Bogus')).status, 400);
  assert.equal((await boss.get(AP + '/requests?student=%25')).data.requests.length, 0); // LIKE wildcards are escaped
  const row = all.data.requests[0]; assert.equal(row.free, false); assert.equal(row.paymentState, 'unpaid'); assert.equal(row.email, undefined);
});

test('detail: student info is minimal, eligibility and completion evidence are shown', async () => {
  const d = await boss.get(`${AP}/requests/${reqId}`); assert.equal(d.status, 200);
  assert.equal(d.data.student.fullName, 'Asha Verma'); assert.equal(d.data.student.email, undefined); assert.equal(d.data.student.phone, undefined);
  assert.equal(d.data.eligibility.eligible, true); assert.equal(d.data.actual.startDate, '2026-01-05'); assert.ok(d.data.completionEvidence); assert.ok(Array.isArray(d.data.history));
  assert.equal((await boss.get(`${AP}/requests/PRQ-NOPE`)).status, 404);
});

test('status transitions are validated; reasons mandatory; payment statuses and Certificate Issued cannot be set', async () => {
  const st = (to, extra = {}, id = reqId) => boss.post(`${AP}/requests/${id}/status`, { to, ...extra });
  assert.equal((await st('Approved for Issuance', { note: 'evidence evidence' })).data.error.code, 'INVALID_TRANSITION'); // Draft → Approved
  for (const to of ['Awaiting Payment', 'Payment Pending', 'Payment Verified', 'Refunded']) assert.equal((await st(to)).data.error.code, 'PAYMENT_STAGE_NOT_AVAILABLE', to);
  assert.equal((await st('Certificate Issued')).data.error.code, 'USE_ISSUE_ACTION');
  assert.equal((await st('Nonsense')).status, 400);
  assert.equal((await st('Rejected')).status, 400); assert.equal((await st('Rejected', { reason: 'short' })).status, 400);
  assert.equal((await st('Eligibility Check')).status, 200);
  assert.equal((await st('Draft')).data.error.code, 'INVALID_TRANSITION');
  const h = db.prepare('SELECT from_status, to_status, actor FROM priority_request_history WHERE request_id = ? ORDER BY id').all(reqId);
  assert.deepEqual(h.map((x) => x.to_status), ['Draft', 'Eligibility Check']); assert.equal(h[1].actor, 'admin');
});

test('eligibility: payment/status changes cannot override completion; an internship that is no longer completed cannot be approved', async () => {
  db.prepare("UPDATE enrollments SET status = 'Active', completed_at = NULL WHERE id = ?").run(enr.asha);
  const r = await boss.post(`${AP}/requests/${reqId}/status`, { to: 'Under Review' });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'NOT_ELIGIBLE');
  assert.equal(db.prepare('SELECT status FROM priority_requests WHERE id = ?').get(reqId).status, 'Eligibility Check');
  const rv = await boss.post(`${AP}/requests/${reqId}/review`); assert.equal(rv.data.eligible, false);
  complete(enr.asha);
  assert.equal((await boss.post(`${AP}/requests/${reqId}/review`)).data.eligible, true);
});

test('completion evidence (task progress) is shown to the reviewing admin; the task gate itself is the Part 1 rule (evaluateTasks) covered by the stage09a tests', async () => {
  const t = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'student_tasks'").get().n; assert.equal(t, 1);
  // No tasks configured for this listing, so eligibility passes; the task gate itself is the same Stage 09A rule exercised in stage09a tests and by evaluate().
  assert.equal((await boss.get(`${AP}/requests/${reqId}`)).data.completionEvidence.taskRequirementsMet, true);
});

test('approval needs evidence note; full flow to issuance through the existing generator; student notified; everything audited', async () => {
  const st = (to, extra = {}) => boss.post(`${AP}/requests/${reqId}/status`, { to, ...extra });
  assert.equal((await st('Under Review')).status, 200);
  assert.equal((await st('Approved for Issuance')).status, 400); // evidence note mandatory
  assert.equal((await st('Approved for Issuance', { note: 'Completion, tasks and approval verified on the internship record.' })).status, 200);
  assert.equal((await asha.post(`${AP}/requests/${reqId}/issue`, {})).status, 403);
  const iss = await boss.post(`${AP}/requests/${reqId}/issue`, {}); assert.equal(iss.status, 200, JSON.stringify(iss.data));
  assert.equal(iss.data.request.status, 'Certificate Issued'); certDoc = iss.data.document;
  assert.match(certDoc.documentNumber, /^ELV-CRT-/);
  const notes = JSON.stringify((await asha.get('/student/notifications')).data);
  for (const t of ['Eligibility review completed', 'Your priority request is approved', 'Your certificate has been issued']) assert.ok(notes.includes(t), t);
  const a = actions().map((x) => x.action);
  for (const k of ['priority.eligibility_review', 'priority.status_change', 'priority.approve', 'priority.issue', 'priority.notify', 'certificate.issue']) assert.ok(a.includes(k), k);
  assert.equal((await st('Cancelled', { reason: 'cancelling a finished request' })).data.error.code, 'INVALID_TRANSITION'); // terminal
});

test('rejection: reason stored and shown to the student; internal notes are not', async () => {
  const d = await ravi.get(`${BASE}/requests`); const rid = d.data.requests[0].id;
  assert.equal((await boss.post(`${AP}/requests/${rid}/notes`, { note: 'internal only note' })).status, 200);
  assert.equal((await boss.post(`${AP}/requests/${rid}/status`, { to: 'Rejected', reason: 'Documents do not match the record.' })).status, 200);
  const hist = await ravi.get(`${BASE}/requests/${rid}/history`); assert.ok(JSON.stringify(hist.data).includes('Documents do not match'));
  assert.ok(!JSON.stringify(hist.data).includes('internal only note'));
  assert.ok(actions().some((x) => x.action === 'priority.reject' && x.target_id === rid));
  assert.ok(actions().some((x) => x.action === 'priority.note_add'));
});

test('free correction: validation, ownership, mandatory reason, no fee', async () => {
  const body = (o = {}) => ({ studentId: ids.asha, documentId: certDoc.id, category: 'student_name', corrected: { fullName: 'Asha V Verma' }, reason: 'Name was misspelled by ELVORA staff.', evidence: 'Government ID on file shows the corrected spelling.', confirm: true, ...o });
  assert.equal((await boss.post(AP + '/corrections', body({ reason: '' }))).status, 400);
  assert.equal((await boss.post(AP + '/corrections', body({ reason: 'short' }))).status, 400);
  assert.equal((await boss.post(AP + '/corrections', body({ evidence: '' }))).status, 400);
  assert.equal((await boss.post(AP + '/corrections', body({ confirm: false }))).status, 400);
  assert.equal((await boss.post(AP + '/corrections', body({ category: 'other' }))).status, 400);
  assert.equal((await boss.post(AP + '/corrections', body({ studentId: ids.ravi }))).data.error.code, 'OWNERSHIP_MISMATCH');
  assert.equal((await boss.post(AP + '/corrections', body({ corrected: { fullName: 'Asha Verma' } }))).status, 400); // no change
  assert.equal((await boss.post(AP + '/corrections', body({ fee: 500, feePaise: 500 }))).status, 201); // a client-sent fee is ignored
  const c = db.prepare('SELECT * FROM free_corrections').get(); assert.equal(c.fee_paise, 0); assert.equal(c.status, 'Pending Approval');
  assert.throws(() => db.prepare('UPDATE free_corrections SET fee_paise = 100').run());
  assert.equal((await boss.post(AP + '/corrections', body())).data.error.code, 'CORRECTION_OPEN');
  assert.ok(JSON.stringify((await asha.get('/student/notifications')).data).includes('A free correction was started'));
  assert.equal((await boss.get(AP + '/corrections')).data.corrections[0].free, true);
});

test('date corrections cannot manufacture or shorten an internship', async () => {
  const other = db.prepare("SELECT id FROM free_corrections LIMIT 1").get().id;
  db.prepare("UPDATE free_corrections SET status = 'Cancelled' WHERE id = ?").run(other); // free the document for new corrections
  const mk = (corrected) => boss.post(AP + '/corrections', { studentId: ids.asha, documentId: certDoc.id, category: 'internship_dates', corrected, reason: 'Dates were entered wrongly by ELVORA.', evidence: 'Signed attendance register.', confirm: true });
  assert.equal((await mk({ completedAt: '2026-01-06' })).data.error.code, 'DURATION_NOT_MET');
  assert.equal((await mk({ completedAt: '2025-12-01' })).data.error.code, 'COMPLETION_BEFORE_START');
  assert.equal((await mk({ completedAt: '2999-01-01' })).data.error.code, 'FUTURE_DATE');
  assert.equal((await mk({ startDate: 'not-a-date' })).status, 400);
  db.prepare("UPDATE free_corrections SET status = 'Pending Approval' WHERE id = ?").run(other);
});

test('reissue: original preserved, replacement has new number + reference, old is superseded, verification reflects it', async () => {
  const before = db.prepare('SELECT * FROM documents WHERE id = ?').get(certDoc.id);
  const cid = db.prepare("SELECT id FROM free_corrections WHERE status = 'Pending Approval'").get().id;
  assert.equal((await asha.post(`${AP}/corrections/${cid}/approve`, {})).status, 403);
  const r = await checker.post(`${AP}/corrections/${cid}/approve`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = r.data.correction; assert.equal(c.status, 'Reissued'); assert.equal(c.free, true);
  const oldDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(certDoc.id); const newDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(c.replacementDocumentId);
  assert.equal(oldDoc.status, 'Revoked'); assert.match(oldDoc.revoked_reason, /Superseded/); assert.equal(oldDoc.storage_key, before.storage_key); assert.equal(oldDoc.sha256, before.sha256); // untouched
  assert.ok(fs.existsSync(path.join(dir, 'documents', `${oldDoc.storage_key}.pdf`)));
  assert.equal(newDoc.status, 'Issued'); assert.notEqual(newDoc.document_number, oldDoc.document_number); assert.notEqual(newDoc.verification_code, oldDoc.verification_code);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE enrollment_id = ? AND type = 'certificate' AND status = 'Issued'").get(enr.asha).n, 1); // never two current documents
  assert.equal(db.prepare('SELECT certificate_id FROM enrollments WHERE id = ?').get(enr.asha).certificate_id, newDoc.id);
  assert.equal(JSON.parse(newDoc.snapshot).student.fullName, 'Asha V Verma'); assert.equal(JSON.parse(oldDoc.snapshot).student.fullName, 'Asha Verma');
  assert.deepEqual(c.originalValues, { fullName: 'Asha Verma' }); assert.deepEqual(c.correctedValues, { fullName: 'Asha V Verma' });
  const vOld = await verify(oldDoc.verification_code); const vNew = await verify(newDoc.verification_code);
  assert.equal(vOld.data.result, 'superseded'); assert.equal(vOld.data.document.valid, false); assert.equal(vOld.data.document.replacedByReference, newDoc.verification_code);
  assert.equal(vNew.data.result, 'valid'); assert.equal(vNew.data.document.studentName, 'Asha V Verma');
  const a = actions(); for (const k of ['correction.create', 'correction.approve', 'correction.reissue', 'document.supersede']) assert.ok(a.some((x) => x.action === k), k);
  assert.ok(JSON.stringify((await asha.get('/student/notifications')).data).includes('Your corrected certificate is ready'));
  assert.equal((await checker.post(`${AP}/corrections/${cid}/approve`, {})).data.error.code, 'INVALID_STATE'); // can't reissue twice
  const mine = await asha.get(BASE + '/corrections'); assert.equal(mine.data.corrections[0].status, 'Reissued'); assert.equal(mine.data.corrections[0].reason, undefined); assert.equal(mine.data.corrections[0].createdByName, undefined);
  assert.equal((await ravi.get(BASE + '/corrections')).data.corrections.length, 0);
  assert.equal((await anon.get(BASE + '/corrections')).status, 401);
  certDoc = { id: newDoc.id };
});

test('failed document generation leaves every existing record untouched and can be cancelled', async () => {
  const ok = await boss.post(AP + '/corrections', { studentId: ids.asha, documentId: certDoc.id, category: 'student_name', corrected: { fullName: '李明李明' }, reason: 'Name needs a script the template cannot print.', evidence: 'ID card copy supplied.', confirm: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.data)); const cid = ok.data.correction.id;
  const snap = () => JSON.stringify([db.prepare('SELECT id, status, storage_key, sha256 FROM documents ORDER BY id').all(), db.prepare('SELECT full_name FROM students WHERE id = ?').get(ids.asha), db.prepare('SELECT certificate_id FROM enrollments WHERE id = ?').get(enr.asha)]);
  const b = snap(); const files = fs.readdirSync(path.join(dir, 'documents')).length;
  const r = await checker.post(`${AP}/corrections/${cid}/approve`, {});
  assert.ok(r.status >= 400, `expected failure, got ${r.status}`);
  assert.equal(snap(), b); assert.equal(fs.readdirSync(path.join(dir, 'documents')).length, files); // no orphan file
  assert.equal(db.prepare('SELECT status FROM free_corrections WHERE id = ?').get(cid).status, 'Failed');
  assert.equal((await boss.post(`${AP}/corrections/${cid}/cancel`, { reason: 'x' })).status, 400);
  assert.equal((await boss.post(`${AP}/corrections/${cid}/cancel`, { reason: 'Cannot be printed; will use a transliteration.' })).data.correction.status, 'Cancelled');
  assert.ok(actions().some((x) => x.action === 'correction.reissue' && x.result === 'failure'));
});

test('regeneration categories refuse when the verified records produce the same certificate', async () => {
  const r = await boss.post(AP + '/corrections', { studentId: ids.asha, documentId: certDoc.id, category: 'document_service_error', reason: 'Document service printed a wrong value.', evidence: 'Screenshot of the error.', confirm: true });
  assert.equal(r.status, 201); const a = await checker.post(`${AP}/corrections/${r.data.correction.id}/approve`, {});
  assert.equal(a.data.error.code, 'NO_DIFFERENCE');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE status = 'Issued'").get().n, 1);
});

test('audit log and history tables are append-only; student view hides internal data', async () => {
  assert.throws(() => db.prepare('UPDATE audit_logs SET reason = ?').run('x')); assert.throws(() => db.prepare('DELETE FROM audit_logs').run());
  assert.throws(() => db.prepare('DELETE FROM document_replacements').run()); assert.throws(() => db.prepare('UPDATE free_correction_history SET note = ?').run('x'));
  assert.throws(() => db.prepare('DELETE FROM priority_request_notes').run());
  const rows = db.prepare('SELECT admin_name, actor_type FROM audit_logs WHERE action = ?').all('correction.approve'); assert.ok(rows.every((x) => x.actor_type === 'admin' && x.admin_name === 'Checker Admin')); // Stage 10C Part 2: the approver is a second administrator, never the creator (Boss Admin)
  const s = JSON.stringify((await asha.get(`${BASE}/requests/${reqId}`)).data); assert.ok(!s.includes('audit')); assert.ok(!s.includes('Boss Admin'));
});
