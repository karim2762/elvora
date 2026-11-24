// Stage 10C Part 2 — certificate corrections: the 'certificate.correct' permission, separation of duties (creator can never approve), approval records,
// pending-when-alone behaviour, and the super-administrator permission script (audited, no HTTP route). MOCKED payments only; nothing here proves real money moved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { client } from './helpers.js';
import { setup } from './stage10c.payfixture.js';

const AC = '/admin/priority-certificates';
const PERM = 'certificate.correct';
let x, second, noPerm, payBoss, s1, s2;

const body = (st, over = {}) => ({ studentId: st.id, documentId: st.docId, category: 'student_name', corrected: { fullName: `${st.name} Corrected` }, reason: 'Name was misspelled by ELVORA staff.', evidence: 'Government ID on file shows the corrected spelling.', confirm: true, ...over });
const auditRows = (action, result) => x.db.prepare('SELECT admin_id, admin_name, target_id, result, reason FROM audit_logs WHERE action = ?' + (result ? ' AND result = ?' : '')).all(...(result ? [action, result] : [action]));
// A student with a CONFIRMED payment taken through the normal review → approval → issuance steps, so a real issued certificate exists to correct.
async function certified(tag, utr) {
  const st = await x.confirmed(tag, utr);
  const to = (t, extra = {}) => x.boss.post(`${AC}/requests/${st.reqId}/status`, { to: t, ...extra });
  assert.equal((await x.boss.post(`${AC}/requests/${st.reqId}/review`)).data.eligible, true);
  assert.equal((await to('Under Review')).status, 200);
  assert.equal((await to('Approved for Issuance', { note: 'Completion, tasks and approval verified on the internship record.' })).status, 200);
  const iss = await x.boss.post(`${AC}/requests/${st.reqId}/issue`, {}); assert.equal(iss.status, 200, JSON.stringify(iss.data));
  st.docId = iss.data.document.id; return st;
}

before(async () => {
  x = await setup({ PAYMENT_ADMIN_EMAILS: 'boss@example.com,payboss@example.com' });
  assert.equal((await x.configure()).status, 200);
  second = await x.makeAdmin('second@example.com', 'Second Admin', [PERM]);
  noPerm = await x.makeAdmin('noperm@example.com', 'No Perm Admin', ['payment.review']); // other permissions do not help
  payBoss = await x.makeAdmin('payboss@example.com', 'Payment Bootstrap Admin'); // listed in PAYMENT_ADMIN_EMAILS: every PAYMENT permission, but never this one
  s1 = await certified('alpha', 'COR000000001'); s2 = await certified('bravo', 'COR000000002');
});
after(async () => { await x.close(); });

test('permission: every correction route refuses anonymous, student, shared-key and administrators without certificate.correct; the payment bootstrap list does not imply it', async () => {
  const create = await x.boss.post(`${AC}/corrections`, body(s1)); assert.equal(create.status, 201, JSON.stringify(create.data)); const cid = create.data.correction.id;
  const routes = [['get', `${AC}/corrections`], ['get', `${AC}/corrections/${cid}`], ['get', `${AC}/corrections/students/${s1.id}/certificates`], ['post', `${AC}/corrections`, body(s2)], ['post', `${AC}/corrections/${cid}/approve`, {}], ['post', `${AC}/corrections/${cid}/cancel`, { reason: 'Withdrawn by the requester.' }]];
  for (const [m, p, b] of routes) {
    assert.equal((await client(x.srv.base)[m](p, b)).status, 401, `anonymous ${m} ${p}`);
    assert.equal((await s1.c[m](p, b)).status, 403, `student ${m} ${p}`);
    assert.equal((await client(x.srv.base)[m](p, b, { 'X-Admin-Key': 'k'.repeat(40) })).status, 401, `shared key ${m} ${p}`);
    for (const [who, label] of [[noPerm, 'admin with other permissions'], [payBoss, 'payment bootstrap admin']]) {
      const r = await who[m](p, b); assert.equal(r.status, 403, `${label} ${m} ${p}`); assert.equal(r.data.error.code, 'PERMISSION_REQUIRED');
    }
  }
  assert.equal(x.row('free_corrections', 'id = ?', cid).status, 'Pending Approval', 'refused calls changed nothing');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM free_corrections').get().n, 1, 'refused create calls created nothing');
  for (const who of [x.boss, second]) assert.equal((await who.get(`${AC}/corrections`)).status, 200);
  assert.ok(auditRows('admin.access_denied', 'failure').some((r) => r.target_id === PERM), 'the refusal is audited');
  assert.equal((await x.boss.get(`/admin/priority-payments/permissions`)).data.permissions.includes(PERM), false, 'payment permission list is unchanged');
});

