import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'k'.repeat(40);
const adminH = { 'X-Admin-Key': KEY };
let srv, db, numbering, verification, elig, data, org, asha, enrollmentId;
const get = (p, h = adminH) => fetch(srv.base + p, { headers: h });

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, ORG_ADDRESS: '', ORG_SIGNATORY_NAME: '' });
  ({ db } = await import('../src/db/index.js'));
  numbering = await import('../src/documents/numbering.js');
  verification = await import('../src/documents/verification.js');
  elig = await import('../src/documents/eligibility.js');
  data = await import('../src/documents/data.js');
  org = await import('../src/documents/organization.js');
  asha = client(srv.base);
  await asha.post('/auth/register', validStudent());
  const app = await asha.post('/applications', validApplication());
  const id = app.data?.application?.id;
  assert.ok(id, JSON.stringify(app.data));
  globalThis.__appId = id;
});
after(() => srv.close());

const j = (m, p, b) => fetch(srv.base + p, { method: m, headers: { 'Content-Type': 'application/json', ...adminH }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

test('migration 5 created the document foundation; students cannot see drafts', () => {
  const cols = db.prepare('PRAGMA table_info(documents)').all().map((c) => c.name);
  for (const c of ['status', 'document_number', 'verification_code', 'template_version', 'application_id', 'internship_id', 'issued_by', 'snapshot', 'created_at']) assert.ok(cols.includes(c), c);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='document_sequences'").get());
  assert.throws(() => db.prepare("INSERT INTO documents (id,student_id,enrollment_id,application_id,internship_id,type,status,title,template_version,created_at) VALUES ('x','s','e','a','i','offer_letter','Issued','t','v','now')").run());
});

test('eligibility: pure rules', () => {
  const e = (o) => ({ applicationStatus: 'Approved', status: 'Active', startDate: '2027-02-01', expectedEndDate: '2027-04-02', completedAt: null, ...o });
  assert.equal(elig.checkEligibility({ type: 'offer_letter', enrollment: e({}) }).eligible, true);
  assert.equal(elig.checkEligibility({ type: 'offer_letter', enrollment: e({ applicationStatus: 'Submitted' }) }).code, 'APPLICATION_NOT_APPROVED');
  assert.equal(elig.checkEligibility({ type: 'offer_letter', enrollment: e({ status: 'Cancelled' }) }).code, 'ENROLLMENT_CLOSED');
  assert.equal(elig.checkEligibility({ type: 'offer_letter', enrollment: e({ startDate: null }), strict: true }).code, 'ENROLLMENT_DATES_MISSING');
  assert.equal(elig.checkEligibility({ type: 'certificate', enrollment: e({}) }).code, 'ENROLLMENT_NOT_COMPLETED');
  assert.equal(elig.checkEligibility({ type: 'certificate', enrollment: e({ status: 'Completed' }) }).code, 'ENROLLMENT_NOT_COMPLETED'); // no completed_at stamp
  assert.equal(elig.checkEligibility({ type: 'certificate', enrollment: e({ status: 'Completed', completedAt: '2027-04-02T10:00:00.000Z' }), strict: true }).eligible, true);
  assert.equal(elig.checkEligibility({ type: 'certificate', enrollment: e({ status: 'Completed', completedAt: '2027-01-01T00:00:00.000Z' }), strict: true }).code, 'COMPLETION_BEFORE_START');
  assert.equal(elig.checkEligibility({ type: 'offer_letter', enrollment: e({}), existing: { status: 'Issued' } }).code, 'DOCUMENT_EXISTS');
  assert.equal(elig.checkEligibility({ type: 'offer_letter', enrollment: e({}), existing: { status: 'Revoked' } }).eligible, true);
  assert.throws(() => data.buildCertificateData({ enrollment: e({}), student: { fullName: 'A', email: 'a@b.c' } }), /completed internship/);
});

test('numbering is sequential per type and year; verification codes are well-formed and unique', () => {
  const a = numbering.allocateNumber('offer_letter'), b = numbering.allocateNumber('offer_letter'), c = numbering.allocateNumber('certificate');
  assert.match(a, numbering.NUMBER_RE); assert.match(c, /^ELV-CRT-\d{4}-000001$/);
  assert.equal(Number(b.slice(-6)), Number(a.slice(-6)) + 1);
  const codes = new Set(Array.from({ length: 500 }, verification.newVerificationCode));
  assert.equal(codes.size, 500); for (const x of codes) assert.match(x, verification.VERIFICATION_RE);
  assert.equal(verification.toPublicVerification({ status: 'Draft' }), null);
  const pub = verification.toPublicVerification({ status: 'Issued', type: 'certificate', documentNumber: c, issuedAt: 'x', storageKey: 'SECRET', studentId: 'S', snapshot: { student: { fullName: 'A', email: 'a@b.c' }, internship: { title: 'T' } } });
  assert.deepEqual(Object.keys(pub).sort(), ['documentNumber', 'durationDays', 'elvoraId', 'internshipTitle', 'issuedAt', 'organizationName', 'result', 'revokedAt', 'status', 'studentName', 'type', 'valid']);
});

test('registration details appear only when verified and complete; colours are validated', () => {
  const base = { name: 'ELVORA', registrationLabel: 'Udyam', registrationNumber: 'X-1', colorPrimary: 'red' };
  assert.equal(org.getOrganization({ ...base, registrationVerified: false }).registration, null);
  assert.equal(org.getOrganization({ ...base, registrationVerified: true, registrationNumber: '' }).registration, null);
  assert.deepEqual(org.getOrganization({ ...base, registrationVerified: true }).registration, { label: 'Udyam', number: 'X-1' });
  assert.equal(org.getOrganization(base).colors.primary, '#1D4ED8');
  assert.match(org.getOrganization({ ...base }).logo.dataUri, /^data:image\/svg\+xml;base64,/);
});

test('admin only: previews and eligibility need the key', async () => {
  for (const p of ['/admin/document-templates', '/admin/document-templates/offer_letter/preview', '/admin/internships/ELV-INT-AAAAAAAA/documents/offer_letter/eligibility']) {
    assert.equal((await get(p, {})).status, 401, p);
    assert.equal((await get(p, { cookie: 'elvora_session=x' })).status, 401, p);
  }
});

test('sample previews: A4, watermarked, placeholders visible, nothing invented, long text handled', async () => {
  for (const type of ['offer_letter', 'certificate']) {
    const r = await get(`/admin/document-templates/${type}/preview`);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    const h = await r.text();
    assert.match(h, /@page\{size:A4 (portrait|landscape)/); assert.match(h, /SAMPLE PREVIEW/);
    assert.match(h, /\[Official address\]/); assert.match(h, /Digital signature of Gowtham/); assert.match(h, /Chief Executive Officer \(CEO\)/); // the CEO is the default signatory
    assert.doesNotMatch(h, /Kish?ore/i);
    assert.match(h, /Elvora ID/); assert.match(h, /ELV-7K3Q9XMD/); assert.match(h, /ELV-VER-XXXX-XXXX-XXXX/); assert.match(h, /QR code placeholder/);
    assert.doesNotMatch(h, /Udyam|MSME|ISO|accredited/i); assert.doesNotMatch(h, /<script/i);
  }
  const long = await (await get('/admin/document-templates/certificate/preview?stress=1')).text();
  assert.match(long, /Venkata Subrahmanyam Chandrasekharan/); assert.match(long, /font-size:(1[89]|2\d(\.\d)?)pt/);
  const none = await get('/admin/document-templates/passport/preview'); assert.equal(none.status, 404);
});

test('escaping: hostile names never become markup', async () => {
  const { renderHtml } = await import('../src/documents/renderers/index.js');
  const h = renderHtml(data.buildDocumentData('offer_letter', { enrollment: data.SAMPLE.enrollment, student: { fullName: '<img src=x onerror=alert(1)>', email: 'a@b.c' }, preview: 'sample' }));
  assert.doesNotMatch(h, /<img src=x/); assert.match(h, /&lt;img src=x/);
});

test('real internships: certificate draft refused until Completed; offer draft after approval; students cannot reach any of it', async () => {
  const appId = globalThis.__appId;
  assert.equal((await j('PATCH', `/admin/applications/${appId}/status`, { status: 'Approved' })).status, 200);
  const created = await j('POST', `/admin/applications/${appId}/internship`, { startDate: '2027-02-01' });
  assert.equal(created.status, 201); enrollmentId = created.data.internship.id;
  const el = await get(`/admin/internships/${enrollmentId}/documents/offer_letter/eligibility`).then((r) => r.json());
  assert.equal(el.eligibility.eligible, true); assert.equal(el.eligibility.organizationReady, false);
  assert.ok(el.eligibility.missingConfiguration.includes('ORG_ADDRESS'));
  assert.equal(el.eligibility.enrollment, undefined);
  // Stage 06B: real issuance is refused while organization details are missing, and consumes no number.
  const seqBefore = JSON.stringify(db.prepare('SELECT * FROM document_sequences ORDER BY type, year').all());
  const blocked = await j('POST', '/admin/documents/offer-letter', { internshipId: enrollmentId });
  assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'ORGANIZATION_INCOMPLETE');
  assert.ok(blocked.data.error.details.missing.includes('ORG_ADDRESS'));
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM document_sequences ORDER BY type, year').all()), seqBefore);
  const prev = await get(`/admin/internships/${enrollmentId}/documents/offer_letter/preview`);
  assert.equal(prev.status, 200); const h = await prev.text();
  assert.match(h, /DRAFT — NOT ISSUED/); assert.match(h, /Asha Verma/); assert.doesNotMatch(h, /\+91 98765/);
  const cert = await get(`/admin/internships/${enrollmentId}/documents/certificate/preview`);
  assert.equal(cert.status, 409); assert.equal((await cert.json()).error.code, 'ENROLLMENT_NOT_COMPLETED');
  // Completion earlier than the stated start date is refused (a future start with completion "today" is inconsistent data).
  await j('PATCH', `/admin/internships/${enrollmentId}/status`, { status: 'Active' });
  await j('PATCH', `/admin/internships/${enrollmentId}/status`, { status: 'Completed' });
  const inconsistent = await get(`/admin/internships/${enrollmentId}/documents/certificate/preview`);
  assert.equal(inconsistent.status, 409); assert.equal((await inconsistent.json()).error.code, 'COMPLETION_BEFORE_START');
  db.prepare('UPDATE enrollments SET start_date = ? WHERE id = ?').run('2026-01-01', enrollmentId); // admin corrects the record
  const ok = await get(`/admin/internships/${enrollmentId}/documents/certificate/preview`);
  assert.equal(ok.status, 200); assert.match(await ok.text(), /successfully completed/);
  assert.equal((await asha.get(`/admin/internships/${enrollmentId}/documents/certificate/preview`)).status, 403);
  assert.deepEqual((await asha.get('/student/documents')).data.documents, []); // previews never create student-visible documents
  assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n, 0);
});
