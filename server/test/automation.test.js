import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

// Stage 07: certificate approval + background automation. The worker is driven by calling runCycle() with a fake "now".
const KEY = 'k'.repeat(40);
const adminH = { 'X-Admin-Key': KEY };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-auto-'));
const ORG = { ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Gowtham', ORG_SIGNATORY_TITLE: 'Chief Executive Officer (CEO)' };
let srv, db, worker, mailer, org;
const call = (m, p, b, h = adminH) => fetch(srv.base + p, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b === undefined ? undefined : JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
const days = (n) => new Date(Date.now() + n * 86400000);
const live = (enr, type) => db.prepare("SELECT * FROM documents WHERE enrollment_id = ? AND type = ? AND status <> 'Draft'").all(enr, type);
const enrOf = (appId) => db.prepare('SELECT * FROM enrollments WHERE application_id = ?').get(appId);

async function approvedApplication(email, name, internshipId = 'ELV-PY-001') {
  const c = client(srv.base);
  await c.post('/auth/register', validStudent({ email, fullName: name }));
  const a = await c.post('/applications', validApplication({ fullName: name, internshipId }));
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const id = a.data.application.id;
  assert.equal((await call('PATCH', `/admin/applications/${id}/status`, { status: 'Approved' })).status, 200);
  return { c, id };
}

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, DOCUMENTS_DIR: dir, RATE_LIMIT_ADMIN_MAX: '1000', ...ORG });
  ({ db } = await import('../src/db/index.js'));
  worker = await import('../src/automation/worker.js');
  mailer = await import('../src/utils/mailer.js');
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let asha, ravi, mia;
test('approved application → internship created and offer letter issued automatically (no admin action besides approval)', async () => {
  asha = await approvedApplication('asha@example.com', 'Asha Verma');
  assert.equal(enrOf(asha.id), undefined); // nothing yet: the worker has not run
  const r = await worker.runCycle({ now: new Date() });
  assert.equal(r.failures.length, 0, JSON.stringify(r.failures));
  assert.equal(r.enrolled, 1); assert.equal(r.offerLettersIssued, 1);
  const e = enrOf(asha.id);
  assert.equal(e.status, 'Awaiting Start'); assert.ok(e.start_date); assert.ok(e.expected_end_date > e.start_date);
  const docs = live(e.id, 'offer_letter');
  assert.equal(docs.length, 1); assert.equal(docs[0].status, 'Issued'); assert.equal(docs[0].issued_by, 'Automation');
  assert.match(docs[0].document_number, /^ELV-OL-\d{4}-000001$/);
  // the student was told and can see it
  const notes = db.prepare("SELECT type FROM notifications WHERE enrollment_id = ? ORDER BY rowid").all(e.id).map((n) => n.type);
  assert.ok(notes.includes('offer_letter_issued'));
  const mine = await asha.c.get('/student/documents');
  assert.equal(mine.data.documents.length, 1);
});

test('running again is a no-op: no second enrollment, no second letter, no extra number', async () => {
  const r = await worker.runCycle({ now: new Date(), force: true });
  assert.equal(r.enrolled + r.offerLettersIssued + r.certificatesIssued, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE type='offer_letter'").get().n, 1);
  assert.equal(db.prepare("SELECT last_value v FROM document_sequences WHERE type='offer_letter'").get().v, 1);
});

test('a failure (missing organization details) is remembered, backs off, reported, and fixed by a later cycle', async () => {
  ravi = await approvedApplication('ravi@example.com', 'Ravi Kumar');
  const cfg = (await import('../src/config/index.js')).config;
  const saved = cfg.organization.address; cfg.organization.address = '';
  const now = new Date();
  const r = await worker.runCycle({ now });
  assert.equal(r.offerLettersIssued, 0); assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].error, /ORGANIZATION_INCOMPLETE/);
  const e = enrOf(ravi.id);
  const st = db.prepare("SELECT * FROM automation_state WHERE enrollment_id = ? AND type = 'offer_letter'").get(e.id);
  assert.equal(st.attempts, 1); assert.ok(st.next_attempt_at > now.toISOString());
  assert.equal(worker.status().problems.length, 1);
  // back-off respected on a normal cycle
  const again = await worker.runCycle({ now: new Date(now.getTime() + 60_000) });
  assert.equal(again.failures.length, 0); assert.equal(again.offerLettersIssued, 0);
  // admin fixes the setting → next cycle after the back-off issues it and clears the problem
  cfg.organization.address = saved;
  const ok = await worker.runCycle({ now: new Date(now.getTime() + 2 * 3600_000) });
  assert.equal(ok.offerLettersIssued, 1);
  assert.equal(worker.status().problems.length, 0);
});