test('separation of duties: the creator cannot approve; nothing changes; a second authorized administrator can; both are recorded', async () => {
  const c = x.row('free_corrections', "status = 'Pending Approval'"); assert.equal(c.created_by, x.boss.id); assert.equal(c.created_by_name, 'Boss Admin'); assert.equal(c.approved_by, null); assert.equal(c.approved_at, null);
  const docsBefore = JSON.stringify(x.db.prepare('SELECT id, status, storage_key, sha256 FROM documents ORDER BY id').all());
  const refused = await x.boss.post(`${AC}/corrections/${c.id}/approve`, {});
  assert.equal(refused.status, 403); assert.equal(refused.data.error.code, 'SELF_APPROVAL_FORBIDDEN'); assert.match(refused.data.error.message, /second authorized administrator/i);
  assert.equal(x.row('free_corrections', 'id = ?', c.id).status, 'Pending Approval'); assert.equal(JSON.stringify(x.db.prepare('SELECT id, status, storage_key, sha256 FROM documents ORDER BY id').all()), docsBefore, 'no document was touched');
  assert.ok(auditRows('correction.approve', 'failure').some((r) => r.target_id === c.id && r.admin_id === x.boss.id && /self-approval refused/.test(r.reason)), 'the refused self-approval is audited and survives');
  const ok = await second.post(`${AC}/corrections/${c.id}/approve`, {}); assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.correction.status, 'Reissued');
  const row = x.row('free_corrections', 'id = ?', c.id);
  assert.equal(row.created_by, x.boss.id); assert.equal(row.approved_by, second.id); assert.notEqual(row.created_by, row.approved_by);
  assert.equal(row.approved_by_name, 'Second Admin'); assert.match(row.approved_at, /^\d{4}-\d\d-\d\dT/); assert.ok(row.approved_at >= row.created_at);
  assert.equal(ok.data.correction.approvedBy, second.id); assert.equal(ok.data.correction.createdBy, x.boss.id); assert.ok(ok.data.correction.approvedAt);
  const oldDoc = x.row('documents', 'id = ?', s1.docId); assert.equal(oldDoc.status, 'Revoked', 'the original is superseded, never deleted'); assert.ok(oldDoc.storage_key);
  assert.equal(x.row('document_replacements', 'old_document_id = ?', s1.docId).new_document_id, row.replacement_document_id);
  const approveAudit = auditRows('correction.approve', 'success').find((r) => r.target_id === c.id); assert.equal(approveAudit.admin_id, second.id); assert.match(approveAudit.reason, new RegExp(`created by ${x.boss.id}.*approved by ${second.id}`));
  const mine = (await s1.c.get('/priority-certificate/corrections')).data.corrections[0]; for (const k of ['createdByName', 'approvedByName', 'approvedBy', 'createdBy', 'approvedAt']) assert.equal(mine[k], undefined, `student view hides ${k}`);
});

test('a lone authorized administrator cannot self-approve: the request stays pending, and is never silently bypassed', async () => {
  x.payDb.revokePermission(second.id, PERM); // only the creator now holds the permission
  const create = await x.boss.post(`${AC}/corrections`, body(s2)); assert.equal(create.status, 201, JSON.stringify(create.data)); const cid = create.data.correction.id;
  assert.equal((await second.post(`${AC}/corrections/${cid}/approve`, {})).data.error.code, 'PERMISSION_REQUIRED', 'revocation takes effect immediately');
  assert.equal((await x.boss.post(`${AC}/corrections/${cid}/approve`, {})).data.error.code, 'SELF_APPROVAL_FORBIDDEN');
  assert.equal(x.row('free_corrections', 'id = ?', cid).status, 'Pending Approval'); assert.equal(x.row('documents', 'id = ?', s2.docId).status, 'Issued', 'the original certificate is untouched');
  assert.equal(x.row('free_corrections', 'id = ?', cid).approved_by, null);
  // the creator may still withdraw their own request; a withdrawn request frees the document for a new correction
  assert.equal((await x.boss.post(`${AC}/corrections/${cid}/cancel`, { reason: 'Withdrawn: waiting for a second approver.' })).data.correction.status, 'Cancelled');
  const again = await x.boss.post(`${AC}/corrections`, body(s2)); assert.equal(again.status, 201); const cid2 = again.data.correction.id;
  x.payDb.grantPermission(second.id, PERM, 'test'); // a second authorized administrator becomes available
  const ok = await second.post(`${AC}/corrections/${cid2}/approve`, {}); assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.correction.status, 'Reissued');
});

