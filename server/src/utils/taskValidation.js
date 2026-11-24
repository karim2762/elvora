import { badRequest } from './errors.js';
import { parseGitHubRepoUrl } from './github.js';
import { requiresRepository, requiresLiveUrl } from '../tasks/githubSubmission.js';
import { CATEGORY_SLUGS, DURATION_DAYS } from '../internships/categories.js';
import { TASK_DIFFICULTIES, TASK_TYPES, SUBMISSION_TYPES, REVIEW_DECISIONS, MAX_ESTIMATED_HOURS, LEARNING_STAGES, STAGE_BY_TYPE } from '../tasks/constants.js';

// Stage 09A — input rules for the task system. Everything is validated on the server; the browser is never trusted.
// Text is stripped of control characters. URLs are only STORED (never fetched, never used to create anything).
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const line = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '');
const block = (v) => (typeof v === 'string'
  ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  : '');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const finish = (value, errors) => { if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields', errors); return value; };

export function parseHttpsUrl(v, label = 'Link') {
  const raw = line(v);
  if (!raw) return { value: null };
  if (raw.length > 300) return { error: `${label} must be 300 characters or fewer` };
  let u;
  try { u = new URL(raw); } catch { return { error: `${label} must be a full web address starting with https://` }; }
  if (u.protocol !== 'https:') return { error: `${label} must start with https://` };
  if (u.username || u.password) return { error: `${label} must not contain a username or password` };
  if (!u.hostname.includes('.')) return { error: `${label} must be a full web address` };
  return { value: u.toString() };
}

function textList(v, { max, min = 0, itemMin = 3, itemMax = 200, label }) {
  if (v === undefined || v === null) return { value: [] };
  if (!Array.isArray(v)) return { error: `${label} must be a list` };
  const items = v.map(line).filter(Boolean);
  if (items.length > max) return { error: `Use at most ${max} items in ${label.toLowerCase()}` };
  if (items.length < min) return { error: `Add at least ${min} item${min === 1 ? '' : 's'} to ${label.toLowerCase()}` };
  const bad = items.find((i) => i.length < itemMin || i.length > itemMax);
  if (bad !== undefined) return { error: `Each item in ${label.toLowerCase()} must be ${itemMin}–${itemMax} characters` };
  return { value: [...new Set(items)] };
}

// The structured instructions every task should eventually carry (objective, background, tools, steps, expected output, submission requirements).
function parseRubric(v) {
  if (v === undefined || v === null) return { value: [] };
  if (!Array.isArray(v) || v.length > 8) return { error: 'The rubric must be a list of at most 8 criteria' };
  const out = [];
  for (const r of v) {
    const o = asObject(r); const criterion = line(o.criterion); const description = line(o.description); const weight = o.weight;
    if (criterion.length < 3 || criterion.length > 80) return { error: 'Each rubric criterion needs a name of 3–80 characters' };
    if (description.length > 300) return { error: 'Keep each rubric description to 300 characters or fewer' };
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) return { error: 'Each rubric weight must be a whole number from 1 to 100' };
    out.push({ criterion, weight, description });
  }
  if (out.length && out.reduce((n, r) => n + r.weight, 0) !== 100) return { error: 'Rubric weights must add up to 100' };
  return { value: out };
}

// Stage 09B adds optional structured sections to `content` (JSON, so no migration): learning stage, problem statement, concepts, features, technical
// requirements, folder structure, expected behaviour, testing requirements, acceptance criteria, completion checklist and a weighted rubric.
const CONTENT_TEXT = [['objective', 600], ['background', 2000], ['expectedOutput', 1000], ['submissionRequirements', 1000], ['problemStatement', 1500], ['expectedBehavior', 1500], ['folderStructure', 1500]];
const CONTENT_LISTS = [['tools', 'Tools', 15, 2, 60], ['steps', 'Steps', 20, 5, 400], ['concepts', 'Concepts', 10, 5, 300], ['features', 'Required features', 15, 5, 300],
  ['technicalRequirements', 'Technical requirements', 12, 5, 300], ['testingRequirements', 'Testing requirements', 10, 5, 300], ['acceptanceCriteria', 'Acceptance criteria', 12, 5, 300],
  ['completionChecklist', 'Completion checklist', 15, 5, 200]];
