import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, client, validStudent, validApplication } from './helpers.js';

// Stage 06C: QR verification, public verification endpoint, student integration, revocation, privacy.
const KEY = 'k'.repeat(40);
const adminH = { 'X-Admin-Key': KEY };
const CLIENT_URL = 'http://localhost:5173';
const MISS_MAX = 40; // generous for the earlier tests (every miss, malformed lookup and unknown /public path counts); the last test uses up the rest
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-ver-docs-'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-ver-scratch-'));
const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const HAS_QR_TOOLS = !spawnSync('pdftoppm', ['-v']).error && spawnSync('python3', ['-c', 'import cv2; cv2.QRCodeDetector']).status === 0;
let srv, db, docsDb, asha, ravi, ashaEnr, raviEnr, ashaId, raviId, offer, cert;

const call = (m, p, b, h = adminH) => fetch(srv.base + p, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b === undefined ? undefined : JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, headers: r.headers, data: await r.json().catch(() => null) }));
const verify = (ref, h = {}) => fetch(`${srv.base}/public/documents/verify/${encodeURIComponent(ref)}`, { headers: h })
  .then(async (r) => ({ status: r.status, headers: r.headers, data: await r.json().catch(() => null) }));
const login = async (email) => (await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Str0ng!Pass1' }) })).headers.getSetCookie()[0].split(';')[0];
const adminPdf = async (id) => Buffer.from(await (await fetch(`${srv.base}/admin/documents/${id}/file`, { headers: adminH })).arrayBuffer());

// Renders every PDF page to PNG at `dpi` and returns the text of the first QR code found (what a phone camera would read).
const PY = 'import cv2,sys\nd=cv2.QRCodeDetector()\nfor f in sys.argv[1:]:\n    v,_,_=d.detectAndDecode(cv2.imread(f))\n    if v:\n        print(v); break\n';
function scanQr(pdf, dpi = 300) {
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(scratch, `${id}.pdf`), pdf);
  spawnSync('pdftoppm', ['-r', String(dpi), '-png', path.join(scratch, `${id}.pdf`), path.join(scratch, id)]);
  const pngs = fs.readdirSync(scratch).filter((f) => f.startsWith(`${id}-`) && f.endsWith('.png')).sort().map((f) => path.join(scratch, f));
  return spawnSync('python3', ['-c', PY, ...pngs], { encoding: 'utf8' }).stdout.trim();
}

async function enroll(c, email, name) {
  await c.post('/auth/register', validStudent({ email, fullName: name, phone: email.startsWith('asha') ? '+91 98765 43210' : '+91 91234 56789' }));
  const app = await c.post('/applications', validApplication({ fullName: name }));
  const appId = app.data.application.id;
  assert.equal((await call('PATCH', `/admin/applications/${appId}/status`, { status: 'Approved' })).status, 200);
  const e = await call('POST', `/admin/applications/${appId}/internship`, { startDate: '2026-01-05' });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  return e.data.internship.id;
}

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, DOCUMENTS_DIR: dir, RATE_LIMIT_ADMIN_MAX: '1000', RATE_LIMIT_PUBLIC_VERIFY_MAX: '500', RATE_LIMIT_PUBLIC_VERIFY_MISS_MAX: String(MISS_MAX),
    ORG_NAME: 'ELVORA', ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'A. Signatory', ORG_SIGNATORY_TITLE: 'Director' });
  ({ db } = await import('../src/db/index.js'));
  docsDb = await import('../src/db/documents.js');
  asha = client(srv.base); ravi = client(srv.base);
  ashaEnr = await enroll(asha, 'asha@example.com', 'Asha Verma');
  raviEnr = await enroll(ravi, 'ravi@example.com', 'Ravi Kumar');
  ashaId = db.prepare('SELECT id FROM students WHERE email = ?').get('asha@example.com').id;
  raviId = db.prepare('SELECT id FROM students WHERE email = ?').get('ravi@example.com').id;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true }); });