test('eligibility is still enforced: a correction cannot reissue once the certificate stops being eligible, whoever approves it', async () => {
  const s3 = await certified('charlie', 'COR000000003');
  const create = await x.boss.post(`${AC}/corrections`, body(s3)); assert.equal(create.status, 201, JSON.stringify(create.data)); const cid = create.data.correction.id;
  x.db.prepare("UPDATE enrollments SET certificate_decision = 'Declined' WHERE id = ?").run(s3.enrId); // an administrator declined the certificate after issuance
  const r = await second.post(`${AC}/corrections/${cid}/approve`, {}); assert.ok(r.status >= 400, `expected a refusal, got ${r.status}`);
  assert.equal(x.row('documents', 'id = ?', s3.docId).status, 'Issued', 'no replacement, original untouched'); assert.equal(x.row('free_corrections', 'id = ?', cid).status, 'Failed');
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM documents WHERE enrollment_id = ? AND type = 'certificate' AND status = 'Issued'").get(s3.enrId).n, 1);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM payment_transactions').get().n >= 3, true, 'a correction never touches payment records');
});

test('permission script: only a listed super administrator may grant or revoke; every change is audited; no HTTP route changes permissions', () => {
  // 1. no HTTP route can change permissions
  const routeSrc = ['adminPayments.js', 'adminPriority.js', 'admin.js'].map((f) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', f), 'utf8')).join('\n');
  assert.equal(/grantPermission|revokePermission/.test(routeSrc), false, 'no route grants or revokes permissions');
  // 2. the script, run for real against a throwaway file database
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); const dbFile = path.join(x.dir, 'perm-script.db');
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: `file:${dbFile}`, SESSION_SECRET: 'test-secret-test-secret-test-secret-1234', SUPER_ADMIN_EMAILS: 'super@example.com', PAYMENT_ADMIN_EMAILS: '' };
  const run = (...args) => spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'certificate-permission.mjs'), ...args], { env, encoding: 'utf8', cwd: root });
  spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(path.join(root, 'server/src/db/index.js'))})`], { env, encoding: 'utf8' }); // create + migrate the file database
  const raw = new DatabaseSync(dbFile); const now = new Date().toISOString();
  for (const [id, email, role] of [['SUP', 'super@example.com', 'admin'], ['ADM1', 'one@example.com', 'admin'], ['ADM2', 'two@example.com', 'admin'], ['REG', 'plain@example.com', 'admin'], ['STU', 'stud@example.com', 'student']]) {
    raw.prepare("INSERT INTO students (id, full_name, email, phone, password_hash, college, degree, branch, academic_year, graduation_year, role, created_at, updated_at) VALUES (?, ?, ?, '1', 'x', 'c', 'd', 'b', '1', '2027', ?, ?, ?)").run(id, id, email, role, now, now);
  }
  const holders = () => raw.prepare("SELECT admin_id FROM admin_permissions WHERE permission = 'certificate.correct' ORDER BY admin_id").all().map((r) => r.admin_id);
  const audits = (a) => raw.prepare('SELECT admin_id, result, reason FROM audit_logs WHERE action = ?').all(a);
  // refused: caller is not a super administrator (an ordinary administrator), a non-admin, an unknown account
  for (const by of ['one@example.com', 'stud@example.com', 'nobody@example.com']) { const r = run('grant', 'two@example.com', '--by', by); assert.notEqual(r.status, 0, `by ${by}`); assert.match(r.stderr, /not a super administrator/); }
  assert.deepEqual(holders(), [], 'nothing changed'); assert.ok(audits('admin.access_denied').length >= 3, 'refused attempts are audited');
  // refused: the target must be an administrator
  assert.notEqual(run('grant', 'stud@example.com', '--by', 'super@example.com').status, 0);
  // grant, idempotent grant, revoke
  assert.equal(run('grant', 'one@example.com', '--by', 'super@example.com').status, 0); assert.equal(run('grant', 'two@example.com', '--by', 'super@example.com').status, 0);
  assert.deepEqual(holders(), ['ADM1', 'ADM2']); assert.equal(audits('permission.grant').length, 2); assert.ok(audits('permission.grant').every((a) => a.admin_id === 'SUP' && a.result === 'success'));
  assert.match(run('grant', 'one@example.com', '--by', 'super@example.com').stdout, /already holds/); assert.equal(audits('permission.grant').length, 2, 'a no-op is not logged as a change');
  const rev = run('revoke', 'two@example.com', '--by', 'super@example.com'); assert.equal(rev.status, 0); assert.match(rev.stderr, /Warning: 1 administrator/); assert.deepEqual(holders(), ['ADM1']); assert.equal(audits('permission.revoke').length, 1);
  assert.match(run('list', '--by', 'super@example.com').stdout, /one@example\.com/);
  // with SUPER_ADMIN_EMAILS empty the script refuses everything
  env.SUPER_ADMIN_EMAILS = ''; const none = run('grant', 'two@example.com', '--by', 'super@example.com'); assert.notEqual(none.status, 0); assert.match(none.stderr, /SUPER_ADMIN_EMAILS is empty/); assert.deepEqual(holders(), ['ADM1']);
  raw.close();
});