function parseContent(v) {
  const o = asObject(v); const errors = {}; const out = {};
  for (const [k, max] of CONTENT_TEXT) {
    const t = block(o[k]); if (t.length > max) errors[k] = `Keep this to ${max} characters or fewer`; out[k] = t;
  }
  for (const [k, label, max, itemMin, itemMax] of CONTENT_LISTS) {
    const r = textList(o[k], { max, itemMin, itemMax, label }); if (r.error) errors[k] = r.error; else out[k] = r.value;
  }
  const rub = parseRubric(o.rubric); if (rub.error) errors.rubric = rub.error; else out.rubric = rub.value;
  if (o.learningStage !== undefined && o.learningStage !== null && o.learningStage !== '') {
    if (!LEARNING_STAGES.includes(o.learningStage)) errors.learningStage = `Learning stage must be one of: ${LEARNING_STAGES.join(', ')}`; else out.learningStage = o.learningStage;
  }
  return { value: out, errors };
}

function parseResources(v) {
  if (v === undefined || v === null) return { value: [] };
  if (!Array.isArray(v)) return { error: 'Resources must be a list' };
  if (v.length > 10) return { error: 'Use at most 10 resources' };
  const out = [];
  for (const r of v) {
    const o = asObject(r); const title = line(o.title); const url = parseHttpsUrl(o.url, 'Resource link');
    if (title.length < 3 || title.length > 120) return { error: 'Each resource needs a title of 3–120 characters' };
    if (url.error || !url.value) return { error: url.error ?? 'Each resource needs a link' };
    out.push({ title, url: url.value });
  }
  return { value: out };
}

// One parser for templates and internship tasks (an internship task is a copy of a template plus placement fields).
// partial=true (PATCH): only the keys that were sent are validated and returned.
export function parseTaskFields(input, { partial = false, template = false } = {}) {
  const b = asObject(input); const errors = {}; const v = {};
  const want = (k) => !partial || has(b, k);

  if (want('title')) { const t = line(b.title); if (t.length < 3 || t.length > 120) errors.title = 'Enter a title of 3–120 characters'; else v.title = t; }
  if (want('shortDescription')) { const t = block(b.shortDescription); if (t.length < 10 || t.length > 240) errors.shortDescription = 'Enter a short description of 10–240 characters'; else v.shortDescription = t; }
  if (want('difficulty')) { if (!TASK_DIFFICULTIES.includes(b.difficulty)) errors.difficulty = `Difficulty must be one of: ${TASK_DIFFICULTIES.join(', ')}`; else v.difficulty = b.difficulty; }
  if (want('taskType')) { if (!TASK_TYPES.includes(b.taskType)) errors.taskType = `Task type must be one of: ${TASK_TYPES.join(', ')}`; else v.taskType = b.taskType; }
  if (want('submissionType')) { if (!SUBMISSION_TYPES.includes(b.submissionType)) errors.submissionType = `Submission type must be one of: ${SUBMISSION_TYPES.join(', ')}`; else v.submissionType = b.submissionType; }
  if (want('estimatedHours')) {
    if (b.estimatedHours === null || b.estimatedHours === undefined || b.estimatedHours === '') v.estimatedHours = null;
    else if (!Number.isInteger(b.estimatedHours) || b.estimatedHours < 1 || b.estimatedHours > MAX_ESTIMATED_HOURS) errors.estimatedHours = `Estimated hours must be a whole number from 1 to ${MAX_ESTIMATED_HOURS}`;
    else v.estimatedHours = b.estimatedHours;
  }
  for (const [key, label, max, opts] of [
    ['learningObjectives', 'Learning objectives', 10, { itemMin: 5 }], ['requiredSkills', 'Required skills', 15, { itemMin: 2, itemMax: 60 }],
    ['deliverables', 'Deliverables', 10, { itemMin: 5 }], ['evaluationCriteria', 'Evaluation criteria', 10, { itemMin: 5 }],
  ]) {
    if (!want(key)) continue;
    const r = textList(b[key], { max, label, ...opts }); if (r.error) errors[key] = r.error; else v[key] = r.value;
  }
  if (want('resources')) { const r = parseResources(b.resources); if (r.error) errors.resources = r.error; else v.resources = r.value; }
  if (want('content')) { const r = parseContent(b.content); if (Object.keys(r.errors).length) errors.content = r.errors; else v.content = r.value; }

  if (template) {
    if (want('category')) { if (!CATEGORY_SLUGS.includes(b.category)) errors.category = 'Choose an internship category'; else v.category = b.category; }
    if (want('minDurationDays')) {
      if (b.minDurationDays === null || b.minDurationDays === undefined || b.minDurationDays === '') v.minDurationDays = null;
      else if (!DURATION_DAYS.includes(b.minDurationDays)) errors.minDurationDays = `Minimum internship length must be one of: ${DURATION_DAYS.join(', ')} days`;
      else v.minDurationDays = b.minDurationDays;
    }
  } else {
    if (want('isRequired')) {
      if (!partial && b.isRequired === undefined) v.isRequired = true; // a new task is required unless an administrator marks it optional
      else if (typeof b.isRequired !== 'boolean') errors.isRequired = 'Choose required or optional';
      else v.isRequired = b.isRequired;
    }
    if (want('dueAfterDays')) {
      if (b.dueAfterDays === null || b.dueAfterDays === undefined || b.dueAfterDays === '') v.dueAfterDays = null;
      else if (!Number.isInteger(b.dueAfterDays) || b.dueAfterDays < 1 || b.dueAfterDays > 365) errors.dueAfterDays = 'Deadline must be a whole number of days (1–365) after the internship starts';
      else v.dueAfterDays = b.dueAfterDays;
    }
  }
  if (v.content?.learningStage && (v.taskType ?? (has(b, 'taskType') ? b.taskType : null)) && STAGE_BY_TYPE[v.taskType ?? b.taskType] !== v.content.learningStage && !errors.content)
    errors.content = { learningStage: `A “${v.taskType ?? b.taskType}” belongs to the “${STAGE_BY_TYPE[v.taskType ?? b.taskType]}” stage` };
  const note = line(b.note); if (note.length > 300) errors.note = 'Keep the note to 300 characters or fewer';
  return finish({ ...v, note: note || null }, errors);
}

