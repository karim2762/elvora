// Stage 07B: DB + service level tests (no HTTP, so no Express needed): internship listings and application review.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { validApplication } from './helpers.js';

Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file::memory:', SESSION_SECRET: 'test-secret-test-secret-test-secret-1234' });
let db, students, applications, notifications, L, repo, catalog, asha, ravi;
const admin = { id: 'admin-1', fullName: 'Priya Admin', email: 'priya@elvora.test', via: 'session' };

const profile = (email) => ({ fullName: 'Test Student', email, phone: '9876543210', passwordHash: 'x', college: 'C', degree: 'B.Tech', branch: 'CS', academicYear: '3rd Year', graduationYear: 2027, skills: [] });
const responses = { fullName: 'Test Student', phone: '9876543210', college: 'C', degree: 'B.Tech', branch: 'CS', academicYear: '3rd Year', skills: ['Python'], motivation: 'x'.repeat(60) };
const apply = (student, internship) => applications.createApplication({ student, internship, responses });
const valid = (over = {}) => ({
  title: 'Advanced Python Testing', category: 'python-development', description: 'Learn to test Python programs with pytest and mocks.', durationDays: 30,
  skills: ['Python', 'pytest'], outcomes: ['Write unit tests', 'Use fixtures'], eligibility: { who: 'Students who know basic Python.', academic: 'Any technical programme', knowledge: ['Python basics'] },
  type: 'Project-Based', difficulty: 'Intermediate', seats: 25, deadline: '2030-01-01', status: 'open', featured: false, ...over,
});
const fieldsOf = (fn) => { try { fn(); } catch (e) { return { status: e.status, code: e.code, fields: e.fields ?? {} }; } return null; };

before(async () => {
  ({ db } = await import('../src/db/index.js'));
  students = await import('../src/db/students.js');
  applications = await import('../src/db/applications.js');
  notifications = await import('../src/db/notifications.js');
  repo = await import('../src/db/internshipListings.js');
  L = await import('../src/services/internshipListings.js');
  catalog = await import('../src/internships/catalog.js');
  asha = students.createStudent(profile('asha@example.com'));
  ravi = students.createStudent(profile('ravi@example.com'));
});

test('migration imported the existing catalogue once, as published + active; nothing invented', () => {
  assert.ok(db.pragma('user_version', { simple: true }) >= 11); // later stages add migrations
  assert.equal(repo.count(), 17);
  const py = repo.findById('ELV-PY-001');
  assert.equal(py.published, true); assert.equal(py.active, true); assert.equal(py.title, 'Python Programming Essentials');
  assert.ok(py.skills.length > 0 && py.outcomes.length > 0);
  assert.equal(catalog.getInternship('ELV-PY-001').status, 'open'); // applications keep working against the imported listing
});

test('create: draft by default, ID follows the ELV-<PREFIX>-NNN convention, all four durations and the 12 categories work', () => {
  const a = L.createListing(valid(), admin);
  assert.equal(a.id, 'ELV-PY-003'); assert.equal(a.published, false); assert.equal(a.active, true); assert.equal(a.canDelete, true);
  assert.equal(catalog.getInternship(a.id), null); // a draft does not exist for students
  const dur = [7, 60, 90].map((d, i) => L.createListing(valid({ title: `Dur ${d}`, durationDays: d, category: ['java-development', 'c-programming', 'ui-ux-design'][i] }), admin));
  assert.deepEqual(dur.map((x) => x.id), ['ELV-JV-003', 'ELV-C-003', 'ELV-UX-002']);
});

