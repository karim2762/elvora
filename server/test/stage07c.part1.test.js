// Stage 07C (part 1): document management, announcements, audit log, settings. Real HTTP against the real app + in-memory database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'a-long-random-admin-key-for-tests-1234567890';
const keyH = { 'X-Admin-Key': KEY };
const PW = 'Str0ng!Pass1';
let srv, dir, db, anon, boss, boss2, asha, ravi, sam, ashaApp, ashaEnr, ravi2Enr;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const rawFetch = (method, p, body, headers = {}, cookie = '') => fetch(srv.base + p, { method, headers: { ...(cookie ? { cookie } : {}), ...headers }, body });
const audit = (q = '') => boss.get(`/admin/audit-logs?pageSize=100${q}`);
const auditActions = async (q = '') => (await audit(q)).data.events.map((e) => `${e.action}:${e.result}`);

const sessionCookie = async () => (await fetch(`${srv.base}/auth/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'boss@example.com', password: PW }) })).headers.getSetCookie()[0].split(';')[0];
async function makeAdmin(email, name) {
  const c = client(srv.base);
  assert.equal((await c.post('/auth/register', validStudent({ email, fullName: name }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail(email).id, 'admin');
  assert.equal((await c.post('/auth/admin/login', { email, password: PW })).status, 200);
  return c;
}
// student applies → admin approves → internship created. Returns { appId, enrId }.
async function enroll(c, over = {}, enrollBody = {}) {
  const a = await c.post('/applications', validApplication(over));
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const appId = a.data.application.id;
  assert.equal((await boss.patch(`/admin/applications/${appId}/status`, { status: 'Approved', note: 'Looks good' })).status, 200);
  const e = await boss.post(`/admin/applications/${appId}/internship`, enrollBody);
  assert.equal(e.status, 201, JSON.stringify(e.data));
  return { appId, enrId: e.data.internship.id };
}
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function finish(enrId, { approve = true } = {}) {
  assert.equal((await boss.patch(`/admin/internships/${enrId}/activate`, { startDate: day(-10), expectedEndDate: day(20) })).status, 200);
  assert.equal((await boss.patch(`/admin/internships/${enrId}/progress`, { progressPercent: 100 })).status, 200);
  const c = await boss.patch(`/admin/internships/${enrId}/complete`, { confirmReviewed: true, note: 'Done' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  if (approve) assert.equal((await boss.patch(`/admin/internships/${enrId}/certificate-decision`, { decision: 'Approved' })).status, 200);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-07c-'));
  srv = await startServer({ ADMIN_API_KEY: KEY, DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000',
    ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Priya Rao', ORG_SIGNATORY_TITLE: 'Director',
    ORG_REGISTRATION_LABEL: 'Udyam', ORG_REGISTRATION_NUMBER: 'UDYAM-XX-00-0000000', ORG_REGISTRATION_VERIFIED: 'false' });
  ({ db } = await import('../src/db/index.js'));
  [anon, asha, ravi, sam] = [1, 2, 3, 4].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  assert.equal((await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar', degree: 'MCA', academicYear: '1st Year' }))).status, 201);
  assert.equal((await sam.post('/auth/register', validStudent({ email: 'sam@example.com', fullName: 'Sam Roy', degree: 'MCA', academicYear: '2nd Year' }))).status, 201);
  boss = await makeAdmin('boss@example.com', 'Boss Admin');
  boss2 = await makeAdmin('boss2@example.com', 'Second Admin');
  const a = await enroll(asha); ashaApp = a.appId; ashaEnr = a.enrId;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- audit foundation
test('migration 12 created audit_logs, platform_settings and announcements; audit_logs is append-only at the database level', () => {
  assert.ok(db.pragma('user_version', { simple: true }) >= 12); // later stages add migrations (13 = Stage 08A indexes)
  for (const t of ['audit_logs', 'platform_settings', 'announcements']) assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), t);
  const row = db.prepare('SELECT id FROM audit_logs LIMIT 1').get();
  assert.ok(row, 'earlier test steps already produced audit rows');
  assert.throws(() => db.prepare("UPDATE audit_logs SET result = 'failure' WHERE id = ?").run(row.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_logs WHERE id = ?').run(row.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_logs').run(), /append-only/);
});

test('audit: login, application approval, internship creation flow were recorded with admin reference, target, timestamp and result', async () => {
  const r = await audit();
  assert.equal(r.status, 200);
  const ev = r.data.events;
  const login = ev.find((e) => e.action === 'admin.login' && e.adminName === 'Boss Admin');
  assert.ok(login && login.result === 'success' && /^AUD-[0-9A-F]{12}$/.test(login.id) && login.adminId && login.timestamp);
  const appr = ev.find((e) => e.action === 'application.status_change');
  assert.equal(appr.relatedId, ashaApp); assert.equal(appr.relatedType, 'application'); assert.match(appr.reason, /Submitted → Approved — Looks good/);
});

test('audit never stores passwords, tokens or e-mail addresses', async () => {
  await client(srv.base).post('/auth/admin/login', { email: 'boss@example.com', password: 'Wrong!Pass999' }); // failed login for a real admin
  const all = JSON.stringify((await audit()).data.events);
  for (const secret of [PW, 'Wrong!Pass999', 'boss@example.com', 'ravi@example.com', 'elvora_session', KEY]) assert.ok(!all.includes(secret), secret);
  const failed = (await audit('&action=admin.login&result=failure')).data.events;
  assert.equal(failed.length, 1); assert.equal(failed[0].reason, 'Incorrect password');
});

test('audit: unknown email and student accounts on the admin login are NOT logged (no enumeration, no noise)', async () => {
  const before = (await audit()).data.pagination.total;
  await client(srv.base).post('/auth/admin/login', { email: 'nobody@example.com', password: 'Wrong!Pass999' });
  await client(srv.base).post('/auth/admin/login', { email: 'ravi@example.com', password: 'Wrong!Pass999' });
  assert.equal((await audit()).data.pagination.total, before);
});

test('audit: logout is recorded for administrators', async () => {
  const c = await makeAdmin('temp@example.com', 'Temp Admin');
  assert.equal((await c.post('/auth/logout')).status, 204);
  const ev = (await audit('&action=admin.logout')).data.events;
  assert.ok(ev.some((e) => e.adminName === 'Temp Admin'));
});

test('audit access: anonymous, students and the shared key cannot read it; no route can write, edit or delete it', async () => {
  assert.equal((await anon.get('/admin/audit-logs')).status, 401);
  assert.ok([401, 403].includes((await asha.get('/admin/audit-logs')).status));
  assert.equal((await anon.get('/admin/audit-logs', keyH)).status, 401);
  const id = (await audit()).data.events[0].id;
  for (const [m, p] of [['POST', '/admin/audit-logs'], ['PUT', `/admin/audit-logs/${id}`], ['PATCH', `/admin/audit-logs/${id}`], ['DELETE', `/admin/audit-logs/${id}`], ['DELETE', '/admin/audit-logs']]) {
    const res = await fetch(srv.base + p, { method: m, headers: { 'Content-Type': 'application/json', cookie: await sessionCookie() }, body: m === 'DELETE' ? undefined : '{}' }); // even a signed-in administrator
    assert.ok([404, 405].includes(res.status), `${m} ${p} -> ${res.status}`);
  }
  assert.ok((await audit()).data.events.some((e) => e.id === id), 'entry still exists');
});

test('audit: pagination and filters (action, date, admin, result) validate and work', async () => {
  const p1 = await boss.get('/admin/audit-logs?pageSize=2&page=1');
  assert.equal(p1.data.events.length, 2); assert.ok(p1.data.pagination.totalPages >= 2);
  const p2 = await boss.get('/admin/audit-logs?pageSize=2&page=2');
  assert.notEqual(p1.data.events[0].id, p2.data.events[0].id);
  assert.equal((await boss.get('/admin/audit-logs?pageSize=2&page=9999')).data.pagination.page, p1.data.pagination.totalPages); // clamped
  const byAction = (await audit('&action=application.status_change')).data.events;
  assert.ok(byAction.length >= 1 && byAction.every((e) => e.action === 'application.status_change'));
  const adminId = (await audit('&action=admin.login')).data.events.find((e) => e.adminName === 'Boss Admin').adminId;
  assert.ok((await audit(`&adminId=${adminId}`)).data.events.every((e) => e.adminId === adminId));
  const today = new Date().toISOString().slice(0, 10);
  assert.ok((await audit(`&from=${today}&to=${today}`)).data.events.length > 0);
  assert.equal((await audit('&from=2000-01-01&to=2000-01-02')).data.events.length, 0);
  assert.ok((await audit('&result=failure')).data.events.every((e) => e.result === 'failure'));
  for (const bad of ['&action=drop.table', '&result=maybe', '&from=2026-13-45', '&from=2026-05-02&to=2026-05-01', '&page=0', '&pageSize=500', '&pageSize=abc']) assert.equal((await boss.get(`/admin/audit-logs?${bad.slice(1)}`)).status, 400, bad);
});

test('audit: listing create/update/publish, student suspension and reactivation, internship activation/completion are recorded', async () => {
  const body = { title: 'Audit Test Internship', category: 'python-development', description: 'A listing used to verify audit logging works for listing changes.', durationDays: 30, skills: ['Python'], outcomes: ['Build a small tested Python project'], eligibility: { who: 'Any student who wants to learn Python' }, type: 'Project-Based', difficulty: 'Beginner' };
  const c = await boss.post('/admin/internship-listings', body);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.internship.id;
  assert.equal((await boss.patch(`/admin/internship-listings/${id}`, { description: 'Updated description for the audit logging test of listings.' })).status, 200);
  assert.equal((await boss.patch(`/admin/internship-listings/${id}/state`, { action: 'publish' })).status, 200);
  assert.equal((await boss.patch(`/admin/internship-listings/${id}/state`, { action: 'unpublish' })).status, 200);
  const sid = (await boss.get('/admin/students?q=ravi')).data.students[0].id;
  assert.equal((await boss.patch(`/admin/students/${sid}/status`, { status: 'suspended', reason: 'Policy breach' })).status, 200);
  assert.equal((await boss.patch(`/admin/students/${sid}/status`, { status: 'active' })).status, 200);
  const a = new Set(await auditActions());
  for (const x of ['listing.create:success', 'listing.update:success', 'listing.publish:success', 'listing.unpublish:success', 'student.suspend:success', 'student.reactivate:success']) assert.ok(a.has(x), x);
  const sus = (await audit('&action=student.suspend')).data.events[0];
  assert.equal(sus.relatedId, sid); assert.equal(sus.reason, 'Policy breach');
  // a refused change (invalid transition) leaves no success row
  const before = (await audit('&action=application.status_change')).data.pagination.total;
  assert.equal((await boss.patch(`/admin/applications/${ashaApp}/status`, { status: 'Rejected' })).status, 409);
  assert.equal((await audit('&action=application.status_change')).data.pagination.total, before);
});

test('audit: internship activation and completion are recorded (see document flow below)', async () => {
  await finish(ashaEnr);
  const a = new Set(await auditActions());
  assert.ok(a.has('internship.activate:success') && a.has('internship.complete:success'));
  const done = (await audit('&action=internship.complete')).data.events[0];
  assert.equal(done.relatedId, ashaEnr); assert.equal(done.adminName, 'Boss Admin');
});

// ---------------------------------------------------------------- documents
test('documents: anonymous and student callers cannot list, read, verify, view history, download, issue or revoke', async () => {
  const unauth = [['GET', '/admin/documents'], ['GET', '/admin/documents/ELV-DOC-AAAAAAAA'], ['GET', '/admin/documents/ELV-DOC-AAAAAAAA/verify'], ['GET', '/admin/documents/ELV-DOC-AAAAAAAA/history'],
    ['GET', '/admin/documents/ELV-DOC-AAAAAAAA/file'], ['POST', '/admin/documents/offer-letter'], ['POST', '/admin/documents/certificate'], ['PATCH', '/admin/documents/ELV-DOC-AAAAAAAA/revoke']];
  for (const [m, p] of unauth) {
    for (const [who, c, want] of [['anon', anon, [401]], ['student', asha, [403]]]) {
      const r = await c[m.toLowerCase()](p, m === 'GET' ? undefined : { internshipId: ashaEnr, reason: 'no' });
      assert.ok(want.includes(r.status), `${who} ${m} ${p} -> ${r.status}`);
    }
  }
  const r = await asha.post('/admin/documents/offer-letter', { internshipId: ashaEnr });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM documents').get()).n, 0, 'nothing was issued: ' + r.status);
});

let offerId, offerRef, certId;
test('offer letter: issued for an approved application through the Stage 06 generator; recorded in audit under the admin who did it', async () => {
  const r = await boss.post('/admin/documents/offer-letter', { internshipId: ashaEnr, issuedBy: 'Someone Else' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const d = r.data.document; offerId = d.id; offerRef = d.verificationCode;
  assert.equal(d.status, 'Issued'); assert.equal(d.type, 'offer_letter'); assert.equal(d.issuedBy, 'Boss Admin', 'the signed-in account name wins over a typed label');
  assert.ok(d.fileAvailable && d.documentNumber && /^ELV-VER-/.test(d.verificationCode) && !('storageKey' in d));
  const ev = (await audit('&action=offer_letter.issue')).data.events[0];
  assert.equal(ev.relatedId, offerId); assert.equal(ev.result, 'success'); assert.equal(ev.adminName, 'Boss Admin');
});

test('duplicate issuance is refused (409) and audited as a failure; only one live document exists', async () => {
  const r = await boss.post('/admin/documents/offer-letter', { internshipId: ashaEnr });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'DOCUMENT_EXISTS');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE enrollment_id = ? AND type = 'offer_letter'").get(ashaEnr).n, 1);
  const f = (await audit('&action=offer_letter.issue&result=failure')).data.events;
  assert.ok(f.length >= 1 && f[0].reason === 'DOCUMENT_EXISTS');
  // two concurrent requests: still exactly one document of that type
  const [x, y] = await Promise.all([1, 2].map(() => boss.post('/admin/documents/certificate', { internshipId: ashaEnr })));
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  certId = [x, y].find((q) => q.status === 201).data.document.id;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE enrollment_id = ? AND type = 'certificate'").get(ashaEnr).n, 1);
});

test('offer letter without an approved application is refused (409 APPLICATION_NOT_APPROVED) and nothing is created', async () => {
  assert.equal((await ravi.post('/auth/login', { email: 'ravi@example.com', password: PW })).status, 200); // suspended earlier (sessions cleared), reactivated since
  const { enrId, appId } = await enroll(ravi, { fullName: 'Ravi Kumar', degree: 'MCA', academicYear: '1st Year' });
  db.prepare("UPDATE applications SET status = 'Rejected' WHERE id = ?").run(appId); // the state the rule must catch
  const r = await boss.post('/admin/documents/offer-letter', { internshipId: enrId });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'APPLICATION_NOT_APPROVED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents WHERE enrollment_id = ?').get(enrId).n, 0);
  db.prepare("UPDATE applications SET status = 'Approved' WHERE id = ?").run(appId);
  ravi2Enr = enrId;
});

test('certificate without verified completion (not completed, or completed but not approved) is refused', async () => {
  let r = await boss.post('/admin/documents/certificate', { internshipId: ravi2Enr });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'ENROLLMENT_NOT_COMPLETED');
  await finish(ravi2Enr, { approve: false });
  r = await boss.post('/admin/documents/certificate', { internshipId: ravi2Enr });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'CERTIFICATE_NOT_APPROVED');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE enrollment_id = ? AND type = 'certificate'").get(ravi2Enr).n, 0);
  assert.equal((await boss.post('/admin/documents/certificate', { internshipId: 'ELV-INT-NOPE0000' })).status, 404);
  assert.equal((await boss.post('/admin/documents/certificate', {})).status, 400);
});

test('document list: search, filters, pagination; shows ID, type, student, internship, issue date, status, verification reference; no e-mail or storage key', async () => {
  const r = await boss.get('/admin/documents');
  assert.equal(r.status, 200);
  assert.equal(r.data.pagination.total, 2); assert.deepEqual(r.data.counts, { Issued: 2, Revoked: 0, Draft: 0 });
  const d = r.data.documents.find((x) => x.id === offerId);
  for (const k of ['id', 'type', 'studentName', 'internshipTitle', 'issuedAt', 'status', 'verificationCode']) assert.ok(d[k], k);
  assert.equal(d.studentName, 'Asha Verma');
  const raw = JSON.stringify(r.data); assert.ok(!raw.includes('asha@example.com') && !/storageKey/.test(raw));
  assert.equal((await boss.get('/admin/documents?q=asha')).data.documents.length, 2);
  assert.equal((await boss.get('/admin/documents?q=nobody')).data.documents.length, 0);
  assert.equal((await boss.get(`/admin/documents?q=${offerRef}`)).data.documents.length, 1);
  assert.equal((await boss.get(`/admin/documents?q=${d.documentNumber}`)).data.documents.length, 1);
  assert.equal((await boss.get('/admin/documents?q=Python')).data.documents.length, 2);
  assert.equal((await boss.get('/admin/documents?q=%25')).data.documents.length, 0, 'a % in the search text is literal, not a wildcard');
  assert.equal((await boss.get('/admin/documents?type=certificate')).data.documents.length, 1);
  assert.equal((await boss.get('/admin/documents?status=Revoked')).data.documents.length, 0);
  assert.equal((await boss.get('/admin/documents?pageSize=1&page=2')).data.documents.length, 1);
  for (const bad of ['type=letter', 'status=Gone', 'internshipId=bad', 'page=-1', 'pageSize=0']) assert.equal((await boss.get(`/admin/documents?${bad}`)).status, 400, bad);
});

test('document details, preview file, verification check and history', async () => {
  const d = (await boss.get(`/admin/documents/${offerId}`)).data.document;
  assert.ok(d.events.some((e) => e.event === 'issued'));
  const f = await fetch(`${srv.base}/admin/documents/${offerId}/file`, { headers: { cookie: '' , ...keyH } });
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await f.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const v = (await boss.get(`/admin/documents/${offerId}/verify`)).data.verification;
  assert.equal(v.status, 'Issued'); assert.equal(v.integrity.state, 'match'); assert.equal(v.publicVerification.result, 'valid'); assert.equal(v.verificationReference, offerRef);
  assert.match(v.verificationUrl, /\/verify\/ELV-VER-/);
  const h = (await boss.get(`/admin/documents/${offerId}/history`)).data;
  assert.ok(h.events.length >= 2 && h.audit.some((a) => a.action === 'offer_letter.issue') && h.sameInternship.length === 2);
  assert.equal((await boss.get('/admin/documents/not-an-id/verify')).status, 404);
  assert.equal((await boss.get('/admin/documents/ELV-DOC-AAAAAAAA/history')).status, 404);
});

test('document integrity check detects a tampered stored file', async () => {
  const key = db.prepare('SELECT storage_key FROM documents WHERE id = ?').get(certId).storage_key;
  const file = path.join(dir, 'documents', `${key}.pdf`); const orig = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([orig, Buffer.from('x')]));
  assert.equal((await boss.get(`/admin/documents/${certId}/verify`)).data.verification.integrity.state, 'mismatch');
  fs.writeFileSync(file, orig);
  assert.equal((await boss.get(`/admin/documents/${certId}/verify`)).data.verification.integrity.state, 'match');
});

test('revocation: reason is mandatory; students and anonymous callers cannot revoke; success is audited and the record is kept', async () => {
  for (const body of [{}, { reason: '' }, { reason: 'x' }, { reason: '   ' }, { reason: 'y'.repeat(301) }]) {
    const r = await boss.patch(`/admin/documents/${offerId}/revoke`, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 30)); assert.ok(r.data.error.fields.reason);
  }
  assert.equal((await asha.patch(`/admin/documents/${offerId}/revoke`, { reason: 'I want it gone' })).status, 403);
  assert.equal((await anon.patch(`/admin/documents/${offerId}/revoke`, { reason: 'I want it gone' })).status, 401);
  assert.equal((await boss.get(`/admin/documents/${offerId}`)).data.document.status, 'Issued');
  const r = await boss.patch(`/admin/documents/${offerId}/revoke`, { reason: 'Issued in error', revokedBy: 'Forged Name' });
  assert.equal(r.status, 200);
  assert.equal(r.data.document.status, 'Revoked'); assert.equal(r.data.document.revokedReason, 'Issued in error'); assert.equal(r.data.document.revokedBy, 'Boss Admin');
  const ev = (await audit('&action=document.revoke')).data.events;
  assert.equal(ev[0].relatedId, offerId); assert.equal(ev[0].reason, 'Issued in error'); assert.equal(ev[0].result, 'success');
  // history preserved: the row still exists and still lists; a second revoke is refused and audited as a failure
  assert.equal((await boss.get('/admin/documents?status=Revoked')).data.documents.length, 1);
  const again = await boss.patch(`/admin/documents/${offerId}/revoke`, { reason: 'Again please' });
  assert.equal(again.status, 409); assert.equal(again.data.error.code, 'ALREADY_REVOKED');
  assert.ok((await audit('&action=document.revoke&result=failure')).data.events.length >= 1);
  assert.equal((await boss.get(`/admin/documents/${offerId}/history`)).data.events.at(-1).event, 'revoked');
  // no delete route exists for documents
  assert.ok([404, 405].includes((await boss.del(`/admin/documents/${offerId}`)).status));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(offerId).n, 1);
});

test('public verification page shows REVOKED for the revoked document and VALID for the other; no private data', async () => {
  const rev = await (await fetch(`${srv.base}/public/documents/verify/${offerRef}`)).json();
  const body = JSON.stringify(rev);
  assert.match(body, /revoked/i); assert.ok(!/"valid":true/.test(body));
  assert.ok(!body.includes('Issued in error') && !body.includes('asha@example.com') && !body.includes('sha256'));
  const certRef = db.prepare('SELECT verification_code FROM documents WHERE id = ?').get(certId).verification_code;
  assert.match(JSON.stringify(await (await fetch(`${srv.base}/public/documents/verify/${certRef}`)).json()), /valid/i);
});

// ---------------------------------------------------------------- announcements
const ann = (over = {}) => ({ title: 'Platform maintenance', message: 'The platform will be briefly unavailable on Sunday morning.', confirm: true, confirmRecipientCount: 3, ...over });

test('announcements: anonymous, students and the shared admin key cannot preview, send, list or withdraw (nobody is messaged)', async () => {
  const n0 = db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
  for (const [who, c, h, want] of [['anon', anon, undefined, [401]], ['student', asha, undefined, [401, 403]], ['key', anon, keyH, [401]]]) {
    assert.ok(want.includes((await c.post('/admin/announcements', ann(), h)).status), `${who} send`);
    assert.ok(want.includes((await c.post('/admin/announcements/preview', ann(), h)).status), `${who} preview`);
    assert.ok(want.includes((await c.get('/admin/announcements', h)).status), `${who} list`);
    assert.ok(want.includes((await c.patch('/admin/announcements/ANN-0123456789/withdraw', { reason: 'nope nope' }, h)).status), `${who} withdraw`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, n0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n, 0);
});

test('announcements: invalid title/message/category/audience are rejected with field errors and nothing is sent', async () => {
  const bad = [[{ title: '' }, 'title'], [{ title: 'ab' }, 'title'], [{ title: 'x'.repeat(121) }, 'title'], [{ message: '' }, 'message'], [{ message: 'short' }, 'message'], [{ message: 'm'.repeat(1001) }, 'message'],
    [{ title: 123 }, 'title'], [{ category: 'spam' }, 'category'], [{ audience: { type: 'everyone' } }, 'audience'], [{ audience: { type: 'group' } }, 'audience'],
    [{ audience: { type: 'group', degree: 'PhD-ish' } }, 'audience'], [{ audience: { type: 'student', studentId: 'x' } }, 'audience']];
  for (const [over, field] of bad) { const r = await boss.post('/admin/announcements', ann(over)); assert.equal(r.status, 400, JSON.stringify(over).slice(0, 40)); assert.ok(r.data.error.fields[field], field); }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n, 0);
});

test('announcements: preview returns a recipient COUNT only (no names or e-mails); sending needs confirm:true and the matching count', async () => {
  const p = await boss.post('/admin/announcements/preview', ann({ confirm: undefined }));
  assert.equal(p.status, 200); assert.equal(p.data.recipientCount, 3);
  assert.ok(!JSON.stringify(p.data).includes('@'));
  for (const over of [{ confirm: undefined }, { confirm: false }, { confirm: 'true' }]) {
    const r = await boss.post('/admin/announcements', ann(over)); assert.equal(r.status, 400); assert.equal(r.data.error.code, 'CONFIRMATION_REQUIRED');
  }
  const wrong = await boss.post('/admin/announcements', ann({ confirmRecipientCount: 2 }));
  assert.equal(wrong.status, 409); assert.equal(wrong.data.error.code, 'RECIPIENT_COUNT_CHANGED'); assert.equal(wrong.data.error.details.recipientCount, 3);
  assert.equal((await boss.post('/admin/announcements', ann({ confirmRecipientCount: undefined }))).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n, 0);
});

let annId;
test('announcement to all students: delivered count is read back from real rows; admins excluded; audited (create + send)', async () => {
  const r = await boss.post('/admin/announcements', ann());
  assert.equal(r.status, 201, JSON.stringify(r.data));
  annId = r.data.announcement.id;
  assert.equal(r.data.delivered, 3); assert.equal(r.data.announcement.delivery.delivered, 3); assert.equal(r.data.announcement.delivery.emailed, 0); assert.equal(r.data.announcement.delivery.channel, 'in-app');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE announcement_id = ?").get(annId).n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications n JOIN students s ON s.id = n.student_id WHERE n.announcement_id = ? AND s.role = 'admin'").get(annId).n, 0);
  const mine = (await asha.get('/student/notifications?pageSize=50')).data.notifications.find((n) => n.title === 'Platform maintenance');
  assert.ok(mine && mine.type === 'announcement');
  const a = await auditActions();
  assert.ok(a.includes('announcement.create:success') && a.includes('announcement.send:success'));
  assert.ok(!JSON.stringify(r.data).includes('@'), 'no e-mail addresses in the response');
});

test('announcement: the same content sent again within 10 minutes is refused (double-click protection)', async () => {
  const r = await boss.post('/admin/announcements', ann());
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'DUPLICATE_ANNOUNCEMENT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n, 1);
});

test('announcement history: list, detail, read count is real, status filter', async () => {
  assert.equal((await asha.patch('/student/notifications/read-all')).status, 200);
  const d = (await boss.get(`/admin/announcements/${annId}`)).data.announcement;
  assert.equal(d.delivery.read, 1); assert.equal(d.delivery.delivered, 3); assert.equal(d.createdBy, 'Boss Admin');
  const l = (await boss.get('/admin/announcements')).data;
  assert.equal(l.announcements.length, 1); assert.equal(l.pagination.total, 1);
  assert.equal((await boss.get('/admin/announcements?status=Withdrawn')).data.announcements.length, 0);
  assert.equal((await boss.get('/admin/announcements?status=Bogus')).status, 400);
  assert.equal((await boss.get('/admin/announcements/bad-id')).status, 404);
});

test('announcement to a group (degree + year) and typed categories; suspended students are not eligible; zero recipients is refused', async () => {
  const group = { type: 'group', degree: 'MCA', academicYear: '1st Year' };
  const p = await boss.post('/admin/announcements/preview', ann({ audience: group }));
  assert.equal(p.data.recipientCount, 1);
  const r = await boss.post('/admin/announcements', ann({ title: 'Application update for MCA', category: 'application', audience: group, confirmRecipientCount: 1 }));
  assert.equal(r.status, 201); assert.equal(r.data.delivered, 1);
  assert.equal((await ravi.get('/student/notifications')).data.notifications.some((n) => n.type === 'application_update'), true);
  assert.equal((await asha.get('/student/notifications?pageSize=50')).data.notifications.some((n) => n.title === 'Application update for MCA'), false);
  const none = await boss.post('/admin/announcements', ann({ audience: { type: 'group', degree: 'MBA' }, confirmRecipientCount: 0 }));
  assert.equal(none.status, 409); assert.equal(none.data.error.code, 'NO_RECIPIENTS');
  const sid = (await boss.get('/admin/students?q=sam')).data.students[0].id;
  assert.equal((await boss.patch(`/admin/students/${sid}/status`, { status: 'suspended', reason: 'Temporary hold' })).status, 200);
  assert.equal((await boss.post('/admin/announcements/preview', ann({ audience: { type: 'all' } }))).data.recipientCount, 2);
  assert.equal((await boss.post('/admin/announcements/preview', ann({ audience: { type: 'student', studentId: sid } }))).data.recipientCount, 0);
  assert.equal((await boss.patch(`/admin/students/${sid}/status`, { status: 'active' })).status, 200);
  assert.equal((await boss.post('/admin/announcements/preview', ann({ audience: { type: 'student', studentId: '00000000-0000-4000-8000-000000000000' } }))).status, 404);
  for (const [cat, type] of [['important', 'platform_notice'], ['internship', 'internship_update'], ['document', 'document_update']]) {
    const x = await boss.post('/admin/announcements', ann({ title: `Notice ${cat}`, category: cat, audience: { type: 'student', studentId: sid }, confirmRecipientCount: 1 }));
    assert.equal(x.status, 201, cat);
    assert.equal(db.prepare('SELECT type FROM notifications WHERE announcement_id = ?').get(x.data.announcement.id).type, type);
  }
});

test('announcement withdrawal needs a reason, removes it from student inboxes, keeps the record, is audited and works once', async () => {
  assert.equal((await boss.patch(`/admin/announcements/${annId}/withdraw`, {})).status, 400);
  assert.equal((await boss.patch(`/admin/announcements/${annId}/withdraw`, { reason: 'x' })).status, 400);
  const r = await boss.patch(`/admin/announcements/${annId}/withdraw`, { reason: 'Sent by mistake' });
  assert.equal(r.status, 200); assert.equal(r.data.announcement.status, 'Withdrawn'); assert.equal(r.data.announcement.delivery.delivered, 0);
  assert.equal((await asha.get('/student/notifications?pageSize=50')).data.notifications.some((n) => n.title === 'Platform maintenance'), false);
  assert.equal((await boss.get('/admin/announcements?status=Withdrawn')).data.announcements.length, 1);
  assert.equal((await boss.patch(`/admin/announcements/${annId}/withdraw`, { reason: 'Again again' })).status, 409);
  assert.ok((await auditActions()).includes('announcement.withdraw:success'));
  assert.equal((await boss.patch('/admin/announcements/ANN-FFFFFFFFFF/withdraw', { reason: 'Does not exist' })).status, 404);
});

test('a failing audit write rolls the announcement back (critical operations never succeed silently without an audit row)', async () => {
  const n0 = db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n; const a0 = db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n;
  db.exec('ALTER TABLE audit_logs RENAME TO audit_logs_off');
  try {
    const r = await boss.post('/admin/announcements', ann({ title: 'Should not be sent', confirmRecipientCount: 3 }));
    assert.equal(r.status, 500, 'the request fails loudly instead of succeeding without an audit row');
  } finally { db.exec('ALTER TABLE audit_logs_off RENAME TO audit_logs'); }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, n0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n, a0);
  assert.equal((await boss.get('/admin/audit-logs')).status, 200, 'audit still works afterwards');
});

// ---------------------------------------------------------------- settings
test('settings: anonymous, students and the shared key cannot read or change them', async () => {
  for (const [c, h, want] of [[anon, undefined, [401]], [asha, undefined, [401, 403]], [anon, keyH, [401]]]) {
    assert.ok(want.includes((await c.get('/admin/settings', h)).status));
    assert.ok(want.includes((await c.patch('/admin/settings', { organizationName: 'Hacked Org' }, h)).status));
    assert.ok(want.includes((await c.del('/admin/settings/logo', h)).status));
  }
  assert.equal((await rawFetch('PUT', '/admin/settings/logo', png, { 'Content-Type': 'image/png', ...keyH })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM platform_settings').get().n, 0);
});

test('settings view: shows values with their source, readiness and NO secrets or registration number', async () => {
  const r = await boss.get('/admin/settings');
  assert.equal(r.status, 200);
  const s = r.data.settings;
  assert.equal(s.fields.organizationName.value, 'ELVORA'); assert.equal(s.fields.organizationName.source, 'environment');
  assert.equal(s.fields.contactEmail.value, 'docs@example.org');
  assert.equal(s.issuanceReadiness.ready, true); assert.equal(s.registration.shownOnDocuments, false);
  const raw = JSON.stringify(r.data);
  for (const secret of [KEY, 'UDYAM-XX-00-0000000', 'SESSION_SECRET', 'test-secret-test-secret']) assert.ok(!raw.includes(secret), secret);
  assert.ok(!/smtp|password|apiKey/i.test(raw.replace(/emailConfigured/g, '')));
});

test('settings validation: bad values, unknown keys, secrets and registration claims are rejected; nothing is saved', async () => {
  const cases = [{ contactEmail: 'not-an-email' }, { website: 'javascript:alert(1)' }, { website: 'ftp://example.com' }, { website: 'example.com' }, { colorPrimary: 'blue' }, { colorInk: '#12345' },
    { organizationName: 'A' }, { organizationName: 'N'.repeat(101) }, { address: 'short' }, { signatoryName: 'X' }, { signatureEnabled: 'yes' }, { documentFooter: 'f'.repeat(201) }, { organizationName: 42 },
    { registrationNumber: 'UDYAM-FAKE' }, { registrationVerified: true }, { registrationLabel: 'MSME' }, { adminApiKey: 'x'.repeat(40) }, { smtpPassword: 'hunter2' }, { role: 'admin' }, { logoPath: '../../etc/passwd' }, { ORG_ADDRESS: 'x' }, {}];
  for (const body of cases) { const r = await boss.patch('/admin/settings', body); assert.equal(r.status, 400, JSON.stringify(body)); }
  assert.equal((await boss.patch('/admin/settings', [])).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM platform_settings').get().n, 0);
  assert.equal((await auditActions('&action=settings.update')).length, 0);
});

test('settings update: saved, audited (setting NAMES only), reflected on documents and previews; empty value reverts to the environment default', async () => {
  const r = await boss.patch('/admin/settings', { organizationName: '  Elvora   Labs  ', contactEmail: 'hello@elvora.example', website: 'https://elvora.example', colorPrimary: '#aa22cc', signatoryTitle: 'Managing Director', documentFooter: 'Official document' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.settings.changed.sort(), ['colorPrimary', 'contactEmail', 'documentFooter', 'organizationName', 'signatoryTitle', 'website']);
  const s = r.data.settings.fields;
  assert.equal(s.organizationName.value, 'Elvora Labs'); assert.equal(s.organizationName.source, 'settings'); assert.equal(s.colorPrimary.value, '#AA22CC');
  const ev = (await audit('&action=settings.update')).data.events;
  assert.equal(ev.length, 1); assert.match(ev[0].reason, /organizationName/); assert.ok(!ev[0].reason.includes('Elvora Labs') && !ev[0].reason.includes('hello@'));
  const { getOrganization } = await import('../src/documents/organization.js');
  assert.equal(getOrganization().name, 'Elvora Labs'); assert.equal(getOrganization().colors.primary, '#AA22CC'); assert.equal(getOrganization().signatory.title, 'Managing Director');
  assert.equal(JSON.stringify((await boss.patch('/admin/settings', { organizationName: 'Elvora Labs' })).data.settings.changed), '[]', 'no-op changes nothing');
  assert.equal((await auditActions('&action=settings.update')).length, 1, 'no-op is not audited');
  const rev = await boss.patch('/admin/settings', { documentFooter: null, colorPrimary: '' });
  assert.equal(rev.data.settings.fields.colorPrimary.source, 'environment'); assert.equal(getOrganization().colors.primary, '#1D4ED8');
});

test('settings do not change issuance rules: eligibility is still enforced and an unverified registration claim is never shown', async () => {
  assert.equal((await sam.post('/auth/login', { email: 'sam@example.com', password: PW })).status, 200); // suspended earlier, reactivated since
  const { enrId } = await enroll(sam, { fullName: 'Sam Roy', degree: 'MCA', academicYear: '2nd Year' }, { startDate: day(3) });
  assert.equal((await boss.patch('/admin/settings', { address: 'tiny' })).status, 400, 'an invalid value is never stored');
  const { getOrganization } = await import('../src/documents/organization.js');
  assert.equal(getOrganization().registration, null, 'registration is null while ORG_REGISTRATION_VERIFIED is not true');
  const cert = await boss.post('/admin/documents/certificate', { internshipId: enrId });
  assert.equal(cert.status, 409); assert.equal(cert.data.error.code, 'ENROLLMENT_NOT_COMPLETED', 'settings changes cannot make an ineligible internship eligible');
  const ok = await boss.post('/admin/documents/offer-letter', { internshipId: enrId });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const html = await (await fetch(`${srv.base}/admin/document-templates/offer_letter/preview`, { headers: keyH })).text();
  assert.ok(!html.includes('UDYAM-XX-00-0000000') && !/Udyam/i.test(html), 'unverified registration is not printed');
});

test('logo: PNG/JPEG only, size and signature checked; replaced and removed cleanly; audited; used by documents', async () => {
  assert.equal((await boss.del('/admin/settings/logo')).status, 409, 'no custom logo yet');
  // the tiny cookie client has no raw-upload helper, so send the same session cookie by hand
  const cookie = await sessionCookie();
  const up = (b, type = 'image/png') => rawFetch('PUT', '/admin/settings/logo', b, { 'Content-Type': type }, cookie);
  assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')).status, 400);
  assert.equal((await up(Buffer.from('GIF89a not a png'), 'image/png')).status, 400, 'wrong signature');
  assert.equal((await up(Buffer.concat([png, Buffer.alloc(600 * 1024)]))).status, 413);
  const ok = await up(png); assert.equal(ok.status, 200);
  assert.equal((await ok.json()).settings.logo.custom, true);
  const files = fs.readdirSync(path.join(dir, 'branding')); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{32}\.png$/);
  const { loadLogo } = await import('../src/documents/organization.js');
  assert.ok(loadLogo().custom && loadLogo().mime === 'image/png');
  assert.equal((await up(png)).status, 200); assert.equal(fs.readdirSync(path.join(dir, 'branding')).length, 1, 'old logo file removed on replace');
  assert.equal((await boss.del('/admin/settings/logo')).status, 200); assert.equal(fs.readdirSync(path.join(dir, 'branding')).length, 0);
  assert.equal(loadLogo().custom, false);
  assert.ok((await auditActions('&action=settings.logo_update')).length >= 3);
});

// ---------------------------------------------------------------- error handling
test('safe errors: malformed JSON, oversize bodies and missing records give clean JSON errors without internals', async () => {
  const bad = await fetch(`${srv.base}/admin/announcements`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: '' }, body: '{oops' });
  assert.ok([400, 401].includes(bad.status));
  const cookie = await sessionCookie();
  const r = await fetch(`${srv.base}/admin/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie }, body: '{oops' });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.message, 'Invalid JSON body');
  const big = await fetch(`${srv.base}/admin/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ documentFooter: 'x'.repeat(200000) }) });
  assert.equal(big.status, 413);
  for (const p of ['/admin/documents/ELV-DOC-ZZZZZZZZ', '/admin/documents/ELV-DOC-ZZZZZZZZ/verify', '/admin/announcements/ANN-FFFFFFFFFF']) {
    const x = await boss.get(p); assert.equal(x.status, 404); assert.ok(!JSON.stringify(x.data).includes('SELECT'));
  }
});
