// Stage 10C — an approved student whose internship has no configured tasks still receives the published library tasks; admin lifecycle view reports task counts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';

const PW = 'Str0ng!Pass1';
let srv, dir, db, admin, asha, listingId;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-10c-'));
  srv = await startServer({ ADMIN_API_KEY: 'k'.repeat(40), DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', AUTO_LIBRARY_TASKS: 'true' });
  ({ db } = await import('../src/db/index.js'));
  const { seedTaskLibrary } = await import('../src/services/taskLibrarySeed.js');
  seedTaskLibrary();
  [admin, asha] = [1, 2].map(() => client(srv.base));
  await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }));
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  listingId = 'ELV-WD-002'; // "Frontend Starter Week" (web-development, 7 days) from the built-in catalogue; it has no tasks configured
  assert.equal(db.prepare('SELECT COUNT(*) n FROM internship_tasks WHERE internship_id = ?').get(listingId).n, 0);
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a listing with no tasks configured gets the library tasks for its category, and the student receives them', async () => {
  await asha.post('/auth/register', validStudent({ email: 'asha@example.com', fullName: 'Asha Verma' }));
  const a = await asha.post('/applications', validApplication({ internshipId: listingId, fullName: 'Asha Verma' }));
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal((await admin.patch(`/admin/applications/${a.data.application.id}/status`, { status: 'Approved' })).status, 200);
  const e = await admin.post(`/admin/applications/${a.data.application.id}/internship`, {});
  assert.equal(e.status, 201, JSON.stringify(e.data));
  const rows = db.prepare('SELECT * FROM student_tasks WHERE enrollment_id = ?').all(e.data.internship.id);
  assert.ok(rows.length >= 2 && rows.length <= 4, `a 7-day internship gets a short plan, got ${rows.length}`);
  const mine = await asha.get('/student/tasks');
  assert.equal(mine.status, 200); assert.equal(mine.data.tasks.length, rows.length);
  const life = await admin.get(`/admin/internships/${e.data.internship.id}/lifecycle`);
  assert.equal(life.data.tasks.total, rows.length); assert.equal(life.data.tasks.approved, 0);
  // running it again changes nothing, and the listing's tasks were attached only once
  assert.equal((await admin.post(`/admin/internships/${e.data.internship.id}/tasks/assign`, {})).data.assigned, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM internship_tasks WHERE internship_id = ?').get(listingId).n, rows.length);
});

test('simple review: a student submits a repo link and the administrator approves it without rubric scores', async () => {
  const task = db.prepare("SELECT st.id FROM student_tasks st ORDER BY rowid LIMIT 1").get();
  const sub = await asha.post(`/student/tasks/${task.id}/submissions`, { repositoryUrl: 'https://github.com/asha/demo-project', description: 'Built a small page with a header, a form and a footer.' });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  assert.equal((await admin.post(`/admin/projects/${task.id}/start-review`, {})).status, 200);
  const noMsg = await admin.post(`/admin/projects/${task.id}/decision`, { decision: 'Changes Requested', simple: true, confirm: true });
  assert.equal(noMsg.status, 400, 'sending back still needs a message');
  const ok = await admin.post(`/admin/projects/${task.id}/decision`, { decision: 'Approved', simple: true, confirm: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(db.prepare('SELECT status FROM student_tasks WHERE id = ?').get(task.id).status, 'Approved');
  const view = await asha.get(`/student/tasks/${task.id}`);
  assert.equal(view.data.assignment.submissionStatus, 'Approved');
  // without simple: true the old rubric rules still apply
  const t2 = db.prepare("SELECT id FROM student_tasks WHERE status = 'Assigned' ORDER BY rowid LIMIT 1").get();
  await asha.post(`/student/tasks/${t2.id}/submissions`, { repositoryUrl: 'https://github.com/asha/demo-two', description: 'Second submission with enough words in it.' });
  await admin.post(`/admin/projects/${t2.id}/start-review`, {});
  assert.equal((await admin.post(`/admin/projects/${t2.id}/decision`, { decision: 'Approved', confirm: true })).status, 400);
});
