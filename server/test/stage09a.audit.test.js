// Stage 09A — AUDIT of the existing Stage 06/07 document workflows. This drives the real application over HTTP (in-memory database,
// temporary document folder) and checks the real code paths, not the UI. It exists so the audit can be re-run at any time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1';
const ORG = { ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Gowtham', ORG_SIGNATORY_TITLE: 'Chief Executive Officer (CEO)' };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let srv, dir, db, worker, verification, admin, asha, ravi, anon, ashaApp, enrId, offerDoc, certDoc;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-audit-'));
  srv = await startServer({ DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000', ...ORG });
  ({ db } = await import('../src/db/index.js'));
  worker = await import('../src/automation/worker.js');
  verification = await import('../src/documents/verification.js');
  [anon, admin, asha, ravi] = [1, 2, 3, 4].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  assert.equal((await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar' }))).status, 201);
  assert.equal((await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const notificationsOf = (enrollmentId, type) => db.prepare('SELECT COUNT(*) n FROM notifications WHERE enrollment_id = ? AND type = ?').get(enrollmentId, type).n;

test('OFFER LETTER 1-5: student applies, admin sees it, reviews, approves; approved application is eligible', async () => {
  const a = await asha.post('/applications', validApplication());
  assert.equal(a.status, 201, JSON.stringify(a.data));
  ashaApp = a.data.application.id;
  assert.ok((await admin.get('/admin/applications?pageSize=50')).data.applications.some((x) => x.id === ashaApp), 'appears in the admin list');
  assert.equal((await admin.get(`/admin/applications/${ashaApp}`)).status, 200);
  assert.equal((await admin.patch(`/admin/applications/${ashaApp}/status`, { status: 'Under Review' })).status, 200);
  // not eligible before approval
  assert.equal((await admin.post(`/admin/applications/${ashaApp}/internship`, {})).status, 409, 'unapproved application cannot have an internship');
  assert.equal((await admin.patch(`/admin/applications/${ashaApp}/status`, { status: 'Approved', note: 'ok' })).status, 200);
  const enr = await admin.post(`/admin/applications/${ashaApp}/internship`, { startDate: day(-2) });
  assert.equal(enr.status, 201, JSON.stringify(enr.data));
  enrId = enr.data.internship.id;
  const el = await admin.get(`/admin/internships/${enrId}/documents/offer_letter/eligibility`);
  assert.equal(el.data.eligibility.eligible, true);
});

test('OFFER LETTER 6-10: generated once, stored, student notified, can view+download, QR reference verifies publicly', async () => {
  const r = await admin.post('/admin/documents/offer-letter', { internshipId: enrId });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  offerDoc = r.data.document;
  assert.equal(offerDoc.status, 'Issued'); assert.ok(offerDoc.fileAvailable); assert.match(offerDoc.documentNumber, /^ELV-OL-\d{4}-\d{6}$/);
  assert.equal(notificationsOf(enrId, 'offer_letter_issued'), 1);
  const mine = (await asha.get('/student/documents')).data.documents;
  assert.equal(mine.length, 1); assert.equal(mine[0].available, true);
  const file = await fetch(`${srv.base}/student/documents/${mine[0].id}/file?download=1`, { headers: { cookie: await cookieOf(asha) } });
  assert.equal(file.status, 200); assert.match(file.headers.get('content-disposition'), /^attachment/);
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  // the QR encodes CLIENT_URL/verify/<reference>; the public lookup of that reference is valid
  assert.match(verification.verificationUrl(mine[0].verificationCode), /\/verify\/ELV-VER-/);
  const v = await anon.get(`/public/documents/verify/${mine[0].verificationCode}`);
  assert.equal(v.status, 200); assert.equal(v.data.result, 'valid'); assert.equal(v.data.document.elvoraId, enrId);
  // ownership: another student sees nothing and gets the same 404 as a missing document
  assert.equal((await ravi.get('/student/documents')).data.documents.length, 0);
  assert.equal((await ravi.get(`/student/documents/${mine[0].id}`)).status, 404);
  assert.equal((await ravi.get(`/student/documents/${mine[0].id}/file`)).status, 404);
  assert.equal((await anon.get(`/student/documents/${mine[0].id}/file`)).status, 401);
});

test('OFFER LETTER duplicate risk: two parallel issue requests and a worker run produce exactly one document and one notification', async () => {
  const results = await Promise.all([admin.post('/admin/documents/offer-letter', { internshipId: enrId }), admin.post('/admin/documents/offer-letter', { internshipId: enrId })]);
  assert.deepEqual(results.map((r) => r.status), [409, 409], 'already issued');
  const r = await worker.runCycle({ now: new Date(), force: true });
  assert.equal(r.offerLettersIssued, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE enrollment_id = ? AND type = 'offer_letter'").get(enrId).n, 1);
  assert.equal(notificationsOf(enrId, 'offer_letter_issued'), 1);
});

test('CERTIFICATE 1-6: not issuable until the internship is genuinely completed AND an administrator approved it; an end date alone does nothing', async () => {
  // active, finished by date, but nothing else
  // (the worker already activated it because the start date had arrived) → move the dates so the end date has passed
  assert.equal((await admin.patch(`/admin/internships/${enrId}`, { startDate: day(-10), expectedEndDate: day(-1) })).status, 200);
  assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(enrId).status, 'Active');
  assert.equal((await admin.post('/admin/documents/certificate', { internshipId: enrId })).status, 409, 'active, not completed');
  const idle = await worker.runCycle({ now: new Date(), force: true });
  assert.equal(idle.completed + idle.certificatesIssued, 0, 'an end date in the past does not complete or certify (decision is still Pending)');
  assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(enrId).status, 'Active');
  // completion needs 100% and the reviewer's confirmation
  assert.equal((await admin.patch(`/admin/internships/${enrId}/complete`, { confirmReviewed: true })).status, 409);
  assert.equal((await admin.patch(`/admin/internships/${enrId}/progress`, { progressPercent: 100 })).status, 200);
  assert.equal((await admin.patch(`/admin/internships/${enrId}/complete`, { confirmReviewed: true })).status, 200);
  // completed, but no approval yet
  const refused = await admin.post('/admin/documents/certificate', { internshipId: enrId });
  assert.equal(refused.status, 409); assert.equal(refused.data.error?.code ?? refused.data.code, 'CERTIFICATE_NOT_APPROVED');
  assert.equal((await worker.runCycle({ now: new Date(), force: true })).certificatesIssued, 0);
});

test('CERTIFICATE 7-10: approved → generated, stored, linked to the student, notified, downloadable, verifiable; never issued twice', async () => {
  assert.equal((await admin.patch(`/admin/internships/${enrId}/certificate-decision`, { decision: 'Approved' })).status, 200);
  const r = await Promise.all([admin.post('/admin/documents/certificate', { internshipId: enrId }), admin.post('/admin/documents/certificate', { internshipId: enrId })]);
  assert.deepEqual(r.map((x) => x.status).sort(), [201, 409], 'exactly one parallel request wins');
  certDoc = r.find((x) => x.status === 201).data.document;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE enrollment_id = ? AND type = 'certificate' AND status = 'Issued'").get(enrId).n, 1);
  assert.equal(notificationsOf(enrId, 'certificate_issued'), 1);
  assert.equal(db.prepare('SELECT certificate_id FROM enrollments WHERE id = ?').get(enrId).certificate_id, certDoc.id, 'certificate linked to the internship record');
  const mine = (await asha.get('/student/documents')).data.documents.find((d) => d.type === 'certificate');
  assert.ok(mine && mine.available);
  assert.equal((await anon.get(`/public/documents/verify/${mine.verificationCode}`)).data.result, 'valid');
  assert.equal((await worker.runCycle({ now: new Date(), force: true })).certificatesIssued, 0);
  assert.equal(notificationsOf(enrId, 'certificate_issued'), 1);
  // the timeline shows the certificate
  const tl = (await asha.get('/student/internships')).data.internships[0].timeline.find((m) => m.key === 'certificate');
  assert.equal(tl.state, 'completed');
});

test('REVOCATION: a revoked certificate stops downloading (410), verifies as revoked, and is not silently re-created', async () => {
  assert.equal((await admin.patch(`/admin/documents/${certDoc.id}/revoke`, { reason: 'Issued in error for audit test' })).status, 200);
  assert.equal((await asha.get(`/student/documents/${certDoc.id}/file`)).status, 410);
  assert.equal((await anon.get(`/public/documents/verify/${certDoc.verificationCode}`)).data.result, 'revoked');
  assert.equal((await worker.runCycle({ now: new Date(), force: true })).certificatesIssued, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE enrollment_id = ? AND type = 'certificate' AND status = 'Issued'").get(enrId).n, 0);
});

async function cookieOf(c) { // the tiny client keeps its cookie private; log in again to read it for a raw fetch
  const res = await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: PW }) });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
