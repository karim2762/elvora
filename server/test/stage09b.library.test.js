// Stage 09B (Part 1) — task library upgrade: library content, seeding, learning stages, admin management, student read access, backward compatibility.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, client, validStudent, validApplication } from './helpers.js';
import { CATEGORIES } from '../src/internships/categories.js';
import { TASK_LIBRARY } from '../src/tasks/library/index.js';
import { LEARNING_STAGES } from '../src/tasks/constants.js';

const PW = 'Str0ng!Pass1';
const ORG = { ORG_ADDRESS: '12 Example Road, Chennai 600001', ORG_EMAIL: 'docs@example.org', ORG_SIGNATORY_NAME: 'Gowtham', ORG_SIGNATORY_TITLE: 'Chief Executive Officer (CEO)' };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let srv, dir, db, admin, asha, ravi, anon, seed;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elv-09b-'));
  srv = await startServer({ ADMIN_API_KEY: 'k'.repeat(40), DOCUMENTS_DIR: path.join(dir, 'documents'), RATE_LIMIT_APPLY_MAX: '1000', RATE_LIMIT_APPLICATION_READ_MAX: '1000', ...ORG });
  ({ db } = await import('../src/db/index.js'));
  [anon, admin, asha, ravi] = [1, 2, 3, 4].map(() => client(srv.base));
  assert.equal((await admin.post('/auth/register', validStudent({ email: 'boss@example.com', fullName: 'Boss Admin' }))).status, 201);
  const { findByEmail, setRole } = await import('../src/db/students.js');
  setRole(findByEmail('boss@example.com').id, 'admin');
  assert.equal((await admin.post('/auth/admin/login', { email: 'boss@example.com', password: PW })).status, 200);
  seed = (await import('../src/services/taskLibrarySeed.js')).seedTaskLibrary();
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('library content: every category has 1 beginner, 3 intermediate and 1 final project with progressive difficulty and the required structure', () => {
  assert.equal(TASK_LIBRARY.length, CATEGORIES.length * 5);
  for (const cat of CATEGORIES) {
    const rows = TASK_LIBRARY.filter((t) => t.category === cat.slug);
    const by = (type) => rows.filter((t) => t.taskType === type);
    assert.equal(by('Practical Assignment').length, 1, cat.slug); assert.equal(by('Mini Project').length, 3, cat.slug); assert.equal(by('Final Project').length, 1, cat.slug);
    const [b] = by('Practical Assignment'); const [f] = by('Final Project');
    assert.equal(b.difficulty, 'Beginner'); assert.equal(f.difficulty, 'Intermediate'); assert.ok(by('Mini Project').every((m) => m.difficulty === 'Easy'));
    assert.ok(b.estimatedHours < Math.min(...by('Mini Project').map((m) => m.estimatedHours)), `${cat.slug}: hours grow from beginner to intermediate`);
    assert.ok(f.estimatedHours > Math.max(...by('Mini Project').map((m) => m.estimatedHours)), `${cat.slug}: the final project is the largest`);
    assert.ok(f.title.startsWith('Final Project:'));
    for (const t of rows.filter((r) => r.taskType !== 'Practical Assignment')) {
      const c = t.content;
      for (const k of ['objective', 'problemStatement', 'folderStructure', 'expectedBehavior', 'expectedOutput', 'submissionRequirements']) assert.ok(c[k], `${t.key} ${k}`);
      for (const k of ['concepts', 'features', 'technicalRequirements', 'steps', 'testingRequirements', 'acceptanceCriteria', 'completionChecklist', 'tools']) assert.ok(c[k].length >= 2, `${t.key} ${k}`);
      assert.ok(t.learningObjectives.length && t.resources.length && t.deliverables.length);
      assert.equal(c.rubric.reduce((n, r) => n + r.weight, 0), 100, `${t.key} rubric totals 100`);
    }
  }
  const cyber = TASK_LIBRARY.filter((t) => t.category === 'cybersecurity');
  assert.ok(cyber.every((t) => /authori[sz]|own|local|defensive|test data|fake|test pass/i.test(JSON.stringify(t.content) + t.title)), 'cybersecurity tasks stay defensive and local');
});