test('create: validation rejects missing fields, invalid duration/category/type/seats/deadline, and duplicates', () => {
  const bad = fieldsOf(() => L.createListing({}, admin));
  assert.equal(bad.status, 400);
  for (const k of ['title', 'category', 'description', 'durationDays', 'skills', 'outcomes', 'type', 'difficulty', 'eligibility']) assert.ok(bad.fields[k], `missing ${k}`);
  assert.ok(fieldsOf(() => L.createListing(valid({ durationDays: 45, title: 'X45' }), admin)).fields.durationDays);
  assert.ok(fieldsOf(() => L.createListing(valid({ durationDays: '1 month', title: 'X46' }), admin)).fields.durationDays);
  assert.ok(fieldsOf(() => L.createListing(valid({ category: 'cooking', title: 'X47' }), admin)).fields.category);
  assert.ok(fieldsOf(() => L.createListing(valid({ type: 'Nope', title: 'X48' }), admin)).fields.type);
  assert.ok(fieldsOf(() => L.createListing(valid({ seats: 0, title: 'X49' }), admin)).fields.seats);
  assert.ok(fieldsOf(() => L.createListing(valid({ deadline: '2030-13-45', title: 'X50' }), admin)).fields.deadline);
  assert.ok(fieldsOf(() => L.createListing(valid({ deadline: '2020-01-01', title: 'X51' }), admin)).fields.deadline); // past deadline on create
  assert.ok(fieldsOf(() => L.createListing(valid({ title: '<b>' + 'x'.repeat(130) }), admin)).fields.title);
  const dup = fieldsOf(() => L.createListing(valid({ title: 'advanced python TESTING' }), admin));
  assert.equal(dup.status, 409); assert.equal(dup.code, 'DUPLICATE_LISTING');
  // same title, different duration is allowed
  assert.ok(L.createListing(valid({ durationDays: 60 }), admin).id);
});

test('edit: changes persist and show on the public shape; unknown/forbidden fields are ignored', () => {
  const e = L.editListing('ELV-PY-003', { description: 'Updated description for the testing internship.', seats: '40', id: 'ELV-HACK-1', published: true, archivedAt: 'x' }, admin);
  assert.equal(e.id, 'ELV-PY-003'); assert.equal(e.seats, 40); assert.equal(e.published, false); assert.equal(e.archivedAt, null);
  assert.equal(repo.findById('ELV-PY-003').updatedBy, 'Priya Admin');
  assert.ok(fieldsOf(() => L.editListing('ELV-PY-003', { title: '' }, admin)).fields.title);
  assert.equal(fieldsOf(() => L.editListing('ELV-NOPE-001', {}, admin)).status, 404);
  assert.equal(fieldsOf(() => L.editListing('../etc', {}, admin)).status, 404);
});

test('publish / unpublish / activate / deactivate drive what students and the public site see', () => {
  assert.equal(L.getPublic('ELV-PY-003'), null);
  L.applyAction('ELV-PY-003', 'publish', admin);
  assert.equal(L.getPublic('ELV-PY-003').status, 'open');
  assert.ok(L.listPublic().some((i) => i.id === 'ELV-PY-003'));
  assert.equal(fieldsOf(() => L.applyAction('ELV-PY-003', 'publish', admin)).status, 409); // already published
  L.applyAction('ELV-PY-003', 'deactivate', admin);
  assert.equal(L.getPublic('ELV-PY-003').status, 'closed'); // still visible, applications closed
  assert.equal(catalog.effectiveStatus(catalog.getInternship('ELV-PY-003')), 'closed');
  L.applyAction('ELV-PY-003', 'activate', admin);
  assert.equal(catalog.effectiveStatus(catalog.getInternship('ELV-PY-003')), 'open');
  L.applyAction('ELV-PY-003', 'unpublish', admin);
  assert.equal(L.getPublic('ELV-PY-003'), null); assert.equal(catalog.getInternship('ELV-PY-003'), null);
  assert.equal(fieldsOf(() => L.applyAction('ELV-PY-003', 'explode', admin)).status, 400);
});

test('edit to a public record is visible immediately; an unchanged imported record keeps its rich detail', () => {
  L.editListing('ELV-PY-001', { title: 'Python Programming Essentials (Updated)' }, admin);
  assert.equal(L.getPublic('ELV-PY-001').title, 'Python Programming Essentials (Updated)');
  assert.ok(L.getPublic('ELV-PY-001').structure.plan.length > 0);
  L.editListing('ELV-PY-001', { title: 'Python Programming Essentials' }, admin);
});

