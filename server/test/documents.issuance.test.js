import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'k'.repeat(40);
const adminH = { 'X-Admin-Key': KEY };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-docs-'));
const HAS_PDFTOTEXT = spawnSync('pdftotext', ['-v']).status !== null && !spawnSync('pdftotext', ['-v']).error;
let srv, db, asha, ravi, ashaId, raviId, ashaEnr, raviEnr;

const call = (m, p, b, h = adminH) => fetch(srv.base + p, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b === undefined ? undefined : JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, headers: r.headers, data: await r.json().catch(() => null) }));
const pdfText = (buf) => { const f = path.join(dir, `t-${crypto.randomUUID()}.pdf`); fs.writeFileSync(f, buf); const r = spawnSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); fs.rmSync(f); return r.stdout; };
const adminPdf = async (id) => Buffer.from(await (await fetch(`${srv.base}/admin/documents/${id}/file`, { headers: adminH })).arrayBuffer());
const pageInfo = (buf) => { const s = buf.toString('latin1'); return { pages: (s.match(/\/Type \/Page\b/g) || []).length, box: (s.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/) || []).slice(1).map(Number) }; };
const isA4 = (box, landscape = false) => { const [w, h] = landscape ? [box[1], box[0]] : box; return Math.abs(w - 595.28) < 0.5 && Math.abs(h - 841.89) < 0.5; };

async function enroll(c, email, name) {
  await c.post('/auth/register', validStudent({ email, fullName: name }));
  const app = await c.post('/applications', validApplication({ fullName: name }));
  const appId = app.data.application.id;
  assert.equal((await call('PATCH', `/admin/applications/${appId}/status`, { status: 'Approved' })).status, 200);
  const e = await call('POST', `/admin/applications/${appId}/internship`, { startDate: '2026-01-05' });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  return e.data.internship.id;
}

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, DOCUMENTS_DIR: dir, RATE_LIMIT_ADMIN_MAX: '1000', ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org',
    ORG_SIGNATORY_NAME: 'A. Signatory', ORG_SIGNATORY_TITLE: 'Director', ORG_WEBSITE: 'https://example.org' });
  ({ db } = await import('../src/db/index.js'));
  asha = client(srv.base); ravi = client(srv.base);
  ashaEnr = await enroll(asha, 'asha@example.com', 'Asha Verma');
  raviEnr = await enroll(ravi, 'ravi@example.com', 'Ravi Kumar');
  ashaId = db.prepare('SELECT id FROM students WHERE email = ?').get('asha@example.com').id;
  raviId = db.prepare('SELECT id FROM students WHERE email = ?').get('ravi@example.com').id;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let offer, cert;
test("pdftotext available for content checks", () => assert.ok(HAS_PDFTOTEXT));

test('only administrators can issue, list, read, download or revoke (students and anonymous get 401)', async () => {
  const targets = [['POST', '/admin/documents/offer-letter', { internshipId: ashaEnr }], ['POST', '/admin/documents/certificate', { internshipId: ashaEnr }],
    ['GET', '/admin/documents'], ['GET', '/admin/documents/ELV-DOC-AAAAAAAA'], ['GET', '/admin/documents/ELV-DOC-AAAAAAAA/file'], ['PATCH', '/admin/documents/ELV-DOC-AAAAAAAA/revoke', { reason: 'x y z' }]];
  for (const [m, p, b] of targets) {
    assert.equal((await call(m, p, b, {})).status, 401, `anon ${m} ${p}`);
    assert.equal((await call(m, p, b, { cookie: 'elvora_session=whatever' })).status, 401, `student ${m} ${p}`);
    assert.equal((await call(m, p, b, { 'X-Admin-Key': 'wrong'.repeat(10) })).status, 401, `bad key ${m} ${p}`);
  }
  // a real signed-in student session, not just a made-up cookie
  const login = await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: 'Str0ng!Pass1' }) });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const r = await call('POST', '/admin/documents/certificate', { internshipId: ashaEnr }, { cookie });
  assert.equal(r.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n, 0);
});

test('request validation: unknown internship, junk body; the student cannot be chosen by the caller', async () => {
  assert.equal((await call('POST', '/admin/documents/offer-letter', {})).status, 400);
  assert.equal((await call('POST', '/admin/documents/offer-letter', { internshipId: 'nope' })).status, 404);
  assert.equal((await call('POST', '/admin/documents/offer-letter', { internshipId: 'ELV-INT-AAAAAAAA' })).status, 404);
  assert.equal((await call('POST', '/admin/documents/offer-letter', { internshipId: ashaEnr, issuedBy: 'x' })).status, 400);
});