test('SLA: an offer letter that is still missing after OFFER_SLA_HOURS is reported as overdue', async () => {
  mia = await approvedApplication('mia@example.com', 'Mia Thomas');
  const cfg = (await import('../src/config/index.js')).config;
  const saved = cfg.organization.address; cfg.organization.address = '';
  const r = await worker.runCycle({ now: new Date(Date.now() + 25 * 3600_000), force: true });
  assert.equal(r.overdueOffers, 1);
  cfg.organization.address = saved;
  assert.equal((await worker.runCycle({ now: new Date(Date.now() + 26 * 3600_000), force: true })).overdueOffers, 0);
  assert.equal(live(enrOf(mia.id).id, 'offer_letter').length, 1);
});

test('certificate decision API: admin only, validated, only for Active/Suspended/Completed internships', async () => {
  const e = enrOf(asha.id);
  for (const [m, p, b] of [['PATCH', `/admin/internships/${e.id}/certificate-decision`, { decision: 'Approved' }], ['GET', '/admin/certificate-approvals'], ['GET', '/admin/automation'], ['POST', '/admin/automation/run', {}]]) {
    assert.equal((await call(m, p, b, {})).status, 401, `anon ${p}`);
    assert.equal((await call(m, p, b, { cookie: 'elvora_session=x' })).status, 401, `student ${p}`);
  }
  assert.equal((await call('PATCH', `/admin/internships/${e.id}/certificate-decision`, { decision: 'Approved' })).data.error.code, 'INVALID_STATE'); // Awaiting Start
  assert.equal((await call('PATCH', `/admin/internships/ELV-INT-NOPE`, { decision: 'Approved' })).status, 404);
  await call('PATCH', `/admin/internships/${e.id}/status`, { status: 'Active' });
  assert.equal((await call('PATCH', `/admin/internships/${e.id}/certificate-decision`, { decision: 'Maybe' })).status, 400);
  assert.equal((await call('PATCH', `/admin/internships/${e.id}/certificate-decision`, { decision: 'Declined' })).status, 400); // reason required
  const d = await call('PATCH', `/admin/internships/${e.id}/certificate-decision`, { decision: 'Declined', note: 'Project not submitted', decidedBy: 'Priya' });
  assert.equal(d.status, 200); assert.equal(d.data.internship.certificateReview.decision, 'Declined'); assert.equal(d.data.internship.certificateReview.decidedBy, 'Priya');
  assert.equal(d.data.internship.studentId, undefined);
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE enrollment_id = ? AND type = 'certificate_declined'").get(e.id));
});

test('no certificate without approval: Pending and Declined interns get nothing, even when Completed', async () => {
  const e = enrOf(asha.id);
  db.prepare("UPDATE enrollments SET start_date = '2026-01-05' WHERE id = ?").run(e.id); // she started long ago, so completing now is realistic
  await call('PATCH', `/admin/internships/${e.id}/status`, { status: 'Completed' });
  const r = await worker.runCycle({ now: days(1), force: true });
  assert.equal(r.certificatesIssued, 0);
  assert.equal(live(e.id, 'certificate').length, 0);
  const direct = await call('POST', '/admin/documents/certificate', { internshipId: e.id });
  assert.equal(direct.data.error.code, 'CERTIFICATE_NOT_APPROVED'); // the manual route obeys the same rule
  const list = await call('GET', '/admin/certificate-approvals');
  const row = list.data.internships.find((x) => x.id === e.id);
  assert.equal(row.studentName, 'Asha Verma'); assert.equal(row.certificateReview.decision, 'Declined'); assert.equal(row.studentId, undefined);
});