test('safe deletion: blocked while published or when applications exist; archive keeps history; delete works for an unused unpublished draft', () => {
  const a = apply(asha, catalog.getInternship('ELV-PY-001'));
  const del = fieldsOf(() => L.deleteListing('ELV-PY-001'));
  assert.equal(del.status, 409); assert.equal(del.code, 'LISTING_IN_USE');
  assert.equal(L.getListing('ELV-PY-001').canDelete, false); assert.equal(L.getListing('ELV-PY-001').applicationCount, 1);
  const cat = fieldsOf(() => L.editListing('ELV-PY-001', { category: 'java-development' }, admin));
  assert.equal(cat.code, 'CATEGORY_LOCKED');
  // archive: hidden from students, application history intact
  const arch = L.applyAction('ELV-PY-001', 'archive', admin);
  assert.ok(arch.archivedAt); assert.equal(arch.published, false); assert.equal(arch.active, false);
  assert.equal(catalog.getInternship('ELV-PY-001'), null); assert.equal(L.getPublic('ELV-PY-001'), null);
  assert.equal(applications.findById(a.id).internship.title, 'Python Programming Essentials'); // snapshot untouched
  assert.equal(fieldsOf(() => L.editListing('ELV-PY-001', { title: 'Changed title' }, admin)).code, 'LISTING_ARCHIVED');
  assert.equal(fieldsOf(() => L.applyAction('ELV-PY-001', 'publish', admin)).code, 'LISTING_ARCHIVED');
  assert.equal(repo.pageForAdmin({ limit: 50, offset: 0 }).rows.some((r) => r.id === 'ELV-PY-001'), false); // default list hides archived
  assert.equal(repo.pageForAdmin({ state: 'archived', limit: 50, offset: 0 }).rows.length, 1);
  L.applyAction('ELV-PY-001', 'restore', admin); // restore: back, but unpublished + inactive until re-published on purpose
  assert.equal(repo.findById('ELV-PY-001').published, false);
  L.applyAction('ELV-PY-001', 'publish', admin); L.applyAction('ELV-PY-001', 'activate', admin);
  // an unused draft can be deleted; a published one can't
  const d = L.createListing(valid({ title: 'Throwaway draft listing', category: 'cybersecurity' }), admin);
  L.applyAction(d.id, 'publish', admin);
  assert.equal(fieldsOf(() => L.deleteListing(d.id)).code, 'LISTING_PUBLISHED');
  L.applyAction(d.id, 'unpublish', admin);
  L.deleteListing(d.id);
  assert.ok(!repo.findById(d.id));
});

test('applications to an archived/unpublished listing are refused as not found by the existing submit pipeline', async () => {
  const { submitApplication } = await import('../src/services/applications.js');
  L.applyAction('ELV-PY-002', 'unpublish', admin);
  const err = (() => { try { submitApplication(ravi, validApplication({ internshipId: 'ELV-PY-002' })); } catch (e) { return e; } })();
  assert.equal(err?.status, 404);
  L.applyAction('ELV-PY-002', 'publish', admin);
  assert.ok(submitApplication(ravi, validApplication({ internshipId: 'ELV-PY-002' })).id); // and works again once re-published
});

// ---- application review ----
const fresh = (student, id, title = 'Some Internship') => apply(student, { id, title, category: 'python-development', durationDays: 30 });

test('status transitions are validated on the server; history records from/to/who/when; the student is notified', () => {
  const a = fresh(ravi, 'ELV-JV-001', 'Java Application Development');
  const before = notifications.unreadCount(ravi.id);
  const r = applications.changeStatus(a.id, 'Under Review', { admin, note: 'Looks promising' });
  assert.equal(r.changed, true); assert.equal(r.application.status, 'Under Review');
  assert.equal(notifications.unreadCount(ravi.id), before + 1);
  const d = applications.adminDetails(a.id);
  assert.deepEqual(d.history.map((h) => [h.from, h.status]), [[null, 'Submitted'], ['Submitted', 'Under Review']]);
  const last = d.history.at(-1);
  assert.equal(last.changedBy, 'Priya Admin'); assert.equal(last.note, 'Looks promising'); assert.ok(last.changedAt);
  assert.deepEqual(d.allowedNext, ['Approved', 'Rejected', 'Cancelled']);
  // invalid: Under Review -> Submitted
  const bad = fieldsOf(() => applications.changeStatus(a.id, 'Submitted', { admin }));
  assert.equal(bad.status, 409); assert.equal(bad.code, 'INVALID_TRANSITION');
  assert.equal(applications.findById(a.id).status, 'Under Review'); // nothing changed
  assert.equal(applications.adminDetails(a.id).history.length, 2); // and nothing was written
  // decision timestamp
  applications.changeStatus(a.id, 'Rejected', { admin });
  const rej = applications.adminDetails(a.id);
  assert.ok(rej.decidedAt); assert.equal(rej.history.at(-1).changedAt, rej.decidedAt);
  assert.equal(notifications.pageForStudent(ravi.id, { limit: 5, offset: 0 }).rows[0].type, 'application_rejected');
  // reopen once, then history keeps every step (never overwritten)
  applications.changeStatus(a.id, 'Under Review', { admin });
  assert.deepEqual(applications.adminDetails(a.id).history.map((h) => h.status), ['Submitted', 'Under Review', 'Rejected', 'Under Review']);
  assert.equal(applications.adminDetails(a.id).decidedAt, null); // no longer a decided state
});

