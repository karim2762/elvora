import crypto from 'node:crypto';
import { db } from './index.js';

// Stage 09A — application evaluation SQL. Evaluations and the administrator's responses are append-only (triggers reject UPDATE).
// Nothing in this file touches applications.status: an evaluation is advice kept next to the application, never a decision.
const json = (v, d) => { try { return JSON.parse(v ?? ''); } catch { return d; } };
const toEvaluation = (r) => r && ({
  id: r.id, applicationId: r.application_id, statusAtTime: r.status_at_time, recommendation: r.recommendation, criteria: json(r.criteria, []), config: json(r.config, {}),
  evaluatedBy: r.evaluated_by_name, evaluatedAt: r.evaluated_at,
});
export const latestFor = (applicationId) => toEvaluation(db.prepare('SELECT * FROM application_evaluations WHERE application_id = ? ORDER BY evaluated_at DESC, rowid DESC LIMIT 1').get(applicationId));
export const findById = (id) => toEvaluation(db.prepare('SELECT * FROM application_evaluations WHERE id = ?').get(id));
export const countFor = (applicationId) => db.prepare('SELECT COUNT(*) AS n FROM application_evaluations WHERE application_id = ?').get(applicationId).n;

export function insertEvaluation({ application, recommendation, criteria, config, admin }) {
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `EVL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    try {
      db.prepare(`INSERT INTO application_evaluations (id, application_id, status_at_time, recommendation, criteria, config, evaluated_by, evaluated_by_name, evaluated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, application.id, application.status, recommendation, JSON.stringify(criteria), JSON.stringify(config), admin?.id ?? null, admin?.fullName ?? 'Administrator', now);
      return findById(id);
    } catch (err) { if (!String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT') || !/application_evaluations\.id/.test(err.message)) throw err; }
  }
  throw new Error('Could not generate a unique evaluation ID');
}
export const insertReview = ({ evaluationId, applicationId, action, reason, admin }) => {
  const r = db.prepare('INSERT INTO application_evaluation_reviews (evaluation_id, application_id, action, reason, admin_id, admin_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(evaluationId, applicationId, action, reason, admin?.id ?? null, admin?.fullName ?? 'Administrator', new Date().toISOString());
  return Number(r.lastInsertRowid);
};
export const reviewsFor = (applicationId) => db.prepare('SELECT * FROM application_evaluation_reviews WHERE application_id = ? ORDER BY id').all(applicationId)
  .map((r) => ({ id: r.id, evaluationId: r.evaluation_id, action: r.action, reason: r.reason, by: r.admin_name, at: r.created_at }));

// Inputs the criteria need (read-only).
export const approvedCount = (internshipId, excludeApplicationId) =>
  db.prepare("SELECT COUNT(*) AS n FROM applications WHERE internship_id = ? AND status = 'Approved' AND id <> ?").get(internshipId, excludeApplicationId).n;
export const otherApplicationsCount = (studentId, internshipId, excludeApplicationId) =>
  db.prepare('SELECT COUNT(*) AS n FROM applications WHERE student_id = ? AND internship_id = ? AND id <> ?').get(studentId, internshipId, excludeApplicationId).n;
export const openApplicationIds = ({ internshipId = null, limit = 200 }) =>
  db.prepare(`SELECT id FROM applications WHERE status IN ('Submitted', 'Under Review') ${internshipId ? 'AND internship_id = ?' : ''} ORDER BY submitted_at, id LIMIT ?`)
    .all(...(internshipId ? [internshipId, limit] : [limit])).map((r) => r.id);