test('QR decoding tools are available (pdftoppm + OpenCV); QR checks below are skipped without them', () => assert.ok(HAS_QR_TOOLS, 'install poppler-utils and opencv to run the QR scan checks'));

test('lifecycle 1-4: approve, issue offer letter, PDF stored, QR in the PDF decodes to this document’s verification URL', async () => {
  const r = await call('POST', '/admin/documents/offer-letter', { internshipId: ashaEnr, issuedBy: 'Priya (Admin)' });
  assert.equal(r.status, 201, JSON.stringify(r.data)); offer = r.data.document;
  assert.equal(offer.fileAvailable, true);
  assert.match(offer.verificationCode, /^ELV-VER-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  const pdf = await adminPdf(offer.id);
  if (!HAS_QR_TOOLS) return;
  const expected = `${CLIENT_URL}/verify/${offer.verificationCode}`;
  assert.equal(scanQr(pdf, 300), expected, 'QR scanned from a 300 dpi render');
  assert.equal(scanQr(pdf, 150), expected, 'QR still scans from a 150 dpi render (typical office print/scan)');
});

test('QR data contains only the public URL: no email, phone, name, or database IDs', async () => {
  if (!HAS_QR_TOOLS) return;
  const data = scanQr(await adminPdf(offer.id));
  assert.match(data, /^http:\/\/localhost:5173\/verify\/ELV-VER-[A-Z0-9-]+$/);
  for (const secret of ['asha@example.com', '98765', 'Asha', 'Verma', offer.id, ashaEnr, ashaId, 'ELV-APP', 'ELV-INT']) assert.ok(!data.includes(secret), `QR must not contain ${secret}`);
});

test('lifecycle 5-6: the student sees and downloads their offer letter', async () => {
  const list = (await asha.get('/student/documents')).data.documents;
  const d = list.find((x) => x.id === offer.id);
  assert.ok(d); assert.equal(d.status, 'Issued'); assert.equal(d.available, true);
  assert.equal(d.documentNumber, offer.documentNumber); assert.equal(d.verificationCode, offer.verificationCode);
  assert.equal(d.completionDate, null); // offer letters have no completion date
  for (const hidden of ['storageKey', 'studentId', 'sha256', 'revokedReason', 'snapshot']) assert.equal(d[hidden], undefined);
  const cookie = await login('asha@example.com');
  const f = await fetch(`${srv.base}/student/documents/${offer.id}/file?download=1`, { headers: { cookie } });
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/pdf');
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await f.arrayBuffer())).digest('hex'), offer.sha256);
});

test('lifecycle 7-8: public verification confirms the offer letter is valid, with only approved fields', async () => {
  const r = await verify(offer.verificationCode);
  assert.equal(r.status, 200); assert.equal(r.data.result, 'valid');
  assert.deepEqual(Object.keys(r.data.document).sort(), ['documentNumber', 'durationDays', 'elvoraId', 'internshipTitle', 'issuedAt', 'organizationName', 'result', 'revokedAt', 'status', 'studentName', 'type', 'valid']);
  // The single Elvora ID printed on the document is the one identifier the public page may show (the verifier holds the paper that carries it).
  assert.deepEqual({ ...r.data.document, issuedAt: 'x' }, { valid: true, result: 'valid', status: 'Issued', type: 'offer_letter', documentNumber: offer.documentNumber, elvoraId: ashaEnr, studentName: 'Asha Verma',
    internshipTitle: offer.internshipTitle, durationDays: r.data.document.durationDays, issuedAt: 'x', revokedAt: null, organizationName: 'ELVORA' });
  assert.ok(Number.isInteger(r.data.document.durationDays) && r.data.document.durationDays > 0);
  assert.ok(Date.parse(r.data.document.issuedAt));
  // nothing private anywhere in the body
  const body = JSON.stringify(r.data);
  for (const secret of ['asha@example.com', '98765', 'IIT Madras', 'Str0ng', ashaId, offer.id, 'ELV-DOC', 'ELV-INT', 'ELV-APP', 'storage', 'sha256', dir, offer.sha256, 'motivation']) assert.ok(!body.includes(secret), `public body must not include ${secret}`);
});

