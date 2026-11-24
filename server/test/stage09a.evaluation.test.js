// Stage 09A — application evaluation foundation: transparent criteria, recommendation (never a decision), admin override with audit, authorization.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1';
let srv, dir, db, admin, anon, asha, ravi, listingId, ashaApp, raviApp;
const body = (over = {}) => ({ title: 'Evaluation Python Internship', category: 'python-development', description: 'A listing used by the Stage 09A evaluation tests.', durationDays: 30, skills: ['Python'], outcomes: ['Build a small Python project'], eligibility: { who: 'Any student', knowledge: ['Basic programming knowledge'] }, type: 'Project-Based', difficulty: 'Beginner', seats: 1, ...over });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-09a-ev-'));
  srv = await startServer({ DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000' });
  ({ db } = await import('../src/db/index.js'));
  [anon, admin, asha, ravi] = [1, 2, 3, 4].map(() => client(srv.base));
  await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }));
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  const l = await admin.post('/admin/internship-listings', body()); listingId = l.data.internship.id;
  await admin.patch(`/admin/internship-listings/${listingId}/state`, { action: 'publish' });
  await asha.post('/auth/register', validStudent());
  await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar', skills: ['Excel'] }));
  ashaApp = (await asha.post('/applications', validApplication({ internshipId: listingId }))).data.application.id;
  raviApp = (await ravi.post('/applications', validApplication({ internshipId: listingId, fullName: 'Ravi Kumar', skills: ['Excel'] }))).data.application.id;
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('evaluation explains every criterion, recommends but never decides, and leaves the application untouched', async () => {
  const statusBefore = db.prepare('SELECT status, updated_at FROM applications WHERE id = ?').get(ashaApp);
  const r = await admin.post(`/admin/applications/${ashaApp}/evaluation`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const ev = r.data.evaluation;
  assert.equal(ev.recommendation, 'recommend_approval');
  const byKey = Object.fromEntries(ev.criteria.map((c) => [c.key, c]));
  for (const k of ['profile_complete', 'seats_available', 'application_window', 'account_active', 'duplicate_application']) { assert.equal(byKey[k].result, 'met', k); assert.ok(byKey[k].detail.length > 10); }
  assert.equal(byKey.skills_prerequisite.result, 'not_applicable');
  assert.equal(byKey.listing_requirements_manual.result, 'manual', 'free-text prerequisites are never guessed');
  assert.deepEqual(db.prepare('SELECT status, updated_at FROM applications WHERE id = ?').get(ashaApp), statusBefore, 'the application is exactly as it was');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE application_id = ? AND type <> ?').get(ashaApp, 'application_submitted').n, 0, 'the student was not told anything');
  assert.match(r.data.explanation, /recommendation only/);
  // reading it back
  const g = await admin.get(`/admin/applications/${ashaApp}/evaluation`);
  assert.equal(g.data.evaluation.id, ev.id); assert.equal(g.data.stale, false);
});

test('unmet criteria give "needs_review" with the reason, never a rejection; skills count only if the student declared them', async () => {
  const cfg = await admin.put(`/admin/internship-listings/${listingId}/application-criteria`, { criteria: { skills_prerequisite: { enabled: true, requiredSkills: ['Python', 'SQL'], minMatches: 1 } } });
  assert.equal(cfg.status, 200); assert.equal(cfg.data.criteria.skills_prerequisite.enabled, true);
  const ra = (await admin.post(`/admin/applications/${raviApp}/evaluation`, {})).data;
  assert.equal(ra.evaluation.recommendation, 'needs_review');
  const skills = ra.evaluation.criteria.find((c) => c.key === 'skills_prerequisite');
  assert.equal(skills.result, 'not_met'); assert.match(skills.detail, /Not declared: Python, SQL/);
  assert.match(ra.explanation, /not a rejection/);
  assert.equal(db.prepare('SELECT status FROM applications WHERE id = ?').get(raviApp).status, 'Submitted', 'status unchanged');
  const aa = (await admin.post(`/admin/applications/${ashaApp}/evaluation`, {})).data;
  assert.equal(aa.evaluation.recommendation, 'recommend_approval', 'Asha declared Python');
  assert.equal(aa.evaluationCount ?? (await admin.get(`/admin/applications/${ashaApp}/evaluation`)).data.evaluationCount, 2, 'every run is kept');
  // nothing in the output can be a score or a reject verdict
  const all = JSON.stringify([ra, aa]);
  assert.ok(!/reject/i.test(all.replace(/not a rejection/g, '')), 'no reject verdict exists');
});

test('only the allow-listed facts are used: changing name, e-mail or college never changes the result', async () => {
  const before = (await admin.post(`/admin/applications/${ashaApp}/evaluation`, {})).data.evaluation.criteria.map((c) => [c.key, c.result]);
  db.prepare("UPDATE students SET full_name = 'Zzz Qqq', college = 'Another College Entirely', email = 'someone.else@example.org' WHERE email = 'asha@example.com'").run();
  const after = (await admin.post(`/admin/applications/${ashaApp}/evaluation`, {})).data.evaluation.criteria.map((c) => [c.key, c.result]);
  assert.deepEqual(after, before);
  db.prepare("UPDATE students SET full_name = 'Asha Verma', college = 'IIT Madras', email = 'asha@example.com' WHERE email = 'someone.else@example.org'").run();
  // an incomplete profile IS a criterion, and is reported, not hidden
  db.prepare("UPDATE students SET phone = 'Not provided' WHERE email = 'ravi@example.com'").run();
  const rv = (await admin.post(`/admin/applications/${raviApp}/evaluation`, {})).data.evaluation.criteria.find((c) => c.key === 'profile_complete');
  assert.equal(rv.result, 'not_met'); assert.match(rv.detail, /phone/);
});

test('seats and deadline are checked from the listing, not guessed; the work-list is read-only and sorted', async () => {
  const wl = await admin.get('/admin/applications/recommendations');
  assert.equal(wl.status, 200);
  assert.equal(wl.data.applications[0].recommendation, 'recommend_approval'); assert.ok(wl.data.applications.at(-1).notMet.length > 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM application_evaluations').get().n >= 3, true);
  const stored = db.prepare('SELECT COUNT(*) n FROM application_evaluations').get().n;
  await admin.get('/admin/applications/recommendations'); assert.equal(db.prepare('SELECT COUNT(*) n FROM application_evaluations').get().n, stored, 'viewing the list stores nothing');
  // approve Ravi through the EXISTING route (the only way a status changes): then the single seat is gone for Asha
  assert.equal((await admin.patch(`/admin/applications/${raviApp}/status`, { status: 'Approved', note: 'Approved by an administrator after review' })).status, 200);
  const seats = (await admin.post(`/admin/applications/${ashaApp}/evaluation`, {})).data.evaluation.criteria.find((c) => c.key === 'seats_available');
  assert.equal(seats.result, 'not_met'); assert.match(seats.detail, /seats/);
  // deadline in the past
  db.prepare("UPDATE internship_listings SET deadline = '2020-01-01' WHERE id = ?").run(listingId);
  const win = (await admin.post(`/admin/applications/${ashaApp}/evaluation`, {})).data.evaluation.criteria.find((c) => c.key === 'application_window');
  assert.equal(win.result, 'not_met'); assert.match(win.detail, /deadline/);
});

test('administrator response: accepted / overridden / information requested are recorded with a reason, audited, and never change the status', async () => {
  const statusBefore = db.prepare('SELECT status FROM applications WHERE id = ?').get(ashaApp).status;
  assert.equal((await admin.post(`/admin/applications/${ashaApp}/evaluation/review`, { action: 'overridden' })).status, 400, 'an override needs a reason');
  assert.equal((await admin.post(`/admin/applications/${ashaApp}/evaluation/review`, { action: 'bogus', reason: 'long enough reason' })).status, 400);
  const o = await admin.post(`/admin/applications/${ashaApp}/evaluation/review`, { action: 'overridden', reason: 'Seat was freed by a withdrawal we agreed offline.' });
  assert.equal(o.status, 201); assert.equal(o.data.reviewState, 'Recommendation overridden'); assert.equal(o.data.reviews.length, 1);
  const i = await admin.post(`/admin/applications/${ashaApp}/evaluation/review`, { action: 'information_requested', reason: 'Please share a link to a past Python project.' });
  assert.equal(i.data.reviewState, 'Additional Information Required');
  assert.equal(db.prepare('SELECT status FROM applications WHERE id = ?').get(ashaApp).status, statusBefore, 'status unchanged');
  const log = (await admin.get('/admin/audit-logs?pageSize=100')).data.events.filter((e) => e.relatedId === ashaApp).map((e) => e.action);
  assert.ok(log.includes('application.evaluation_review') && log.includes('application.evaluate'));
  // history is append-only
  assert.throws(() => db.prepare("UPDATE application_evaluations SET recommendation = 'recommend_approval'").run());
  assert.throws(() => db.prepare("UPDATE application_evaluation_reviews SET action = 'accepted'").run());
  // a stored evaluation becomes "stale" when the application changes afterwards
  await admin.patch(`/admin/applications/${ashaApp}/status`, { status: 'Under Review' });
  assert.equal((await admin.get(`/admin/applications/${ashaApp}/evaluation`)).data.stale, true);
});

test('authorization and validation: only administrators evaluate; students cannot read or change criteria; bad input is refused', async () => {
  for (const [m, p, b] of [['post', `/admin/applications/${ashaApp}/evaluation`, {}], ['get', `/admin/applications/${ashaApp}/evaluation`], ['post', `/admin/applications/${ashaApp}/evaluation/review`, { action: 'accepted' }],
    ['put', `/admin/internship-listings/${listingId}/application-criteria`, { criteria: { seats_available: { enabled: false } } }], ['get', '/admin/applications/recommendations']]) {
    assert.equal((await anon[m](p, b)).status, 401, `anon ${p}`);
    assert.equal((await asha[m](p, b)).status, 403, `student ${p}`);
  }
  assert.equal((await admin.get('/admin/applications/ELV-APP-NOPE/evaluation')).status, 404);
  assert.equal((await admin.put(`/admin/internship-listings/${listingId}/application-criteria`, { criteria: { gender: { enabled: true } } })).status, 400, 'unknown (e.g. personal) criteria cannot be configured');
  assert.equal((await admin.put(`/admin/internship-listings/${listingId}/application-criteria`, { criteria: { skills_prerequisite: { enabled: true, requiredSkills: [] } } })).status, 400);
  assert.equal((await admin.put('/admin/internship-listings/ELV-NOPE-999/application-criteria', { criteria: { seats_available: { enabled: false } } })).status, 404);
  // a cancelled application is closed
  db.prepare("UPDATE applications SET status = 'Cancelled' WHERE id = ?").run(ashaApp);
  assert.equal((await admin.post(`/admin/applications/${ashaApp}/evaluation`, {})).status, 409);
});
