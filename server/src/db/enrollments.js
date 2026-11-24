import { db } from './index.js';
import { newEnrollmentId } from '../utils/enrollmentId.js';
import { insert as notify } from './notifications.js';
import { record as audit } from './audit.js';

// All enrollment SQL lives here. Student reads are scoped by BOTH enrollments.student_id and applications.student_id
// and only return enrollments whose application is currently Approved, so a student can never see someone else's
// record, or an internship whose approval was withdrawn.
const SELECT = `SELECT e.*, a.internship_id, a.internship_title, a.internship_category, a.internship_duration_days,
    a.status AS application_status FROM enrollments e JOIN applications a ON a.id = e.application_id`;

const toEnrollment = (r) => r && ({
  id: r.id, applicationId: r.application_id, studentId: r.student_id,
  internship: { id: r.internship_id, title: r.internship_title, category: r.internship_category, durationDays: r.internship_duration_days },
  applicationStatus: r.application_status,
  status: r.status, startDate: r.start_date, expectedEndDate: r.expected_end_date,
  assignedProject: r.assigned_project, learningObjectives: JSON.parse(r.learning_objectives || '[]'), instructions: r.instructions,
  createdAt: r.created_at, activatedAt: r.activated_at, completedAt: r.completed_at, suspendedAt: r.suspended_at, cancelledAt: r.cancelled_at,
  certificate: r.certificate_id ? { id: r.certificate_id, issuedAt: r.certificate_issued_at } : null,
  certificateReview: { decision: r.certificate_decision, decidedAt: r.certificate_decided_at, decidedBy: r.certificate_decided_by, note: r.certificate_decision_note },
  progressPercent: r.progress_percent ?? null, updatedAt: r.updated_at,
});

export class DuplicateEnrollmentError extends Error {}
const isConstraint = (err) => String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT');

// ----- student reads -----
export const listForStudent = (studentId) =>
  db.prepare(`${SELECT} WHERE e.student_id = ? AND a.student_id = ? AND a.status = 'Approved' ORDER BY e.created_at DESC, e.id`)
    .all(studentId, studentId).map(toEnrollment);

export const findForApplicationOwned = (applicationId, studentId) =>
  toEnrollment(db.prepare(`${SELECT} WHERE e.application_id = ? AND e.student_id = ? AND a.student_id = ? AND a.status = 'Approved'`)
    .get(applicationId, studentId, studentId));

export const countByStatusForStudent = (studentId) =>
  db.prepare(`SELECT e.status, COUNT(*) AS n FROM enrollments e JOIN applications a ON a.id = e.application_id
      WHERE e.student_id = ? AND a.student_id = ? AND a.status = 'Approved' GROUP BY e.status`)
    .all(studentId, studentId).reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

// ----- admin -----
export const findById = (id) => toEnrollment(db.prepare(`${SELECT} WHERE e.id = ?`).get(id));
export const findByApplication = (applicationId) => toEnrollment(db.prepare(`${SELECT} WHERE e.application_id = ?`).get(applicationId));

export function create({ application, details }) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newEnrollmentId(application.id);
      try {
        db.prepare(`INSERT INTO enrollments (id, application_id, student_id, status, start_date, expected_end_date, assigned_project,
            learning_objectives, instructions, created_at, updated_at)
          VALUES (@id, @applicationId, @studentId, 'Awaiting Start', @startDate, @expectedEndDate, @assignedProject, @objectives, @instructions, @now, @now)`)
          .run({
            id, applicationId: application.id, studentId: details.studentId, startDate: details.startDate, expectedEndDate: details.expectedEndDate,
            assignedProject: details.assignedProject, objectives: JSON.stringify(details.learningObjectives), instructions: details.instructions, now,
          });
        const created = findById(id);
        notify({ studentId: details.studentId, type: 'internship_progress', title: 'Your internship has been set up',
          message: `${created.internship.title} is ready. We'll notify you when it starts.`, applicationId: application.id, enrollmentId: id });
        return created;
      } catch (err) {
        if (!isConstraint(err)) throw err;
        throw new DuplicateEnrollmentError(); // the ID is derived from the application, so a clash means this application already has an internship
      }
    }
    throw new Error('Could not generate a unique enrollment ID');
  })();
}