test('seeding: every library task validates, is stored once, is idempotent and never overwrites administrator edits', async () => {
  assert.equal(seed.inserted, 60); assert.equal(seed.existing, 0);
  const { seedTaskLibrary } = await import('../src/services/taskLibrarySeed.js');
  assert.deepEqual(seedTaskLibrary(), { inserted: 0, existing: 60, total: 60 });
  const first = TASK_LIBRARY[1];
  const edit = await admin.patch(`/admin/task-templates/${first.id}`, { estimatedHours: 20 });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  seedTaskLibrary();
  assert.equal((await admin.get(`/admin/task-templates/${first.id}`)).data.template.estimatedHours, 20, 'administrator edit survived re-seeding');
  assert.equal((await admin.patch(`/admin/task-templates/${first.id}`, { estimatedHours: first.estimatedHours })).status, 200);
});

test('admin library: browse by category and learning stage, options list the stages, stage is derived, pagination and ordering are stable', async () => {
  const opts = await admin.get('/admin/task-templates/options'); assert.deepEqual(opts.data.learningStages, LEARNING_STAGES);
  for (const cat of CATEGORIES) {
    const r = await admin.get(`/admin/task-templates?category=${cat.slug}&pageSize=50`);
    assert.equal(r.status, 200); assert.equal(r.data.templates.length, 5, cat.slug);
    assert.deepEqual(r.data.templates.map((t) => t.learningStage), [LEARNING_STAGES[0], LEARNING_STAGES[1], LEARNING_STAGES[1], LEARNING_STAGES[1], LEARNING_STAGES[2]], 'beginner → intermediate → final');
    assert.ok(r.data.templates.every((t) => t.published && t.readiness.ready));
  }
  for (const [stage, n] of [[LEARNING_STAGES[0], 12], [LEARNING_STAGES[1], 36], [LEARNING_STAGES[2], 12]]) {
    assert.equal((await admin.get(`/admin/task-templates?stage=${encodeURIComponent(stage)}&pageSize=50`)).data.pagination.total, n, stage);
  }
  assert.equal((await admin.get('/admin/task-templates?stage=Nonsense')).status, 400);
  assert.equal((await admin.get('/admin/task-templates?category=python-development&stage=' + encodeURIComponent(LEARNING_STAGES[2]))).data.templates[0].title, 'Final Project: Python Student Analytics Dashboard');
});

test('admin management: create/edit with the new fields, validation, publish rules and active/inactive status', async () => {
  const base = TASK_LIBRARY.find((t) => t.key === 'python-development:expense-tracker');
  const body = (over = {}) => ({ ...base, title: 'Custom analytics mini project', content: { ...base.content }, ...over });
  const bad = await admin.post('/admin/task-templates', body({ content: { ...base.content, rubric: [{ criterion: 'Everything', weight: 60, description: 'x' }] } }));
  assert.equal(bad.status, 400); assert.ok(bad.data.error.fields.content.rubric);
  assert.equal((await admin.post('/admin/task-templates', body({ content: { ...base.content, learningStage: 'Expert Level' } }))).status, 400);
  assert.equal((await admin.post('/admin/task-templates', body({ content: { ...base.content, learningStage: LEARNING_STAGES[2] } }))).status, 400, 'stage must match the task type');
  const made = await admin.post('/admin/task-templates', body()); assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.template.learningStage, LEARNING_STAGES[1]); assert.equal(made.data.template.published, false);
  const thin = await admin.post('/admin/task-templates', body({ title: 'Thin intermediate task', content: { ...base.content, features: [], rubric: [] } }));
  assert.equal(thin.status, 201); assert.equal((await admin.patch(`/admin/task-templates/${thin.data.template.id}/state`, { action: 'publish' })).status, 409, 'a new-format task without features/rubric is not publishable');
  const id = made.data.template.id;
  assert.equal((await admin.patch(`/admin/task-templates/${id}/state`, { action: 'publish' })).status, 200);
  const e = await admin.patch(`/admin/task-templates/${id}`, { content: { ...base.content, features: [...base.content.features, 'Extra feature added by administrator'] } });
  assert.equal(e.status, 200); assert.equal(e.data.template.version, 2); assert.equal(e.data.template.content.features.length, base.content.features.length + 1);
  assert.equal((await admin.patch(`/admin/task-templates/${id}/state`, { action: 'unpublish' })).data.template.published, false);
  assert.equal((await admin.patch(`/admin/task-templates/${id}/state`, { action: 'publish' })).data.template.published, true);
});

