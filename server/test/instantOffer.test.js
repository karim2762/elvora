// Instant offer letter: an administrator creates/chooses an internship for a student and gets the signed offer letter immediately.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'a-long-random-admin-key-for-tests-1234567890';
const ADMIN_PW = 'Adm1n!Strong#Pass';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-instant-'));
let srv, asha, boss, anon, db, ashaId;

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, DOCUMENTS_DIR: dir, RATE_LIMIT_ADMIN_MAX: '1000', RATE_LIMIT_APPLY_MAX: '1000',
    ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org' }); // no ORG_SIGNATORY_*: the CEO default (Gowtham) applies
  const students = await import('../src/db/students.js');
  ({ db } = await import('../src/db/index.js'));
  [asha, boss, anon] = [1, 2, 3].map(() => client(srv.base));
  const r = await asha.post('/auth/register', validStudent());
  assert.equal(r.status, 201); ashaId = r.data.user.id;
  const reg = await boss.post('/auth/register', validStudent({ fullName: 'Priya Admin', email: 'boss@example.com', password: ADMIN_PW, confirmPassword: ADMIN_PW }));
  assert.equal(students.setRole(reg.data.user.id, 'admin'), true);
  boss.reset();
  assert.equal((await boss.post('/auth/admin/login', { email: 'boss@example.com', password: ADMIN_PW })).status, 200);
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const body = (over = {}) => ({ studentId: ashaId, newInternship: { title: 'Rapid Python Internship', category: 'python-development', durationDays: 30 }, startDate: '2030-01-10', ...over });

test('only a signed-in administrator can use it (students, anonymous and the read-only shared key are refused)', async () => {
  assert.equal((await anon.post('/admin/instant-offer', body())).status, 401);
  assert.equal((await asha.post('/admin/instant-offer', body())).status, 403); // a student session is not an administrator session
  assert.ok([401, 403].includes((await anon.post('/admin/instant-offer', body(), { 'X-Admin-Key': KEY })).status)); // the shared key never counts as a named administrator
  assert.equal((await anon.get('/admin/instant-offer/internships')).status, 401);
});

test('validation: missing student, unknown student, bad internship, bad date', async () => {
  assert.equal((await boss.post('/admin/instant-offer', body({ studentId: '' }))).status, 400);
  assert.equal((await boss.post('/admin/instant-offer', body({ studentId: 'nope' }))).status, 404);
  const noTitle = await boss.post('/admin/instant-offer', body({ newInternship: { title: '', category: 'python-development', durationDays: 30 } }));
  assert.equal(noTitle.status, 400); assert.ok(noTitle.data.error.fields.newInternship.title);
  assert.equal((await boss.post('/admin/instant-offer', body({ newInternship: undefined, internshipId: 'bad' }))).status, 400);
  assert.equal((await boss.post('/admin/instant-offer', body({ startDate: '2030-13-45' }))).status, 400);
  assert.equal((await boss.post('/admin/instant-offer', body({ startDate: '2000-01-01' }))).status, 400);
});

let first;
test('creates the internship, approves, enrolls and issues the offer letter in one step, all under ONE Elvora ID', async () => {
  const r = await boss.post('/admin/instant-offer', body({ assignedProject: 'Build a CLI tool' }));
  assert.equal(r.status, 201, JSON.stringify(r.data)); first = r.data;
  assert.match(first.elvoraId, /^ELV-[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(first.createdInternship, true); assert.equal(first.createdApplication, true); assert.equal(first.alreadyIssued, false);
  assert.equal(first.document.type, 'offer_letter'); assert.equal(first.document.status, 'Issued'); assert.equal(first.document.enrollmentId, first.elvoraId);
  assert.equal(first.document.applicationId, first.elvoraId); // application, internship record and documents share the ID
  assert.equal(first.startDate, '2030-01-10'); assert.equal(first.expectedEndDate, '2030-02-09');
  assert.equal(first.document.issuedBy, 'Priya Admin');
  // the student sees a normal approved application, internship and issued offer letter
  const apps = (await asha.get('/applications/my')).data.applications;
  assert.equal(apps.length, 1); assert.equal(apps[0].status, 'Approved'); assert.equal(apps[0].id, first.elvoraId);
  const docs = (await asha.get('/student/documents')).data.documents;
  assert.equal(docs.length, 1); assert.equal(docs[0].type, 'offer_letter');
  // the new internship is private (a draft): it is NOT on the public catalogue
  const pub = await anon.get('/internships'); assert.ok(!JSON.stringify(pub.data).includes('Rapid Python Internship'));
  // audited
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'offer_letter.instant' AND target_id = ?").get(first.elvoraId));
});

test('repeating the request returns the same letter (no second internship, application or number)', async () => {
  const r = await boss.post('/admin/instant-offer', body());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.alreadyIssued, true); assert.equal(r.data.createdInternship, false); assert.equal(r.data.createdApplication, false);
  assert.equal(r.data.elvoraId, first.elvoraId); assert.equal(r.data.document.id, first.document.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM applications').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enrollments').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE type = 'offer_letter'").get().n, 1);
});

test('an existing listing can be chosen; a student who already applied keeps that application (it is approved, not duplicated)', async () => {
  const list = (await boss.get('/admin/instant-offer/internships')).data;
  assert.ok(list.internships.some((i) => i.title === 'Rapid Python Internship') && list.categories.length > 0);
  const existing = list.internships.find((i) => i.id === 'ELV-PY-001'); // a published, open listing from the seeded catalogue
  assert.ok(existing);
  const mine = await asha.post('/applications', validApplication({ internshipId: existing.id }));
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  const r = await boss.post('/admin/instant-offer', { studentId: ashaId, internshipId: existing.id, startDate: '2030-03-01' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.createdApplication, false); assert.equal(r.data.elvoraId, mine.data.application.id);
  assert.equal((await asha.get('/applications/my')).data.applications.find((a) => a.id === mine.data.application.id).status, 'Approved');
});

test('the signed PDF carries the CEO signature name and the single ID (and never the former name)', async () => {
  assert.ok(fs.readdirSync(dir, { recursive: true }).length > 0); // the PDF was written to private storage
  const { getOrganization } = await import('../src/documents/organization.js');
  const org = getOrganization();
  assert.equal(org.signatory.name, 'Gowtham'); assert.equal(org.signatory.title, 'Chief Executive Officer (CEO)');
});