// A task may be PUBLISHED (and so handed to students) only when a student could actually do it from what is written.
export function publishReadiness(t) {
  const c = t.content ?? {}; const missing = [];
  if (!c.objective) missing.push('objective');
  if (!c.steps?.length) missing.push('at least one step-by-step instruction');
  if (!c.expectedOutput) missing.push('expected output');
  if (!c.submissionRequirements) missing.push('submission requirements');
  if (!t.evaluationCriteria?.length) missing.push('at least one evaluation criterion');
  if (!t.learningObjectives?.length) missing.push('at least one learning objective');
  // Tasks written in the Stage 09B format (they carry a learning stage) must be complete enough to build from. Beginner exercises and older tasks keep the simpler rule.
  if (c.learningStage && c.learningStage !== LEARNING_STAGES[0]) {
    if (!c.features?.length) missing.push('required features');
    if (!c.acceptanceCriteria?.length) missing.push('acceptance criteria');
    if (!c.testingRequirements?.length) missing.push('testing requirements');
    if (!c.rubric?.length) missing.push('an evaluation rubric');
  }
  return { ready: missing.length === 0, missing };
}

export function parseSequenceOrder(input) {
  const ids = asObject(input).taskIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || ids.some((i) => typeof i !== 'string')) throw badRequest('Please fix the highlighted fields', { taskIds: 'Send the full list of task IDs in the new order' });
  if (new Set(ids).size !== ids.length) throw badRequest('Please fix the highlighted fields', { taskIds: 'Each task may appear only once' });
  return ids;
}

// A student's submission. Which links are required follows the task's submission type (and every Mini/Final Project needs a repository).
// Only the fields below are read: anything else in the request (a student ID, a status, a score, a decision) is ignored, never stored.
export function parseSubmission(input, task) {
  const b = asObject(input); const errors = {};
  const description = block(b.description);
  if (description.length < 20) errors.description = 'Describe what you did (at least 20 characters)'; else if (description.length > 3000) errors.description = 'Keep the description to 3000 characters or fewer';
  const repo = parseGitHubRepoUrl(b.repositoryUrl); const live = parseHttpsUrl(b.liveUrl, 'Live project link'); const docs = parseHttpsUrl(b.documentationUrl, 'Documentation link');
  if (repo.error) errors.repositoryUrl = repo.error; if (live.error) errors.liveUrl = live.error; if (docs.error) errors.documentationUrl = docs.error;
  if (requiresRepository(task) && !repo.error && !repo.value) errors.repositoryUrl = 'This task needs a GitHub repository link';
  if (requiresLiveUrl(task) && !live.error && !live.value) errors.liveUrl = 'This task needs a live project link';
  const repositoryDescription = block(b.repositoryDescription);
  if (repositoryDescription && repositoryDescription.length < 10) errors.repositoryDescription = 'Say a little more about the repository (at least 10 characters), or leave this empty';
  else if (repositoryDescription.length > 300) errors.repositoryDescription = 'Keep the repository description to 300 characters or fewer';
  const submissionNotes = block(b.submissionNotes);
  if (submissionNotes.length > 1000) errors.submissionNotes = 'Keep the notes to 1000 characters or fewer';
  if (b.attachments !== undefined && !(Array.isArray(b.attachments) && b.attachments.length === 0)) errors.attachments = 'File attachments are not supported yet';
  // Stage 09C Part 2A: three optional-here (required by the GitHub submission service) narrative fields.
  const extra = {};
  for (const [k, label] of [['implementedFeatures', 'Implemented features'], ['testingPerformed', 'Testing performed'], ['challengesEncountered', 'Challenges encountered']]) {
    const t = block(b[k]);
    if (t && t.length < 10) errors[k] = `${label}: say a little more (at least 10 characters), or leave this empty`; else if (t.length > 2000) errors[k] = `${label}: keep this to 2000 characters or fewer`;
    extra[k] = t || null;
  }
  return finish({ ...extra, description, repositoryUrl: repo.value?.url ?? null, liveUrl: live.value ?? null, repositoryDescription: repositoryDescription || null, documentationUrl: docs.value ?? null, submissionNotes: submissionNotes || null }, errors);
}

