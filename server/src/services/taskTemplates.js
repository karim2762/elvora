import { HttpError, notFound } from '../utils/errors.js';
import { db } from '../db/index.js';
import * as repo from '../db/tasks.js';
import { record as audit } from '../db/audit.js';
import { parseTaskFields, publishReadiness } from '../utils/taskValidation.js';
import { CATEGORIES } from '../internships/categories.js';
import { stageOf } from '../tasks/constants.js';

// Stage 09A — the reusable task library. A template belongs to ONE internship category and is plain content: nothing about a student lives here.
// Editing a template never changes an internship that already copied it (see services/internshipTasks.js: attach copies the content).
const conflict = (message, code, details) => new HttpError(409, message, { code, details });
const load = (id) => { const t = repo.findTemplate(id); if (!t) throw notFound('Task template not found', 'TEMPLATE_NOT_FOUND'); return t; };
const withReadiness = (t) => ({ ...t, learningStage: stageOf(t), readiness: publishReadiness(t), categoryLabel: CATEGORIES.find((c) => c.slug === t.category)?.label ?? t.category });
const NOTE = 'Editing a template does not change internships that already use it. Edit the internship’s own task instead.';

export function listTemplates({ category = null, state = null, q = '', taskType = null, page = 1, pageSize = 20 }) {
  const probe = repo.pageTemplates({ category, state, q, taskType, limit: 1, offset: 0 });
  const totalPages = Math.max(1, Math.ceil(probe.total / pageSize)); const current = Math.min(page, totalPages);
  const { total, rows } = repo.pageTemplates({ category, state, q, taskType, limit: pageSize, offset: (current - 1) * pageSize });
  return { templates: rows.map(withReadiness), pagination: { page: current, pageSize, total, totalPages } };
}
export const getTemplate = (id) => ({ template: withReadiness(load(id)) });

export function createTemplate(body, admin) {
  const v = parseTaskFields(body, { template: true });
  return db.transaction(() => {
    const t = repo.insertTemplate(v, admin);
    audit({ admin, action: 'task_template.create', targetType: 'task_template', targetId: t.id, reason: `${t.category}: ${t.title}` });
    return { template: withReadiness(t), note: NOTE };
  })();
}

export function editTemplate(id, body, admin) {
  const current = load(id);
  if (current.archivedAt) throw conflict('An archived template can’t be edited. Restore it by creating a new one.', 'TEMPLATE_ARCHIVED');
  const v = parseTaskFields(body, { template: true, partial: true });
  const { note: _n, ...changes } = v;
  const merged = { ...current, ...changes, content: changes.content ?? current.content };
  if (current.published) {
    const r = publishReadiness(merged);
    if (!r.ready) throw conflict(`A published template must stay complete. Missing: ${r.missing.join(', ')}. Unpublish it first to work on it.`, 'TEMPLATE_INCOMPLETE', { missing: r.missing });
  }
  return db.transaction(() => {
    const t = repo.updateTemplate(id, merged, admin);
    audit({ admin, action: 'task_template.update', targetType: 'task_template', targetId: id, reason: `v${t.version}: ${Object.keys(changes).join(', ') || 'no changes'}` });
    return { template: withReadiness(t), note: NOTE };
  })();
}

export function setTemplateState(id, action, admin) {
  const current = load(id);
  if (!['publish', 'unpublish', 'archive'].includes(action)) throw new HttpError(400, 'Action must be publish, unpublish or archive', { code: 'VALIDATION', fields: { action: 'Choose publish, unpublish or archive' } });
  if (current.archivedAt) throw conflict('This template is archived.', 'TEMPLATE_ARCHIVED');
  if (action === 'publish') {
    const r = publishReadiness(current);
    if (!r.ready) throw conflict(`This template can’t be published yet. Missing: ${r.missing.join(', ')}.`, 'TEMPLATE_INCOMPLETE', { missing: r.missing });
  }
  return db.transaction(() => {
    const t = action === 'archive' ? repo.setTemplateFlags(id, { archived: true }, admin) : repo.setTemplateFlags(id, { published: action === 'publish' }, admin);
    audit({ admin, action: `task_template.${action}`, targetType: 'task_template', targetId: id, reason: current.title });
    return { template: withReadiness(t) };
  })();
}