test('public endpoint: no login needed, ignores cookies and admin keys, sets no cookie, is never cached or indexed', async () => {
  const plain = await verify(offer.verificationCode);
  const withAdmin = await verify(offer.verificationCode, adminH);
  const withCookie = await verify(offer.verificationCode, { cookie: 'elvora_session=whatever' });
  assert.deepEqual(withAdmin.data, plain.data); assert.deepEqual(withCookie.data, plain.data);
  assert.equal(plain.headers.get('set-cookie'), null);
  assert.equal(plain.headers.get('cache-control'), 'no-store'); assert.match(plain.headers.get('x-robots-tag'), /noindex/);
  assert.equal((await verify(offer.verificationCode.toLowerCase())).data.result, 'valid'); // typed in lower case
  assert.equal((await verify(` ${offer.verificationCode} `)).data.result, 'valid');
});

test('public endpoint is read-only: it cannot issue, edit or delete anything', async () => {
  const before = JSON.stringify(db.prepare('SELECT * FROM documents').all());
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await fetch(`${srv.base}/public/documents/verify/${offer.verificationCode}`, { method: m, headers: { 'Content-Type': 'application/json', ...adminH }, body: m === 'DELETE' ? undefined : JSON.stringify({ status: 'Revoked' }) });
    assert.equal(r.status, 404, m);
  }
  for (const p of ['/public/documents', '/public/documents/verify', '/public/students', '/public/admin/documents']) assert.equal((await fetch(srv.base + p)).status, 404, p);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM documents').all()), before);
});

