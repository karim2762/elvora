// Stage 10A Part 1 — private Priority Certificate Processing: access/invitations, ownership, server-side eligibility and pricing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const KEY = 'k'.repeat(40); const adminH = { 'X-Admin-Key': KEY };
const BASE = '/priority-certificate';
let srv, db, svc, asha, ravi, anon, ids = {}, apps = {}, enr = {};
const admin = (m, p, b) => fetch(srv.base + p, { method: m, headers: { 'Content-Type': 'application/json', ...adminH }, body: b === undefined ? undefined : JSON.stringify(b) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

async function enroll(c, email, name, internshipId = 'ELV-PY-001') {
  await c.post('/auth/register', validStudent({ email, fullName: name }));
  const a = await c.post('/applications', validApplication({ fullName: name, internshipId }));
  const appId = a.data.application.id;
  await admin('PATCH', `/admin/applications/${appId}/status`, { status: 'Approved' });
  const e = await admin('POST', `/admin/applications/${appId}/internship`, { startDate: '2026-01-05' });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  return { appId, enrId: e.data.internship.id, days: a.data.application.internship?.durationDays ?? db.prepare('SELECT internship_duration_days d FROM applications WHERE id = ?').get(appId).d };
}
const complete = (enrId, start = '2026-01-05', end = '2026-06-30T10:00:00.000Z') =>
  db.prepare("UPDATE enrollments SET status = 'Completed', start_date = ?, completed_at = ?, expected_end_date = '2026-06-30' WHERE id = ?").run(start, end, enrId);
const invite = (studentId = null, opts = {}) => svc.createInvitation({ studentId, ...opts });

before(async () => {
  srv = await startServer({ ADMIN_API_KEY: KEY, PRIORITY_PUBLIC_ACCESS: 'false' });
  ({ db } = await import('../src/db/index.js'));
  svc = await import('../src/services/priorityCertificate.js');
  asha = client(srv.base); ravi = client(srv.base); anon = client(srv.base);
  const a = await enroll(asha, 'asha@example.com', 'Asha Verma'); const r = await enroll(ravi, 'ravi@example.com', 'Ravi Kumar');
  apps = { asha: a.appId, ravi: r.appId }; enr = { asha: a.enrId, ravi: r.enrId }; ids.days = a.days;
  ids.asha = db.prepare('SELECT id FROM students WHERE email = ?').get('asha@example.com').id;
  ids.ravi = db.prepare('SELECT id FROM students WHERE email = ?').get('ravi@example.com').id;
});
after(() => srv.close());

test('public and logged-out users cannot reach any private endpoint (401)', async () => {
  for (const [m, p] of [['GET', '/access'], ['POST', '/access'], ['GET', '/portal'], ['GET', '/pricing'], ['GET', '/options'], ['POST', '/eligibility'], ['POST', '/requests'], ['GET', '/requests']]) {
    const r = await anon.call?.(m, BASE + p) ?? await (m === 'GET' ? anon.get(BASE + p) : anon.post(BASE + p, {}));
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('signed in but no invitation: access is refused server-side', async () => {
  assert.equal((await asha.get(BASE + '/access')).data.access.state, 'invitation_required');
  for (const p of ['/portal', '/pricing', '/options']) { const r = await asha.get(BASE + p); assert.equal(r.status, 403); assert.equal(r.data.error.code, 'PRIORITY_INVITATION_REQUIRED'); }
  assert.equal((await asha.post(BASE + '/requests', { applicationId: apps.asha, confirmPersonal: true, confirmAcademic: true })).status, 403);
});

test('invitation tokens are random, only a hash is stored, and bad tokens are rejected', async () => {
  const a = invite(); const b = invite();
  assert.notEqual(a.token, b.token); assert.ok(a.token.length >= 40);
  const row = db.prepare('SELECT token_hash FROM priority_invitations WHERE id = ?').get(a.id);
  assert.notEqual(row.token_hash, a.token); assert.equal(db.prepare('SELECT COUNT(*) n FROM priority_invitations WHERE token_hash = ?').get(a.token).n, 0);
  assert.equal((await asha.post(BASE + '/access', { token: 'short' })).data.error.code, 'PRIORITY_INVITATION_INVALID');
  assert.equal((await asha.post(BASE + '/access', { token: 'x'.repeat(43) })).status, 403);
});

test('invitation bound to another student is refused; bound to this student works', async () => {
  const forRavi = invite(ids.ravi);
  const r = await asha.post(BASE + '/access', { token: forRavi.token });
  assert.equal(r.status, 403); assert.equal(r.data.error.code, 'PRIORITY_INVITATION_INVALID');
  assert.equal((await ravi.post(BASE + '/access', { token: forRavi.token })).data.access.granted, true);
  assert.equal((await ravi.get(BASE + '/portal')).status, 200);
});

test('single-use invitation cannot be reused by another student; expired and revoked are rejected', async () => {
  const one = invite(null);
  assert.equal((await asha.post(BASE + '/access', { token: one.token })).data.access.granted, true);
  assert.equal((await asha.post(BASE + '/access', { token: one.token })).status, 200); // same student re-opening is harmless
  const other = client(srv.base); await other.post('/auth/register', validStudent({ email: 'zoe@example.com', fullName: 'Zoe Lane' }));
  assert.equal((await other.post(BASE + '/access', { token: one.token })).data.error.code, 'PRIORITY_INVITATION_USED');
  const exp = invite(null); db.prepare("UPDATE priority_invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(exp.id);
  assert.equal((await other.post(BASE + '/access', { token: exp.token })).data.error.code, 'PRIORITY_EXPIRED');
  const rev = invite(null); svc.revokeInvitation(rev.id);
  assert.equal((await other.post(BASE + '/access', { token: rev.token })).data.error.code, 'PRIORITY_REVOKED');
});

test('revoking or expiring a redeemed invitation ends access immediately', async () => {
  const c = client(srv.base); await c.post('/auth/register', validStudent({ email: 'mia@example.com', fullName: 'Mia Rao' }));
  const i = invite(null); await c.post(BASE + '/access', { token: i.token });
  assert.equal((await c.get(BASE + '/pricing')).status, 200);
  svc.revokeInvitation(i.id);
  let r = await c.get(BASE + '/pricing'); assert.equal(r.status, 403); assert.equal(r.data.error.code, 'PRIORITY_REVOKED');
  const j = invite(null); await c.post(BASE + '/access', { token: j.token }); db.prepare("UPDATE priority_invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(j.id);
  assert.equal((await c.get(BASE + '/access')).data.access.granted, false);
  assert.equal((await c.get(BASE + '/pricing')).status, 403);
});

test('pricing comes from the server; no 7-day option; GST wording is a proposal, no invoice', async () => {
  await asha.post(BASE + '/access', { token: invite(ids.asha).token });
  const p = (await asha.get(BASE + '/pricing')).data;
  assert.deepEqual(p.prices.map((x) => [x.durationDays, x.amountPaise]), [[30, 4900], [60, 9900], [90, 19900]]);
  assert.ok(!p.prices.some((x) => x.durationDays === 7));
  assert.ok(p.prices.every((x) => /subject to confirmation/i.test(x.taxNote)));
  assert.equal(JSON.stringify(p).toLowerCase().includes('invoice number'), false);
});

test('ineligible states are explained; enrollment alone is never completion', async () => {
  let r = (await asha.post(BASE + '/eligibility', { applicationId: apps.asha })).data;
  assert.equal(r.eligible, false); assert.equal(r.state, 'ineligible');
  assert.ok(r.reasons.some((x) => /not started/i.test(x)), r.reasons.join('|'));
  db.prepare("UPDATE enrollments SET status = 'Active' WHERE id = ?").run(enr.asha);
  r = (await asha.post(BASE + '/eligibility', { applicationId: apps.asha })).data;
  assert.ok(r.reasons.some((x) => /in progress/i.test(x)));
  const d = await asha.post(BASE + '/requests', { applicationId: apps.asha, confirmPersonal: true, confirmAcademic: true });
  assert.equal(d.status, 409); assert.equal(d.data.error.code, 'PRIORITY_NOT_ELIGIBLE');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM priority_requests').get().n, 0);
  // the check never changed the internship record
  const e = db.prepare('SELECT status, start_date, completed_at FROM enrollments WHERE id = ?').get(enr.asha);
  assert.deepEqual([e.status, e.start_date, e.completed_at], ['Active', '2026-01-05', null]);
});

test('completed too early for the stated duration is refused (dates are never altered)', async () => {
  complete(enr.asha, '2026-01-05', '2026-01-08T10:00:00.000Z');
  const r = (await asha.post(BASE + '/eligibility', { applicationId: apps.asha })).data;
  assert.equal(r.eligible, false); assert.ok(r.reasons.some((x) => /duration/i.test(x)));
  assert.equal(db.prepare('SELECT completed_at FROM enrollments WHERE id = ?').get(enr.asha).completed_at, '2026-01-08T10:00:00.000Z');
});

test('another student\'s application and request are 404; unknown IDs behave the same', async () => {
  const r = await asha.get(`${BASE}/internships/${apps.ravi}`); assert.equal(r.status, 404);
  assert.equal((await asha.post(BASE + '/eligibility', { applicationId: apps.ravi })).status, 404);
  assert.equal((await asha.post(BASE + '/requests', { applicationId: apps.ravi, confirmPersonal: true, confirmAcademic: true })).status, 404);
  assert.equal((await asha.get(`${BASE}/internships/APP-NOPE`)).status, 404);
  const own = await asha.get(`${BASE}/internships/${apps.asha}`); assert.equal(own.status, 200);
  assert.equal(JSON.stringify((await asha.get(BASE + '/options')).data).includes(apps.ravi), false);
});

test('eligible completed internship: draft saved with a server price; client fee is ignored; draft is idempotent', async () => {
  complete(enr.asha);
  const days = db.prepare('SELECT internship_duration_days d FROM applications WHERE id = ?').get(apps.asha).d;
  if (![30, 60, 90].includes(days)) return; // catalogue item must be a priced duration
  const need = (await asha.post(BASE + '/requests', { applicationId: apps.asha }));
  assert.equal(need.status, 400); // confirmations required
  const body = { applicationId: apps.asha, confirmPersonal: true, confirmAcademic: true, amountPaise: 1, fee: 0, amount: 1, priceId: 'PRC-30-V1', status: 'Payment Verified' };
  const r = await asha.post(BASE + '/requests', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const want = { 30: 4900, 60: 9900, 90: 19900 }[days];
  assert.equal(r.data.request.price.amountPaise, want); assert.equal(r.data.request.status, 'Draft');
  assert.match(r.data.request.nextStep, /nothing has been charged/i);
  const again = await asha.post(BASE + '/requests', body); assert.equal(again.status, 200); assert.equal(again.data.request.id, r.data.request.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM priority_requests').get().n, 1);
  // completion state untouched by the request
  assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(enr.asha).status, 'Completed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM priority_eligibility_checks').get().n > 0, true);
  // ownership of requests and history
  assert.equal((await ravi.get(`${BASE}/requests/${r.data.request.id}`)).status, 404); // ravi redeemed access earlier in this file; someone else's request is still a plain 404 (ownership)
  await ravi.post(BASE + '/access', { token: invite(ids.ravi).token }).catch(() => {});
  assert.equal((await ravi.get(`${BASE}/requests/${r.data.request.id}`)).status, 404);
  assert.equal((await ravi.get(`${BASE}/requests/${r.data.request.id}/history`)).status, 404);
  const h = (await asha.get(`${BASE}/requests/${r.data.request.id}/history`)).data.history; assert.equal(h[0].to, 'Draft');
  assert.equal((await asha.get(BASE + '/requests')).data.requests.length, 1);
});

test('price changes keep the historical snapshot', async () => {
  const dbm = await import('../src/db/priority.js');
  const before = db.prepare('SELECT price_id, amount_paise FROM priority_requests').get();
  dbm.setPrice({ durationDays: 30, months: 1, amountPaise: 5900, taxNote: 'Proposed GST-inclusive customer price, subject to confirmation.' });
  dbm.setPrice({ durationDays: 30, months: 1, amountPaise: 4900, taxNote: 'Proposed GST-inclusive customer price, subject to confirmation.' });
  const after = db.prepare('SELECT price_id, amount_paise FROM priority_requests').get();
  assert.deepEqual(after, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM priority_pricing WHERE duration_days = 30 AND active = 1').get().n, 1);
});

test('pending tasks, certificate already issued and declined review block eligibility', async () => {
  // existing certificate flag
  db.prepare("UPDATE priority_requests SET status = 'Cancelled'").run();
  db.prepare("UPDATE enrollments SET certificate_id = 'ELV-DOC-X', certificate_issued_at = '2026-07-01T00:00:00Z' WHERE id = ?").run(enr.asha);
  let r = (await asha.post(BASE + '/eligibility', { applicationId: apps.asha })).data;
  assert.equal(r.state, 'existing_certificate'); assert.equal(r.eligible, false);
  db.prepare('UPDATE enrollments SET certificate_id = NULL, certificate_issued_at = NULL, certificate_decision = ? WHERE id = ?').run('Declined', enr.asha);
  r = (await asha.post(BASE + '/eligibility', { applicationId: apps.asha })).data;
  assert.equal(r.eligible, false); assert.ok(r.reasons.some((x) => /administrative review/i.test(x)));
  db.prepare("UPDATE enrollments SET certificate_decision = 'Pending' WHERE id = ?").run(enr.asha);
});

test('7-day internships are never eligible for the paid option', async () => {
  const c = client(srv.base);
  const seven = db.prepare("SELECT id FROM internship_listings WHERE duration_days = 7 LIMIT 1").get?.();
  const cat = (await import('../src/internships/catalog.js'));
  const id = (cat.catalog ?? cat.default ?? []).find?.((i) => i.durationDays === 7)?.id ?? seven?.id;
  if (!id) return;
  const x = await enroll(c, 'sev@example.com', 'Sev En', id);
  complete(x.enrId, '2026-01-05', '2026-03-30T00:00:00.000Z');
  await c.post(BASE + '/access', { token: invite().token });
  const r = (await c.post(BASE + '/eligibility', { applicationId: x.appId })).data;
  assert.equal(r.eligible, false); assert.ok(r.reasons.some((m) => /7-day/.test(m)));
  assert.equal(r.price, null);
});

test('private endpoints are never cached or indexed; nothing public links to the feature', async () => {
  const r = await asha.get(BASE + '/pricing');
  assert.match(r.headers.get('cache-control'), /no-store/); assert.match(r.headers.get('x-robots-tag'), /noindex/);
  const fs = await import('node:fs'); const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '../../client/src');
  for (const f of ['components/layout', 'config']) {
    for (const file of fs.readdirSync(path.join(root, f), { recursive: true })) {
      const p = path.join(root, f, file); if (!fs.statSync(p).isFile()) continue;
      assert.equal(/priority-certificate/i.test(fs.readFileSync(p, 'utf8')), false, p);
    }
  }
});