test('offer letter: issued from backend records, real PDF, A4, content checked', async () => {
  const r = await call('POST', '/admin/documents/offer-letter', { internshipId: ashaEnr, issuedBy: 'Priya (Admin)', studentName: 'Forged Name', studentId: raviId });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  offer = r.data.document;
  assert.equal(offer.status, 'Issued'); assert.match(offer.documentNumber, /^ELV-OL-\d{4}-000001$/);
  assert.match(offer.verificationCode, /^ELV-VER-/); assert.equal(offer.issuedBy, 'Priya (Admin)'); assert.equal(offer.studentId, ashaId);
  assert.equal(offer.templateVersion, 'offer-letter@1'); assert.equal(offer.fileAvailable, true);
  assert.equal(JSON.stringify(r.data).includes('storage'), false); assert.equal(offer.storageKey, undefined);
  const pdf = await adminPdf(offer.id);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const { pages, box } = pageInfo(pdf); assert.ok(pages >= 1); assert.ok(isA4(box), `box ${box}`);
  assert.equal(crypto.createHash('sha256').update(pdf).digest('hex'), offer.sha256);
  if (HAS_PDFTOTEXT) {
    const t = pdfText(pdf);
    for (const s of ['Asha Verma', offer.enrollmentId, offer.verificationCode, 'Python', 'A. Signatory', 'Director', '12 Example Road']) assert.ok(t.includes(s), `missing "${s}" in PDF text`);
    assert.ok(!t.includes('Forged Name'));
  }
  assert.deepEqual(r.data.document.events.map((e) => e.event), ['created', 'issued']);
});

test('duplicate issuance is prevented, including two simultaneous requests', async () => {
  assert.equal((await call('POST', '/admin/documents/offer-letter', { internshipId: ashaEnr })).data.error.code, 'DOCUMENT_EXISTS');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE type='offer_letter' AND enrollment_id=?").get(ashaEnr).n, 1);
  const before = fs.readdirSync(dir).length;
  const both = await Promise.all([call('POST', '/admin/documents/offer-letter', { internshipId: raviEnr }), call('POST', '/admin/documents/offer-letter', { internshipId: raviEnr })]);
  const codes = both.map((b) => b.status).sort();
  assert.deepEqual(codes, [201, 409]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE type='offer_letter' AND enrollment_id=?").get(raviEnr).n, 1);
  assert.equal(fs.readdirSync(dir).length, before + 1); // the losing request left no orphan file
});

test('certificate: refused until the backend marks the internship Completed', async () => {
  const early = await call('POST', '/admin/documents/certificate', { internshipId: ashaEnr });
  assert.equal(early.status, 409); assert.equal(early.data.error.code, 'ENROLLMENT_NOT_COMPLETED');
  await call('PATCH', `/admin/internships/${ashaEnr}/status`, { status: 'Active' });
  assert.equal((await call('POST', '/admin/documents/certificate', { internshipId: ashaEnr })).data.error.code, 'ENROLLMENT_NOT_COMPLETED');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE type='certificate'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM document_sequences WHERE type='certificate'").get().n, 0); // no number consumed by refusals
  await call('PATCH', `/admin/internships/${ashaEnr}/status`, { status: 'Completed' });
  assert.equal((await call('POST', '/admin/documents/certificate', { internshipId: ashaEnr })).data.error.code, 'CERTIFICATE_NOT_APPROVED'); // Stage 07: completed is not enough
  assert.equal((await call('PATCH', `/admin/internships/${ashaEnr}/certificate-decision`, { decision: 'Approved' })).status, 200);
  const r = await call('POST', '/admin/documents/certificate', { internshipId: ashaEnr });
  assert.equal(r.status, 201, JSON.stringify(r.data)); cert = r.data.document;
  assert.match(cert.documentNumber, /^ELV-CRT-\d{4}-000001$/);
  const pdf = await adminPdf(cert.id); const { pages, box } = pageInfo(pdf);
  assert.equal(pages, 1); assert.ok(isA4(box, true), `box ${box}`);
  if (HAS_PDFTOTEXT) { const t = pdfText(pdf); for (const s of ['CERTIFICATE OF COMPLETION', 'Asha Verma', cert.enrollmentId, cert.verificationCode, 'successfully completed']) assert.ok(t.includes(s), s); }
  assert.equal(db.prepare('SELECT certificate_id FROM enrollments WHERE id = ?').get(ashaEnr).certificate_id, cert.id);
  assert.equal((await call('POST', '/admin/documents/certificate', { internshipId: ashaEnr })).data.error.code, 'DOCUMENT_EXISTS');
});

test('cancelled internships get no offer letter; a student cannot get a certificate for someone else’s record', async () => {
  const e2 = await enroll(client(srv.base), 'cancelled@example.com', 'Cara Nair');
  await call('PATCH', `/admin/internships/${e2}/status`, { status: 'Cancelled' });
  assert.equal((await call('POST', '/admin/documents/offer-letter', { internshipId: e2 })).data.error.code, 'ENROLLMENT_CLOSED');
  // tampered records (student_id disagrees with the application owner) are refused
  db.prepare('UPDATE enrollments SET student_id = ? WHERE id = ?').run(ashaId, raviEnr);
  db.prepare("UPDATE documents SET status = 'Revoked', revoked_at = 'x', revoked_reason = 'test' WHERE enrollment_id = ?").run(raviEnr);
  assert.equal((await call('POST', '/admin/documents/offer-letter', { internshipId: raviEnr })).data.error.code, 'RECORD_MISMATCH');
  db.prepare('UPDATE enrollments SET student_id = ? WHERE id = ?').run(raviId, raviEnr);
});

test('students see only their own issued documents; files match what the admin stored', async () => {
  const list = (await asha.get('/student/documents')).data.documents;
  assert.deepEqual(list.map((d) => d.id).sort(), [offer.id, cert.id].sort());
  for (const d of list) { assert.ok(d.documentNumber); assert.equal(d.storageKey, undefined); assert.equal(d.studentId, undefined); assert.equal(d.sha256, undefined); }
  const cookie = (await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: 'Str0ng!Pass1' }) })).headers.getSetCookie()[0].split(';')[0];
  const f = await fetch(`${srv.base}/student/documents/${cert.id}/file?download=1`, { headers: { cookie } });
  assert.equal(f.status, 200); assert.match(f.headers.get('content-disposition'), /attachment; filename="ELVORA-Certificate-ELV-[A-Z0-9]{8}\.pdf"/);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await f.arrayBuffer())).digest('hex'), cert.sha256);
  assert.equal((await ravi.get(`/student/documents/${cert.id}`)).status, 404);
  assert.equal((await ravi.get(`/student/documents/${cert.id}/file`)).status, 404);
  const notes = (await asha.get('/student/notifications')).data.notifications.map((n) => n.type);
  assert.ok(notes.includes('offer_letter_issued') && notes.includes('certificate_issued'));
});