export function updateDetails(id, d, actor = null) {
  return db.transaction(() => updateDetailsTx(id, d, actor))();
}
function updateDetailsTx(id, d, actor) {
  db.prepare(`UPDATE enrollments SET start_date = @startDate, expected_end_date = @expectedEndDate, assigned_project = @assignedProject,
      learning_objectives = @objectives, instructions = @instructions, updated_at = @now WHERE id = @id`)
    .run({ id, startDate: d.startDate, expectedEndDate: d.expectedEndDate, assignedProject: d.assignedProject,
      objectives: JSON.stringify(d.learningObjectives), instructions: d.instructions, now: new Date().toISOString() });
  const e = findById(id);
  addEvent(id, { kind: 'details', detail: 'Dates, project or instructions updated', actor });
  notify({ studentId: e.studentId, type: 'internship_progress', title: 'Internship details updated',
    message: `The details of ${e.internship.title} (dates, project or instructions) were updated.`, applicationId: e.applicationId, enrollmentId: id });
  return e;
}

// `patch` is built by services/enrollments.js (status plus the timestamp/date columns that go with it).
export function applyTransition(id, patch, notice = null, event = null) {
  return db.transaction(() => applyTransitionTx(id, patch, notice, event))();
}
function applyTransitionTx(id, patch, notice, event) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE enrollments SET status = @status, start_date = @startDate, expected_end_date = @expectedEndDate,
      activated_at = @activatedAt, completed_at = @completedAt, suspended_at = @suspendedAt, cancelled_at = @cancelledAt, updated_at = @now WHERE id = @id`)
    .run({ id, now, ...patch });
  const e = findById(id);
  if (event) addEvent(id, event);
  if (event?.kind === 'status') {
    const action = { Active: event.from === 'Suspended' ? 'internship.resume' : 'internship.activate', Suspended: 'internship.suspend', Completed: 'internship.complete', Cancelled: 'internship.cancel' }[event.to];
    if (action) audit({ admin: event.actor ?? null, action, targetType: 'internship', targetId: id, reason: `${event.from} → ${event.to}${event.detail ? ` — ${event.detail}` : ''}` });
  }
  if (notice) notify({ studentId: e.studentId, type: notice.type, title: notice.title, message: notice.message.replace('{title}', e.internship.title), applicationId: e.applicationId, enrollmentId: id });
  return e;
}

// Stage 07B: append-only internship history (never updated or deleted) and progress.
export function addEvent(enrollmentId, { kind, from = null, to = null, detail = null, actor = null }) {
  const name = actor?.fullName ?? (actor?.via === 'key' ? 'Admin API key' : actor ? 'Administrator' : 'Automation');
  db.prepare('INSERT INTO enrollment_events (enrollment_id, kind, from_status, to_status, detail, actor_id, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(enrollmentId, kind, from, to, detail, actor?.id ?? null, name, new Date().toISOString());
}
export const eventsFor = (enrollmentId) =>
  db.prepare('SELECT id, kind, from_status, to_status, detail, actor_name, created_at FROM enrollment_events WHERE enrollment_id = ? ORDER BY id').all(enrollmentId)
    .map((r) => ({ id: r.id, kind: r.kind, from: r.from_status, to: r.to_status, detail: r.detail, by: r.actor_name, at: r.created_at }));
export function setProgress(id, percent, { actor, note = null, previous = null }) {
  return db.transaction(() => {
    db.prepare('UPDATE enrollments SET progress_percent = ?, updated_at = ? WHERE id = ?').run(percent, new Date().toISOString(), id);
    const e = findById(id);
    addEvent(id, { kind: 'progress', detail: `${previous === null ? 'not recorded' : `${previous}%`} → ${percent}%${note ? ` — ${note}` : ''}`, actor });
    notify({ studentId: e.studentId, type: 'internship_progress', title: 'Internship progress updated', message: `Your progress in ${e.internship.title} is now ${percent}%.`, applicationId: e.applicationId, enrollmentId: id });
    return e;
  })();
}

// Admin console list: every internship with the student's name and email and the documents already issued.
export function listAllForAdmin(limit = 200) {
  const rows = db.prepare(`${SELECT.replace('FROM enrollments e', ', s.full_name AS student_name, s.email AS student_email FROM enrollments e')}
      JOIN students s ON s.id = e.student_id ORDER BY e.created_at DESC, e.id LIMIT ?`).all(limit);
  const docs = db.prepare('SELECT enrollment_id, type FROM documents').all();
  return rows.map((r) => ({
    ...toEnrollment(r), studentName: r.student_name, studentEmail: r.student_email,
    documents: docs.filter((d) => d.enrollment_id === r.id).map((d) => d.type),
  }));
}

// ---- Stage 07: certificate approval + automation ----
// Administrator's decision on whether this intern may receive a certificate. The caller (services/certificateApproval.js) has
// already checked the rules; the notice is written in the same transaction so the student is told exactly when it is recorded.
export function setCertificateDecision(id, { decision, note, decidedBy }, notice = null) {
  return db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE enrollments SET certificate_decision = @decision, certificate_decided_at = @now, certificate_decided_by = @decidedBy,
        certificate_decision_note = @note, updated_at = @now WHERE id = @id`).run({ id, decision, note: note || null, decidedBy, now });
    const e = findById(id);
    if (notice) notify({ studentId: e.studentId, type: notice.type, title: notice.title, message: notice.message.replace('{title}', e.internship.title), applicationId: e.applicationId, enrollmentId: id });
    return e;
  })();
}