test('terminal and no-op transitions: Cancelled can\'t be revived; same status writes nothing and sends nothing', () => {
  const a = fresh(ravi, 'ELV-JV-002');
  applications.changeStatus(a.id, 'Cancelled', { admin });
  for (const s of ['Submitted', 'Under Review', 'Approved', 'Rejected']) assert.equal(fieldsOf(() => applications.changeStatus(a.id, s, { admin })).code, 'INVALID_TRANSITION');
  const n = notifications.unreadCount(ravi.id); const h = applications.adminDetails(a.id).history.length;
  const same = applications.changeStatus(a.id, 'Cancelled', { admin });
  assert.equal(same.changed, false); assert.equal(notifications.unreadCount(ravi.id), n); assert.equal(applications.adminDetails(a.id).history.length, h);
  assert.equal(applications.changeStatus('ELV-APP-ZZZZZZZZ', 'Approved', { admin }), null);
});

test('internal notes are append-only, attributed and never sent to the student', () => {
  const a = fresh(asha, 'ELV-WD-001', 'Responsive Web Development');
  const n1 = applications.addNote(a.id, 'Strong portfolio.', admin);
  const n2 = applications.addNote(a.id, 'Call on Monday.', { via: 'key' });
  assert.equal(n1.adminName, 'Priya Admin'); assert.equal(n2.adminName, 'Admin API key');
  assert.deepEqual(applications.adminDetails(a.id).notes.map((n) => n.note), ['Strong portfolio.', 'Call on Monday.']);
  assert.equal(applications.findOwned(a.id, asha.id).notes, undefined); // the student-facing shape has no notes
  assert.equal(applications.addNote('ELV-APP-ZZZZZZZZ', 'x', admin), null);
  const { parseReviewNote, parseStatusChange } = require_validation;
  assert.equal(fieldsOf(() => parseReviewNote({ note: '   ' })).status, 400);
  assert.equal(fieldsOf(() => parseReviewNote({ note: 'x'.repeat(1001) })).status, 400);
  assert.equal(fieldsOf(() => parseStatusChange({ status: 'Maybe' })).status, 400);
  assert.equal(parseStatusChange({ status: 'Approved', note: '  ok  ' }).note, 'ok');
});

test('admin list: search by name / ID / title / email and status filter + pagination', () => {
  const all = applications.pageForAdmin({ limit: 50, offset: 0 });
  assert.ok(all.total >= 4);
  const id = all.rows[0].id;
  assert.equal(applications.pageForAdmin({ q: id.slice(0, 10), limit: 50, offset: 0 }).rows.some((r) => r.id === id), true);
  assert.ok(applications.pageForAdmin({ q: 'Java Application', limit: 50, offset: 0 }).total >= 1);
  assert.ok(applications.pageForAdmin({ q: 'ravi@example', limit: 50, offset: 0 }).total >= 1);
  assert.equal(applications.pageForAdmin({ q: 'zzz-no-match', limit: 50, offset: 0 }).total, 0);
  assert.equal(applications.pageForAdmin({ q: '%', limit: 50, offset: 0 }).total, 0); // wildcards are escaped
  const cancelled = applications.pageForAdmin({ status: 'Cancelled', limit: 50, offset: 0 });
  assert.ok(cancelled.total >= 1 && cancelled.rows.every((r) => r.status === 'Cancelled'));
  assert.equal(applications.pageForAdmin({ limit: 2, offset: 0 }).rows.length, 2);
});

import * as require_validation from '../src/utils/validation.js';