test('secure storage: random keys, owner-only files, nothing served publicly, no paths in any response', async () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf'));
  assert.ok(files.length >= 3);
  for (const f of files) {
    assert.match(f, /^[0-9a-f]{48}\.pdf$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  }
  const rows = db.prepare('SELECT storage_key FROM documents WHERE storage_key IS NOT NULL').all();
  for (const { storage_key: k } of rows) { assert.ok(files.includes(`${k}.pdf`)); assert.equal((await fetch(`${srv.base}/storage/documents/${k}.pdf`)).status, 404); assert.equal((await fetch(`${srv.base.replace('/api/v1', '')}/${k}.pdf`)).status, 404); }
  const bodies = [await call('GET', '/admin/documents'), await call('GET', `/admin/documents/${offer.id}`), await asha.get('/student/documents')].map((r) => JSON.stringify(r.data));
  for (const b of bodies) { for (const { storage_key: k } of rows) assert.ok(!b.includes(k)); assert.ok(!b.includes(dir)); assert.ok(!/storage_?key/i.test(b)); }
});

test('long student names and internship titles still produce clean, A4, text-complete PDFs', async () => {
  const longName = 'Venkata Subrahmanyam Chandrasekharan Ramanathan Iyer-Krishnamurthy';
  const longTitle = 'Applied Machine Learning, Data Engineering and Cloud-Native Deployment Practices Internship';
  const e3 = await enroll(client(srv.base), 'long@example.com', 'Temp Name');
  db.prepare('UPDATE students SET full_name = ? WHERE email = ?').run(longName, 'long@example.com');
  db.prepare("UPDATE applications SET internship_title = ?, internship_category = 'Artificial Intelligence and Machine Learning' WHERE id = (SELECT application_id FROM enrollments WHERE id = ?)").run(longTitle, e3);
  const o = await call('POST', '/admin/documents/offer-letter', { internshipId: e3 });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  await call('PATCH', `/admin/internships/${e3}/status`, { status: 'Active' }); await call('PATCH', `/admin/internships/${e3}/status`, { status: 'Completed' });
  await call('PATCH', `/admin/internships/${e3}/certificate-decision`, { decision: 'Approved' });
  const c = await call('POST', '/admin/documents/certificate', { internshipId: e3 });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  for (const [d, land] of [[o.data.document, false], [c.data.document, true]]) {
    const pdf = await adminPdf(d.id); const { pages, box } = pageInfo(pdf);
    assert.ok(isA4(box, land)); if (land) assert.equal(pages, 1);
    if (HAS_PDFTOTEXT) { const t = pdfText(pdf).replace(/\s+/g, ' '); assert.ok(t.includes('Venkata Subrahmanyam'), 'name'); assert.ok(t.includes('Iyer-Krishnamurthy') || t.includes('Iyer- Krishnamurthy'), 'name tail'); assert.ok(/Cloud-Native Deployment/.test(t) && /Practices Internship/.test(t), 'title'); }
  }
});