// Queries the background worker uses. A document that was ever Issued or Revoked is never re-created automatically:
// a revoked document means a person decided something, so only a person may replace it.
const NO_FINAL_DOC = (type) => `NOT EXISTS (SELECT 1 FROM documents d WHERE d.enrollment_id = e.id AND d.type = '${type}' AND d.status IN ('Issued', 'Revoked'))`;
export const listNeedingOffer = () =>
  db.prepare(`SELECT e.id FROM enrollments e JOIN applications a ON a.id = e.application_id
    WHERE a.status = 'Approved' AND e.status <> 'Cancelled' AND e.start_date IS NOT NULL AND e.expected_end_date IS NOT NULL AND ${NO_FINAL_DOC('offer_letter')}
    ORDER BY e.created_at, e.id`).all().map((r) => r.id);
export const listNeedingCertificate = () =>
  db.prepare(`SELECT e.id FROM enrollments e JOIN applications a ON a.id = e.application_id
    WHERE a.status = 'Approved' AND e.status = 'Completed' AND e.completed_at IS NOT NULL AND e.certificate_decision = 'Approved' AND ${NO_FINAL_DOC('certificate')}
    ORDER BY e.completed_at, e.id`).all().map((r) => r.id);
// Internships whose start date has arrived (India date supplied by the caller).
export const listDueToStart = (today) =>
  db.prepare(`SELECT e.id FROM enrollments e JOIN applications a ON a.id = e.application_id
    WHERE a.status = 'Approved' AND e.status = 'Awaiting Start' AND e.start_date IS NOT NULL AND e.start_date <= ? ORDER BY e.start_date, e.id`).all(today).map((r) => r.id);
// Active internships the administrator already approved a certificate for, whose end date has passed: they can be completed.
export const listDueToComplete = (today) =>
  db.prepare(`SELECT e.id FROM enrollments e JOIN applications a ON a.id = e.application_id
    WHERE a.status = 'Approved' AND e.status = 'Active' AND e.certificate_decision = 'Approved' AND e.expected_end_date IS NOT NULL AND e.expected_end_date <= ? ORDER BY e.expected_end_date, e.id`).all(today).map((r) => r.id);

// Admin "Certificate approvals" list. Only internships that can still receive a certificate decision.
export function listForCertificateReview(limit = 300) {
  const rows = db.prepare(`${SELECT.replace('FROM enrollments e', ', s.full_name AS student_name, s.email AS student_email FROM enrollments e')}
      JOIN students s ON s.id = e.student_id WHERE a.status = 'Approved' AND e.status IN ('Active', 'Completed', 'Suspended')
      ORDER BY CASE e.certificate_decision WHEN 'Pending' THEN 0 WHEN 'Approved' THEN 1 ELSE 2 END, (e.status = 'Completed') DESC, e.updated_at DESC LIMIT ?`).all(limit);
  const certs = db.prepare("SELECT enrollment_id, status, document_number FROM documents WHERE type = 'certificate' AND status <> 'Draft'").all();
  return rows.map((r) => {
    const c = certs.filter((x) => x.enrollment_id === r.id).sort((a, b) => (a.status === 'Issued' ? -1 : 1) - (b.status === 'Issued' ? -1 : 1))[0];
    return { ...toEnrollment(r), studentName: r.student_name, studentEmail: r.student_email, certificateDocument: c ? { status: c.status, number: c.document_number } : null };
  });
}