test('invalid and unknown references: safe, uniform responses (no stack traces, no hints)', async () => {
  const malformed = ['abc', 'ELV-VER-AAAA-AAAA', 'ELV-VER-AAAA-AAAA-AAAA-AAAA', 'ELV-VER-0000-OOOO-IIII', "ELV-VER-AAAA-AAAA-AAAA' OR 1=1--", 'x'.repeat(300)];
  for (const m of malformed.slice(0, 3)) { // (budget: invalid and unknown lookups are limited per IP, see the last test)
    const r = await verify(m);
    assert.equal(r.status, 400, m); assert.equal(r.data.result, 'invalid'); assert.deepEqual(Object.keys(r.data).sort(), ['message', 'result']);
  }
  const unknown = await verify('ELV-VER-AAAA-BBBB-CCCC');
  assert.equal(unknown.status, 404); assert.equal(unknown.data.result, 'not_found'); assert.deepEqual(Object.keys(unknown.data).sort(), ['message', 'result']);
  assert.ok(!/sql|stack|at \w+ \(|node_modules/i.test(JSON.stringify(unknown.data)));
});

test('a Draft (number allocated, never issued) is "not found", indistinguishable from an unknown reference', async () => {
  const enrollment = (await import('../src/db/enrollments.js')).findById(raviEnr);
  const draft = docsDb.createDraft({ enrollment, type: 'offer_letter', title: 'Internship Offer Letter', templateVersion: 'offer-letter@1', snapshot: { student: { fullName: 'Ravi Kumar', email: 'ravi@example.com' }, internship: { title: 'x' } }, actor: 't', actorKey: 't' });
  const r = await verify(draft.verificationCode);
  const unknown = await verify('ELV-VER-AAAA-BBBB-CCCC');
  assert.equal(r.status, 404); assert.deepEqual(r.data, unknown.data);
  assert.equal(JSON.stringify(r.data).includes('Ravi'), false);
  db.prepare("DELETE FROM document_events WHERE document_id = ?").run(draft.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(draft.id); // leave Ravi without a document for the remaining tests
});

test('lifecycle 9-13: internship completed, certificate issued, stored, shown to the student, QR and public verification work', async () => {
  await call('PATCH', `/admin/internships/${ashaEnr}/status`, { status: 'Active' });
  assert.equal((await call('POST', '/admin/documents/certificate', { internshipId: ashaEnr })).data?.error?.code, 'ENROLLMENT_NOT_COMPLETED');
  await call('PATCH', `/admin/internships/${ashaEnr}/status`, { status: 'Completed' });
  await call('PATCH', `/admin/internships/${ashaEnr}/certificate-decision`, { decision: 'Approved' });
  const r = await call('POST', '/admin/documents/certificate', { internshipId: ashaEnr });
  assert.equal(r.status, 201, JSON.stringify(r.data)); cert = r.data.document;
  assert.notEqual(cert.verificationCode, offer.verificationCode);
  const mine = (await asha.get('/student/documents')).data.documents.find((d) => d.id === cert.id);
  assert.equal(mine.type, 'certificate'); assert.equal(mine.status, 'Issued'); assert.equal(mine.documentNumber, cert.documentNumber);
  assert.match(mine.completionDate, /^\d{4}-\d{2}-\d{2}T/); assert.ok(Date.parse(mine.completionDate));
  const pdf = await adminPdf(cert.id);
  if (HAS_QR_TOOLS) assert.equal(scanQr(pdf, 300), `${CLIENT_URL}/verify/${cert.verificationCode}`);
  const v = await verify(cert.verificationCode);
  assert.equal(v.status, 200); assert.equal(v.data.result, 'valid'); assert.equal(v.data.document.type, 'certificate'); assert.equal(v.data.document.studentName, 'Asha Verma');
  assert.equal((await asha.get(`/student/documents/${cert.id}`)).status, 200); // the student can open their own certificate record
});

test('duplicate issuance is refused and does not add a second verifiable document', async () => {
  const r = await call('POST', '/admin/documents/offer-letter', { internshipId: ashaEnr });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'DOCUMENT_EXISTS');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM documents WHERE enrollment_id = ? AND type = 'offer_letter'").get(ashaEnr).n, 1);
});

test('student ownership: another student, or nobody, cannot read or download these documents', async () => {
  for (const id of [offer.id, cert.id]) {
    assert.equal((await ravi.get(`/student/documents/${id}`)).status, 404);
    assert.equal((await ravi.get(`/student/documents/${id}/file`)).status, 404);
    assert.equal((await ravi.get(`/student/documents/${id}/file?download=1`)).status, 404);
    const anon = await fetch(`${srv.base}/student/documents/${id}/file`);
    assert.equal(anon.status, 401);
    assert.equal((await fetch(`${srv.base}/student/documents/${id}/file`, { headers: adminH })).status, 401); // the admin key is not a student session
  }
  assert.deepEqual((await ravi.get('/student/documents')).data.documents, []);
  assert.equal((await ravi.get('/student/documents/ELV-DOC-AAAAAAAA')).status, 404);
  assert.equal((await ravi.get('/student/documents/..%2F..%2Fetc%2Fpasswd/file')).status, 404);
});

test('the public page cannot be used to reach private files: no storage path in any public or student response, no static route', async () => {
  const keys = db.prepare('SELECT storage_key k FROM documents WHERE storage_key IS NOT NULL').all().map((r) => r.k);
  assert.ok(keys.length >= 2);
  const bodies = [JSON.stringify((await verify(offer.verificationCode)).data), JSON.stringify((await verify(cert.verificationCode)).data), JSON.stringify((await asha.get('/student/documents')).data)];
  for (const b of bodies) for (const k of keys) assert.ok(!b.includes(k));
  for (const k of keys) {
    for (const p of [`${srv.base}/public/documents/${k}`, `${srv.base}/public/documents/${k}.pdf`, `${srv.base.replace('/api/v1', '')}/storage/${k}.pdf`, `${srv.base.replace('/api/v1', '')}/${k}.pdf`]) assert.equal((await fetch(p)).status, 404, p);
  }
});

test('student routes cannot change or issue documents (no write route exists, even with a real student session)', async () => {
  const before = JSON.stringify(db.prepare('SELECT * FROM documents').all());
  const cookie = await login('asha@example.com');
  for (const [m, p] of [['PATCH', `/student/documents/${cert.id}`], ['PUT', `/student/documents/${cert.id}`], ['DELETE', `/student/documents/${cert.id}`], ['POST', '/student/documents'], ['PATCH', `/student/documents/${cert.id}/revoke`], ['POST', '/admin/documents/certificate']]) {
    const r = await fetch(srv.base + p, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: m === 'DELETE' ? undefined : JSON.stringify({ internshipId: ashaEnr, status: 'Issued' }) });
    assert.ok([401, 403, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM documents').all()), before);
});

test('lifecycle 14: a revoked certificate verifies as Revoked (not valid), the student sees it marked and cannot download it', async () => {
  const rv = await call('PATCH', `/admin/documents/${cert.id}/revoke`, { reason: 'Issued in error (internal note)', revokedBy: 'Priya (Admin)' });
  assert.equal(rv.status, 200);
  const r = await verify(cert.verificationCode);
  assert.equal(r.status, 200); assert.equal(r.data.result, 'revoked');
  assert.equal(r.data.document.valid, false); assert.equal(r.data.document.status, 'Revoked'); assert.ok(Date.parse(r.data.document.revokedAt));
  assert.ok(!JSON.stringify(r.data).includes('internal note')); // the reason stays private
  const s = (await asha.get('/student/documents')).data.documents.find((d) => d.id === cert.id);
  assert.equal(s.status, 'Revoked'); assert.equal(s.available, false);
  assert.equal((await asha.get(`/student/documents/${cert.id}/file`)).status, 410);
  assert.equal((await verify(offer.verificationCode)).data.result, 'valid'); // the offer letter is unaffected
});

test('uploaded (Stage 05C) documents have no verification reference, so they are not publicly verifiable and nothing breaks', async () => {
  const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
  const up = await fetch(`${srv.base}/admin/internships/${raviEnr}/documents?type=offer_letter`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', ...adminH }, body: PDF });
  assert.equal(up.status, 201);
  const d = (await ravi.get('/student/documents')).data.documents[0];
  assert.equal(d.status, 'Issued'); assert.equal(d.verificationCode, null); assert.equal(d.documentNumber, null); assert.equal(d.available, true);
});

test('configuration: production refuses a non-HTTPS CLIENT_URL (it is printed in QR codes); https and localhost are accepted', () => {
  const run = (clientUrl) => spawnSync(process.execPath, ['-e', "import('./src/config/index.js').then((m)=>console.log(m.config.clientUrl))"], {
    cwd: serverRoot, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(40), CLIENT_URL: clientUrl, CORS_ORIGIN: clientUrl },
  });
  const bad = run('http://portal.example.org'); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /CLIENT_URL must be an https/);
  assert.equal(run('https://portal.example.org').status, 0);
  assert.equal(run('http://localhost:5173').status, 0);
});

test('anti-guessing: repeated lookups that find nothing are rate limited per IP, with a clean 429', async () => {
  const statuses = [];
  for (let i = 0; i < MISS_MAX + 5; i++) { const r = await verify('ELV-VER-AAAA-BBBB-CCCC'); statuses.push(r.status); if (r.status === 429) break; }
  assert.equal(statuses.at(-1), 429, 'a 429 must appear');
  assert.ok(statuses.slice(0, -1).every((s) => s === 404), 'every response before the block is a plain 404');
  assert.ok(statuses.length - 1 < MISS_MAX, 'earlier misses in this file already used part of the budget');
  const blocked = await verify('ELV-VER-AAAA-BBBB-CCCC');
  assert.equal(blocked.status, 429); assert.equal(blocked.data.error.code, 'RATE_LIMITED');
  assert.ok(!JSON.stringify(blocked.data).includes('Asha'));
});