test('student visibility: only assigned tasks are readable, with full instructions, scoped to the signed-in student', async () => {
  const lst = await admin.post('/admin/internship-listings', { title: 'Python Library Internship', category: 'python-development', description: 'A listing used by the Stage 09B tests.', durationDays: 30, skills: ['Python'], outcomes: ['Build a small Python project'], eligibility: { who: 'Any student' }, type: 'Project-Based', difficulty: 'Beginner' });
  assert.equal(lst.status, 201, JSON.stringify(lst.data)); const lid = lst.data.internship.id;
  assert.equal((await admin.patch(`/admin/internship-listings/${lid}/state`, { action: 'publish' })).status, 200);
  const py = TASK_LIBRARY.filter((t) => t.category === 'python-development');
  const attach = async (t, publish) => { const r = await admin.post(`/admin/internship-listings/${lid}/tasks`, { templateId: t.id, publish }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.task ?? r.data; };
  await attach(py[0], true); const finalTask = await attach(py[4], true); await attach(py[1], false); // third one stays unpublished
  assert.equal((await admin.post('/admin/internship-listings/' + lid + '/tasks', { templateId: TASK_LIBRARY.find((t) => t.category === 'java-development').id })).status, 409, 'other categories are never attached');
  await asha.post('/auth/register', validStudent({ email: 'asha@example.com', fullName: 'Asha Verma' })); await ravi.post('/auth/register', validStudent({ email: 'ravi@example.com', fullName: 'Ravi Kumar' }));
  const a = await asha.post('/applications', validApplication({ internshipId: lid, fullName: 'Asha Verma' })); assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal((await admin.patch(`/admin/applications/${a.data.application.id}/status`, { status: 'Approved' })).status, 200);
  const enr = await admin.post(`/admin/applications/${a.data.application.id}/internship`, { startDate: day(-1) });
  assert.equal((await admin.patch(`/admin/internships/${enr.data.internship.id}/activate`, { startDate: day(-1) })).status, 200);

  assert.equal((await anon.get('/student/tasks')).status, 401);
  const list = await asha.get('/student/tasks'); assert.equal(list.status, 200);
  assert.equal(list.data.tasks.length, 2, 'the unpublished task is not assigned');
  assert.deepEqual(list.data.tasks.map((t) => t.task.learningStage), [LEARNING_STAGES[0], LEARNING_STAGES[2]]);
  assert.equal(list.data.summary.total, 2); assert.equal(list.data.summary.approved, 0);
  assert.ok(list.data.tasks.every((t) => !('studentId' in t)));
  const st = list.data.tasks[1]; const d = await asha.get(`/student/tasks/${st.id}`); assert.equal(d.status, 200);
  assert.equal(d.data.task.title, finalTask.title); assert.equal(d.data.task.content.learningStage, LEARNING_STAGES[2]);
  assert.ok(d.data.task.content.features.length >= 6 && d.data.task.content.rubric.length >= 5 && d.data.task.content.folderStructure.includes('src/'));
  assert.deepEqual(d.data.position, { index: 2, total: 2 }); assert.ok(!('createdBy' in d.data.task));
  assert.equal((await ravi.get(`/student/tasks/${st.id}`)).status, 404, 'someone else’s assignment looks like a missing one');
  assert.equal((await ravi.get('/student/tasks')).data.tasks.length, 0);
  assert.equal((await asha.get('/student/tasks/STK-00000000')).status, 404);
  assert.equal((await asha.get('/student/tasks/not-an-id')).status, 404);
});

test('persistence and compatibility: library rows survive in the database and Stage 09A tasks (no stage, old content) still derive a stage and publish', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_templates WHERE id IN (' + TASK_LIBRARY.map(() => '?').join(',') + ')').get(...TASK_LIBRARY.map((t) => t.id)).n, 60);
  assert.ok(db.pragma('user_version', { simple: true }) >= 14, 'no migration was needed');
  const legacy = { category: 'java-development', title: 'Legacy style mini project', shortDescription: 'An older Stage 09A style task without the new fields.', difficulty: 'Easy', taskType: 'Mini Project', submissionType: 'text', estimatedHours: 5,
    learningObjectives: ['Practise a Java loop'], requiredSkills: ['Java'], deliverables: ['Main.java'], evaluationCriteria: ['Program compiles'],
    content: { objective: 'Write a loop that prints a table.', steps: ['Create Main.java with a for loop.'], expectedOutput: 'A printed table.', submissionRequirements: 'Describe your work.' } };
  const r = await admin.post('/admin/task-templates', legacy); assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.template.learningStage, LEARNING_STAGES[1]); assert.equal(r.data.template.readiness.ready, true);
});