test('unprintable characters are refused up front without consuming a document number', async () => {
  const e4 = await enroll(client(srv.base), 'deva@example.com', 'Temp Name');
  db.prepare('UPDATE students SET full_name = ? WHERE email = ?').run('अमित शर्मा', 'deva@example.com');
  const seq = () => db.prepare("SELECT last_value v FROM document_sequences WHERE type='offer_letter'").get().v;
  const before = seq(), docsBefore = db.prepare('SELECT COUNT(*) n FROM documents').get().n;
  const r = await call('POST', '/admin/documents/offer-letter', { internshipId: e4 });
  assert.equal(r.status, 422); assert.equal(r.data.error.code, 'UNSUPPORTED_CHARACTERS');
  assert.equal(seq(), before); assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n, docsBefore);
});

test('revocation: validated, audited, hidden from the student, certificate unlinked, replacement allowed', async () => {
  assert.equal((await call('PATCH', `/admin/documents/${cert.id}/revoke`, {})).status, 400);
  assert.equal((await call('PATCH', `/admin/documents/${cert.id}/revoke`, { reason: 'ab' })).status, 400);
  assert.equal((await call('PATCH', '/admin/documents/ELV-DOC-AAAAAAAA/revoke', { reason: 'issued in error' })).status, 404);
  const r = await call('PATCH', `/admin/documents/${cert.id}/revoke`, { reason: 'Issued in error', revokedBy: 'Priya (Admin)' });
  assert.equal(r.status, 200); assert.equal(r.data.document.status, 'Revoked'); assert.equal(r.data.document.revokedReason, 'Issued in error');
  assert.deepEqual(r.data.document.events.map((e) => e.event), ['created', 'issued', 'revoked']);
  assert.equal(r.data.document.events.at(-1).actor, 'Priya (Admin)'); assert.match(r.data.document.events.at(-1).actorKey, /^[0-9a-f]{8}$/);
  assert.equal((await call('PATCH', `/admin/documents/${cert.id}/revoke`, { reason: 'again please' })).data.error.code, 'ALREADY_REVOKED');
  // Stage 06C: the student still sees it, clearly marked Revoked, can no longer preview/download it, and is told
  const shown = (await asha.get('/student/documents')).data.documents.find((d) => d.id === cert.id);
  assert.equal(shown.status, 'Revoked'); assert.equal(shown.available, false); assert.ok(shown.revokedAt);
  assert.equal(JSON.stringify(shown).includes('Issued in error'), false); // the admin's internal reason is never shown to the student
  assert.equal((await asha.get(`/student/documents/${cert.id}`)).data.document.status, 'Revoked');
  const gone = await asha.get(`/student/documents/${cert.id}/file`);
  assert.equal(gone.status, 410); assert.equal(gone.data.error.code, 'DOCUMENT_REVOKED');
  assert.equal((await ravi.get(`/student/documents/${cert.id}`)).status, 404); // someone else's revoked document is still just a 404
  assert.ok((await asha.get('/student/notifications')).data.notifications.some((n) => n.type === 'document_revoked'));
  assert.equal(db.prepare('SELECT certificate_id FROM enrollments WHERE id = ?').get(ashaEnr).certificate_id, null);
  // admin keeps the file for audit; the public projection must report it as not valid
  assert.equal((await fetch(`${srv.base}/admin/documents/${cert.id}/file`, { headers: adminH })).status, 200);
  const { toPublicVerification } = await import('../src/documents/verification.js');
  const { findAny } = await import('../src/db/documents.js');
  assert.equal(toPublicVerification(findAny(cert.id)).valid, false);
  // a replacement can be issued and gets a new number; the revoked one stays revoked
  const again = await call('POST', '/admin/documents/certificate', { internshipId: ashaEnr });
  assert.equal(again.status, 201); assert.notEqual(again.data.document.documentNumber, cert.documentNumber);
  const listed = (await call('GET', `/admin/documents?internshipId=${ashaEnr}&type=certificate`)).data.documents;
  assert.deepEqual(listed.map((d) => d.status).sort(), ['Issued', 'Revoked']);
  assert.equal((await call('GET', '/admin/documents?status=Bogus')).status, 400);
});

test('existing 05C upload route still works and shares the duplicate rules', async () => {
  const e5 = await enroll(client(srv.base), 'upload@example.com', 'Uma Rao');
  const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
  const up = await fetch(`${srv.base}/admin/internships/${e5}/documents?type=offer_letter`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', ...adminH }, body: PDF });
  assert.equal(up.status, 201);
  assert.equal((await call('POST', '/admin/documents/offer-letter', { internshipId: e5 })).data.error.code, 'DOCUMENT_EXISTS');
});