export function parseReview(input) {
  const b = asObject(input); const errors = {};
  if (!REVIEW_DECISIONS.includes(b.decision)) errors.decision = `Decision must be one of: ${REVIEW_DECISIONS.join(', ')}`;
  const feedback = block(b.feedback);
  if (feedback.length > 2000) errors.feedback = 'Keep the feedback to 2000 characters or fewer';
  if (b.decision === 'Changes Requested' && feedback.length < 10) errors.feedback = 'Explain what needs to change (at least 10 characters) so the student can fix it';
  if (b.confirmReviewed !== true) errors.confirmReviewed = 'Confirm that you reviewed the submission';
  return finish({ decision: b.decision, feedback: feedback || null }, errors);
}

// ---- configurable criteria ----
export const APPLICATION_CRITERION_KEYS = ['profile_complete', 'skills_prerequisite', 'seats_available', 'application_window', 'account_active'];
export function parseApplicationCriteria(input) {
  const b = asObject(input); const errors = {}; const out = {};
  for (const k of APPLICATION_CRITERION_KEYS) {
    const c = asObject(asObject(b.criteria)[k]); if (!has(asObject(b.criteria), k)) continue;
    if (typeof c.enabled !== 'boolean') { errors[k] = 'Choose enabled or disabled'; continue; }
    out[k] = { enabled: c.enabled };
    if (k === 'skills_prerequisite') {
      const r = textList(c.requiredSkills, { max: 15, itemMin: 2, itemMax: 60, label: 'Required skills' });
      if (r.error) errors[k] = r.error; else out[k].requiredSkills = r.value;
      if (c.minMatches !== undefined) {
        if (!Number.isInteger(c.minMatches) || c.minMatches < 1 || c.minMatches > 15) errors[k] = 'Minimum matches must be a whole number from 1 to 15'; else out[k].minMatches = c.minMatches;
      }
      if (c.enabled && !errors[k] && !(out[k].requiredSkills?.length)) errors[k] = 'List the skills to check, or disable this check';
    }
  }
  if (!Object.keys(out).length && !Object.keys(errors).length) errors.criteria = 'Send at least one criterion';
  return finish({ criteria: out }, errors);
}
export function parseCompletionCriteria(input) {
  const b = asObject(input); const errors = {}; const out = {};
  if (has(b, 'requiredTasksApprovedPercent')) {
    if (!Number.isInteger(b.requiredTasksApprovedPercent) || b.requiredTasksApprovedPercent < 50 || b.requiredTasksApprovedPercent > 100) errors.requiredTasksApprovedPercent = 'Enter a whole number from 50 to 100';
    else out.requiredTasksApprovedPercent = b.requiredTasksApprovedPercent;
  }
  if (has(b, 'requireFinalProject')) { if (typeof b.requireFinalProject !== 'boolean') errors.requireFinalProject = 'Choose yes or no'; else out.requireFinalProject = b.requireFinalProject; }
  if (!Object.keys(out).length && !Object.keys(errors).length) errors.criteria = 'Send at least one setting';
  return finish(out, errors);
}

export const parseEvaluationReview = (input) => {
  const b = asObject(input); const errors = {};
  if (!['accepted', 'overridden', 'information_requested'].includes(b.action)) errors.action = 'Action must be accepted, overridden or information_requested';
  const reason = line(b.reason);
  if (b.action !== 'accepted' && reason.length < 10) errors.reason = 'Give a reason (at least 10 characters). It is saved in the audit record.';
  if (reason.length > 500) errors.reason = 'Keep the reason to 500 characters or fewer';
  if (b.evaluationId !== undefined && typeof b.evaluationId !== 'string') errors.evaluationId = 'Invalid evaluation';
  return finish({ action: b.action, reason: reason || null, evaluationId: b.evaluationId ?? null }, errors);
};
