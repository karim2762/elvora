// Stage 08A part 2 - Task 8: upload + document lifecycle security. Real HTTP against the real app, in-memory DB, temporary storage folder.
// Only synthetic files are used (a tiny fake "PDF" header and a few bytes of PNG/JPEG magic); no private document is ever read or printed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1';
let srv, dir, db, boss, asha, ravi, anon, adminCookie, ashaCookie, raviEnr, ashaEnr, ashaDocId, ashaDocKey;
const pdf = (extra = 64) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(extra, 0x20), Buffer.from('\n%%EOF')]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const raw = (method, p, body, headers = {}, cookie = '') => fetch(srv.base + p, { method, headers: { ...(cookie ? { cookie } : {}), ...headers }, body });
const login = async (email, route = '/auth/login') => (await fetch(srv.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) })).headers.getSetCookie()[0].split(';')[0];
async function enroll(c, over = {}) {
  const a = await c.post('/applications', validApplication(over)); assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal((await boss.patch(`/admin/applications/${a.data.application.id}/status`, { status: 'Approved', note: 'ok' })).status, 200);
  const e = await boss.post(`/admin/applications/${a.data.application.id}/internship`, {}); assert.equal(e.status, 201, JSON.stringify(e.data));
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); // an offer letter needs the internship dates
  assert.equal((await boss.patch(`/admin/internships/${e.data.internship.id}/activate`, { startDate: day(-10), expectedEndDate: day(20) })).status, 200);
  return e.data.internship.id;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-08a-up-'));
  srv = await startServer({ DOCUMENTS_DIR: path.join(dir, 'documents'), MAX_DOCUMENT_MB: '1', RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000',
    ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Priya Rao', ORG_SIGNATORY_TITLE: 'Director' });
  ({ db } = await import('../src/db/index.js'));
  [anon, asha, ravi] = [1, 2, 3].map(() => client(srv.base));
  assert.equal((await asha.post('/auth/register', validStudent())).status, 201);
  assert.equal((await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar', degree: 'MCA', academicYear: '1st Year' }))).status, 201);
  boss = client(srv.base);
  assert.equal((await boss.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js'); setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await boss.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  adminCookie = await login('boss@example.com', '/auth/admin/login'); ashaCookie = await login('asha@example.com');
  ashaEnr = await enroll(asha); raviEnr = await enroll(ravi, { internshipId: 'ELV-PY-001' });
  const d = await boss.post('/admin/documents/offer-letter', { internshipId: ashaEnr }); assert.equal(d.status, 201, JSON.stringify(d.data));
  ashaDocId = d.data.document.id; ashaDocKey = db.prepare('SELECT storage_key FROM documents WHERE id = ?').get(ashaDocId).storage_key;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- PDF upload validation
test('upload: only administrators may upload (anonymous 401, student 403) and nothing is stored for them', async () => {
  const before = fs.readdirSync(path.join(dir, 'documents')).length;
  for (const [cookie, want] of [['', 401], [ashaCookie, 403]]) {
    const r = await raw('POST', `/admin/internships/${raviEnr}/documents?type=offer_letter`, pdf(), { 'Content-Type': 'application/pdf' }, cookie);
    assert.equal(r.status, want);
  }
  assert.equal(fs.readdirSync(path.join(dir, 'documents')).length, before);
});

test('upload: wrong MIME type, empty body, fake PDF signature and executable/HTML/script payloads are all rejected (400) and never stored', async () => {
  const before = fs.readdirSync(path.join(dir, 'documents')).length;
  const url = `/admin/internships/${raviEnr}/documents?type=offer_letter`;
  const cases = [
    ['text/plain', pdf()], ['image/png', pdf()], ['application/octet-stream', pdf()], ['application/json', Buffer.from('{"a":1}')], // type not accepted -> body never read as a file
    ['application/pdf', Buffer.alloc(0)],
    ['application/pdf', Buffer.from('<html><script>alert(1)</script></html>')],
    ['application/pdf', Buffer.from('MZ\x90\x00\x03\x00\x00\x00 fake windows executable header')],
    ['application/pdf', Buffer.from('#!/bin/sh\nrm -rf /\n')],
    ['application/pdf', Buffer.from(' %PDF-1.4 leading space is not a PDF signature')],
    ['application/pdf', Buffer.from('%PDX-1.4 near miss')],
  ];
  for (const [type, body] of cases) {
    const r = await raw('POST', url, body, { 'Content-Type': type }, adminCookie);
    assert.equal(r.status, 400, `${type} ${body.subarray(0, 10).toString('latin1')}`);
  }
  assert.equal(fs.readdirSync(path.join(dir, 'documents')).length, before, 'no file was written by a rejected upload');
});

test('upload: size limit is enforced (MAX_DOCUMENT_MB=1 -> 1 MB + 1 byte is refused with 413 and nothing is stored)', async () => {
  const before = fs.readdirSync(path.join(dir, 'documents')).length;
  const r = await raw('POST', `/admin/internships/${raviEnr}/documents?type=offer_letter`, pdf(1024 * 1024), { 'Content-Type': 'application/pdf' }, adminCookie);
  assert.equal(r.status, 413);
  assert.equal(fs.readdirSync(path.join(dir, 'documents')).length, before);
});

test('upload: type/title parameters are validated (unknown type, control characters and over-long titles are refused)', async () => {
  for (const q of ['type=resume', 'type=', 'type=offer_letter&title=ab', `type=offer_letter&title=${'x'.repeat(121)}`]) {
    const r = await raw('POST', `/admin/internships/${raviEnr}/documents?${q}`, pdf(), { 'Content-Type': 'application/pdf' }, adminCookie);
    assert.equal(r.status, 400, q);
  }
  for (const id of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', 'ELV-INT-%00', 'ELV-INT-NOPE0000', '%2e%2e%2f']) {
    const r = await raw('POST', `/admin/internships/${id}/documents?type=offer_letter`, pdf(), { 'Content-Type': 'application/pdf' }, adminCookie);
    assert.equal(r.status, 404, id);
  }
});

test('upload: a valid PDF is stored under a random server-chosen name; a hostile title cannot influence the storage path or the download file name', async () => {
  const r = await raw('POST', `/admin/internships/${raviEnr}/documents?type=offer_letter&title=${encodeURIComponent('../../evil.pdf')}`, pdf(), { 'Content-Type': 'application/pdf' }, adminCookie);
  assert.equal(r.status, 201, await r.clone().text());
  const row = db.prepare("SELECT storage_key AS k, file_name AS f FROM documents WHERE enrollment_id = ? AND type = 'offer_letter'").get(raviEnr);
  assert.match(row.k, /^[0-9a-f]{48}$/); assert.match(row.f, /^ELVORA-Offer-Letter-ELV-[A-Z0-9]+\.pdf$/);
  const files = fs.readdirSync(path.join(dir, 'documents')); assert.ok(files.includes(`${row.k}.pdf`));
  for (const f of files) assert.match(f, /^[0-9a-f]{48}\.pdf$/, 'every stored file has a random hex name and nothing else');
  assert.equal(fs.existsSync(path.join(dir, 'evil.pdf')), false);
});

// ---------------------------------------------------------------- storage location + permissions
test('storage: private files are owner-only on disk and live outside every public/static directory; nothing serves them statically', async () => {
  const docsDir = path.join(dir, 'documents'); const f = path.join(docsDir, `${ashaDocKey}.pdf`);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f).mode & 0o077, 0, 'file readable only by its owner');
    assert.equal(fs.statSync(docsDir).mode & 0o077, 0, 'folder accessible only by its owner');
  }
  const client_ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');
  const { config } = await import('../src/config/index.js');
  assert.equal(path.resolve(config.documentsDir).startsWith(client_), false, 'default storage is never under client/ (public/ or dist/)');
  const defaultDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/documents');
  assert.equal(defaultDir.startsWith(path.join(client_, 'public')) || defaultDir.startsWith(path.join(client_, 'dist')), false);
  for (const p of [`/${ashaDocKey}.pdf`, `/storage/documents/${ashaDocKey}.pdf`, `/documents/${ashaDocKey}.pdf`, `/static/${ashaDocKey}.pdf`, `/../storage/documents/${ashaDocKey}.pdf`]) {
    for (const base of [srv.base.replace('/api/v1', ''), srv.base]) assert.equal((await fetch(base + p)).status, 404, p);
  }
});

// ---------------------------------------------------------------- download authorization
test('download: anonymous 401; wrong student, malformed id and traversal attempts all get the same 404; admin routes refuse students', async () => {
  const f = `/student/documents/${ashaDocId}/file`;
  assert.equal((await raw('GET', f)).status, 401);
  const rav = await login('ravi@example.com');
  const other = await raw('GET', f, undefined, {}, rav); assert.equal(other.status, 404);
  const missing = await raw('GET', '/student/documents/ELV-DOC-AAAAAAAA/file', undefined, {}, rav); assert.equal(missing.status, 404);
  assert.equal((await other.json()).error.code, (await missing.json()).error.code, 'a foreign document is indistinguishable from a non-existent one');
  for (const id of ['..%2f..%2fetc%2fpasswd', '%2e%2e%2f%2e%2e%2fpackage.json', `${ashaDocId}%2f..%2f..`, `${ashaDocId}%00.pdf`, 'ELV-DOC-%27%20OR%201%3D1', ashaDocKey]) {
    const r = await raw('GET', `/student/documents/${id}/file`, undefined, {}, ashaCookie); assert.equal(r.status, 404, id);
    assert.doesNotMatch(await r.text(), /root:|"name":|%PDF-/);
  }
  for (const p of [`/admin/documents/${ashaDocId}/file`, '/admin/documents', `/admin/documents/${ashaDocId}`]) assert.equal((await raw('GET', p, undefined, {}, rav)).status, 403, p);
  assert.equal((await raw('GET', `/admin/documents/${ashaDocId}/file`)).status, 401);
});

test('download: the owner gets the real PDF with safe headers (nosniff, private/no-store, sanitized file name, attachment on request)', async () => {
  const r = await raw('GET', `/student/documents/${ashaDocId}/file?download=1`, undefined, {}, ashaCookie);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.match(r.headers.get('cache-control'), /private/); assert.match(r.headers.get('cache-control'), /no-store/);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="[A-Za-z0-9._-]+"$/);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString('latin1'), '%PDF-');
  const inline = await raw('GET', `/student/documents/${ashaDocId}/file`, undefined, {}, ashaCookie); assert.match(inline.headers.get('content-disposition'), /^inline;/);
  assert.doesNotMatch(JSON.stringify(Object.fromEntries(r.headers)), new RegExp(ashaDocKey), 'the storage key never appears in any response header');
});

test('student document records never expose the storage key, hash or another student\'s data', async () => {
  const list = JSON.stringify((await asha.get('/student/documents')).data); const one = JSON.stringify((await asha.get(`/student/documents/${ashaDocId}`)).data);
  for (const body of [list, one]) { assert.ok(!body.includes(ashaDocKey)); assert.doesNotMatch(body, /storageKey|storage_key|sha256|studentId/i); }
  assert.equal((await ravi.get(`/student/documents/${ashaDocId}`)).status, 404);
});

// ---------------------------------------------------------------- revoked documents
test('revoked: the owner can no longer preview or download (410), the list reports available:false, public verification reports it revoked; the admin audit copy remains by design', async () => {
  const rv = await boss.patch(`/admin/documents/${ashaDocId}/revoke`, { reason: 'Issued in error (test)' }); assert.equal(rv.status, 200, JSON.stringify(rv.data));
  for (const q of ['', '?download=1']) { const r = await raw('GET', `/student/documents/${ashaDocId}/file${q}`, undefined, {}, ashaCookie); assert.equal(r.status, 410, q); assert.equal((await r.json()).error.code, 'DOCUMENT_REVOKED'); assert.doesNotMatch(r.headers.get('content-type'), /pdf/); }
  const rec = (await asha.get(`/student/documents/${ashaDocId}`)).data.document; assert.equal(rec.status, 'Revoked'); assert.equal(rec.available, false);
  assert.equal(JSON.stringify(rec).includes('Issued in error'), false, 'the internal revocation reason is not shown to the student');
  const ref = db.prepare('SELECT verification_code AS c FROM documents WHERE id = ?').get(ashaDocId).c;
  const pub = await fetch(`${srv.base}/public/documents/verify/${ref}`); const pj = await pub.json(); assert.match(JSON.stringify(pj), /revoked/i); assert.doesNotMatch(JSON.stringify(pj), /storage|\.pdf|sha256/i);
  const adm = await raw('GET', `/admin/documents/${ashaDocId}/file`, undefined, {}, adminCookie); assert.equal(adm.status, 200, 'administrators keep read access to revoked records for audit');
});

// ---------------------------------------------------------------- logo upload
test('logo: administrator session only (the shared key and students are refused); PNG/JPEG only, verified by file signature, 512 KB max; SVG and spoofed types are rejected', async () => {
  assert.equal((await raw('PUT', '/admin/settings/logo', png, { 'Content-Type': 'image/png' })).status, 401);
  assert.equal((await raw('PUT', '/admin/settings/logo', png, { 'Content-Type': 'image/png' }, ashaCookie)).status, 403);
  const bad = [
    ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['image/gif', Buffer.from('GIF89a....')], ['text/html', Buffer.from('<script>1</script>')], ['application/pdf', pdf()],
    ['image/png', Buffer.from('<html><script>alert(1)</script></html>')], // claims PNG, is HTML
    ['image/png', Buffer.from('GIF89a\x01\x00\x01\x00 gif labelled as png')], ['image/jpeg', Buffer.from('MZ fake exe')], ['image/png', Buffer.alloc(0)],
    ['image/png', Buffer.concat([png, Buffer.alloc(600 * 1024, 3)])], // over the 600 KB body cap
  ];
  const brandingDir = path.join(dir, 'branding');
  for (const [type, body] of bad) { const r = await raw('PUT', '/admin/settings/logo', body, { 'Content-Type': type }, adminCookie); assert.ok([400, 413].includes(r.status), `${type} -> ${r.status}`); }
  const mid = Buffer.concat([png, Buffer.alloc(520 * 1024, 3)]); assert.equal((await raw('PUT', '/admin/settings/logo', mid, { 'Content-Type': 'image/png' }, adminCookie)).status, 400, 'between 512 KB and 600 KB reaches the service limit');
  assert.equal(fs.existsSync(brandingDir) ? fs.readdirSync(brandingDir).length : 0, 0, 'no rejected logo was written to disk');
});

test('logo: a valid PNG and then a JPEG are accepted, stored under random names (old file removed), owner-only, and the change is audited', async () => {
  const a = await raw('PUT', '/admin/settings/logo', png, { 'Content-Type': 'image/png' }, adminCookie); assert.equal(a.status, 200, await a.clone().text());
  const brandingDir = path.join(dir, 'branding'); let files = fs.readdirSync(brandingDir); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{32}\.png$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(brandingDir, files[0])).mode & 0o077, 0);
  const b = await raw('PUT', '/admin/settings/logo', jpg, { 'Content-Type': 'image/jpeg' }, adminCookie); assert.equal(b.status, 200);
  files = fs.readdirSync(brandingDir); assert.equal(files.length, 1, 'the previous logo file was deleted'); assert.match(files[0], /^[a-f0-9]{32}\.jpg$/);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'settings.logo_update'").get().n >= 2);
  assert.equal((await raw('GET', `/../branding/${files[0]}`)).status, 404);
});