test('approve → certificate generated automatically; decision then locked; revoked certificates are not re-issued', async () => {
  const e = enrOf(asha.id);
  const ok = await call('PATCH', `/admin/internships/${e.id}/certificate-decision`, { decision: 'Approved', decidedBy: 'Priya' });
  assert.equal(ok.status, 200);
  const r = await worker.runCycle({ now: days(1), force: true });
  assert.equal(r.certificatesIssued, 1, JSON.stringify(r.failures));
  const [cert] = live(e.id, 'certificate');
  assert.equal(cert.status, 'Issued'); assert.match(cert.document_number, /^ELV-CRT-\d{4}-000001$/); assert.equal(cert.issued_by, 'Automation');
  assert.equal(db.prepare('SELECT certificate_id FROM enrollments WHERE id = ?').get(e.id).certificate_id, cert.id);
  assert.equal((await call('PATCH', `/admin/internships/${e.id}/certificate-decision`, { decision: 'Declined', note: 'changed my mind' })).data.error.code, 'CERTIFICATE_ALREADY_ISSUED');
  // admin withdraws it: the worker must not silently create a replacement
  assert.equal((await call('PATCH', `/admin/documents/${cert.id}/revoke`, { reason: 'Issued in error' })).status, 200);
  assert.equal((await worker.runCycle({ now: days(2), force: true })).certificatesIssued, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE enrollment_id = ? AND type = 'certificate'").get(e.id).n, 1);
  // a person may still issue the replacement by hand
  assert.equal((await call('POST', '/admin/documents/certificate', { internshipId: e.id })).status, 201);
});

test('lifecycle by date: starts on its start date; an approved intern is completed after the end date; unapproved ones are never auto-completed', async () => {
  const e = enrOf(ravi.id), m = enrOf(mia.id);
  const start = new Date(`${e.start_date}T08:00:00Z`);
  const r1 = await worker.runCycle({ now: new Date(start.getTime() - 86400000) });
  assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(e.id).status, 'Awaiting Start');
  assert.equal(r1.started, 0);
  const r2 = await worker.runCycle({ now: start });
  assert.ok(r2.started >= 1);
  assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(e.id).status, 'Active');
  await call('PATCH', `/admin/internships/${e.id}/certificate-decision`, { decision: 'Approved' });
  const end = new Date(`${e.expected_end_date}T08:00:00Z`);
  const before = await worker.runCycle({ now: new Date(end.getTime() - 86400000) });
  assert.equal(before.completed, 0);
  const after2 = await worker.runCycle({ now: end });
  assert.equal(after2.completed, 1); assert.equal(after2.certificatesIssued, 1, JSON.stringify(after2.failures));
  assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(e.id).status, 'Completed');
  // Mia never got an approval: she is started but never completed and gets no certificate
  assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(m.id).status, 'Active');
  assert.equal(live(m.id, 'certificate').length, 0);
});

test('e-mail: the PDF is sent once per document when SMTP is configured; failures retry; nothing is sent without SMTP', async () => {
  const noMail = await worker.runCycle({ now: days(3), force: true });
  assert.equal(noMail.emailsSent, 0); // no transport configured
  const sent = []; let fail = true;
  mailer.__setTransportForTests({ sendMail: async (m) => { if (fail) { fail = false; throw new Error('smtp down'); } sent.push(m); } });
  const r1 = await worker.runCycle({ now: days(3), force: true });
  assert.ok(r1.failures.some((f) => /email: .*smtp down/.test(f.error)));
  const r2 = await worker.runCycle({ now: days(4) }); // after the back-off
  assert.ok(r2.emailsSent >= 1);
  const total = sent.length;
  assert.ok(total >= 1);
  for (const m of sent) {
    assert.match(m.subject, /ELVORA/); assert.equal(m.attachments[0].contentType, 'application/pdf');
    assert.equal(m.attachments[0].content.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(m.text, /\/verify\/ELV-VER-/);
  }
  const r3 = await worker.runCycle({ now: days(5), force: true });
  assert.equal(r3.emailsSent, 0); assert.equal(sent.length, total); // never twice
  mailer.__setTransportForTests(null);
});

test('admin automation status + manual run', async () => {
  const s = await call('GET', '/admin/automation');
  assert.equal(s.status, 200);
  assert.equal(s.data.automation.offerSlaHours, 24);
  assert.ok(s.data.automation.lastRun);
  const run = await call('POST', '/admin/automation/run', {});
  assert.equal(run.status, 200); assert.equal(typeof run.data.result.failures, 'number');
});

test('signature: issued PDFs carry a handwritten-style signature (script initials), the printed signatory name and a "Digitally signed" line', async () => {
  const { spawnSync } = await import('node:child_process');
  const e = enrOf(asha.id);
  const [d] = live(e.id, 'offer_letter');
  const file = (await import('../src/documents/storage.js')).pathFor(d.storage_key);
  const buf = fs.readFileSync(file);
  assert.ok(!buf.toString('latin1').includes('GreatVibes')); // the signature is vector artwork now, no script font is embedded
  const t = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).stdout;
  assert.ok(t.includes('Gowtham')); assert.ok(t.includes('Chief Executive Officer (CEO)')); assert.ok(t.includes('Digitally signed'));
});
