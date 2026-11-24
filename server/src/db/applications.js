import { db } from './index.js';
import { updateApplicationProfile } from './students.js';
import { newApplicationId } from '../utils/applicationId.js';
import { insert as notify } from './notifications.js';
import { record as audit } from './audit.js';

// All application SQL lives here. Every query is parameterised, and every read is scoped by student_id unless
// it is the admin lookup (findById), so one student can never load another's row by guessing an ID.
const toApplication = (r) => r && ({
  id: r.id,
  internship: { id: r.internship_id, title: r.internship_title, category: r.internship_category, durationDays: r.internship_duration_days },
  responses: {
    fullName: r.full_name, email: r.email, phone: r.phone, college: r.college, degree: r.degree, branch: r.branch,
    academicYear: r.academic_year, skills: JSON.parse(r.skills || '[]'), motivation: r.motivation,
  },
  status: r.status, submittedAt: r.submitted_at, updatedAt: r.updated_at,
});

export class DuplicateApplicationError extends Error {}

const isConstraint = (err) => String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT');

export const findByStudentAndInternship = (studentId, internshipId) =>
  toApplication(db.prepare('SELECT * FROM applications WHERE student_id = ? AND internship_id = ?').get(studentId, internshipId));

export const findOwned = (id, studentId) =>
  toApplication(db.prepare('SELECT * FROM applications WHERE id = ? AND student_id = ?').get(id, studentId));

export const listForStudent = (studentId) =>
  db.prepare('SELECT * FROM applications WHERE student_id = ? ORDER BY submitted_at DESC, id').all(studentId).map(toApplication);

export const findById = (id) => toApplication(db.prepare('SELECT * FROM applications WHERE id = ?').get(id));

// Saves the application AND the profile details the student filled in, or neither (one transaction).
// Throws DuplicateApplicationError when this student already applied (UNIQUE(student_id, internship_id)).
export function createApplication({ student, internship, responses }) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    updateApplicationProfile(student.id, responses);
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newApplicationId();
      try {
        db.prepare(`INSERT INTO applications (id, student_id, internship_id, internship_title, internship_category,
            internship_duration_days, full_name, email, phone, college, degree, branch, academic_year, skills, motivation,
            terms_accepted_at, status, submitted_at, updated_at)
          VALUES (@id, @studentId, @internshipId, @title, @category, @days, @fullName, @email, @phone, @college, @degree,
            @branch, @academicYear, @skills, @motivation, @now, 'Submitted', @now, @now)`)
          .run({
            id, studentId: student.id, internshipId: internship.id, title: internship.title, category: internship.category,
            days: internship.durationDays, email: student.email, ...responses, skills: JSON.stringify(responses.skills), now,
          });
        db.prepare('INSERT INTO application_status_history (application_id, status, changed_at) VALUES (?, \'Submitted\', ?)').run(id, now);
        notify({ studentId: student.id, type: 'application_submitted', title: 'Application submitted',
          message: `Your application for ${internship.title} was submitted. We'll let you know when its status changes.`, applicationId: id });
        return findOwned(id, student.id);
      } catch (err) {
        if (!isConstraint(err)) throw err;
        if (/applications\.id\b/.test(err.message)) continue; // 1-in-a-trillion ID collision: draw another ID
        throw new DuplicateApplicationError(); // the unique (student, internship) pair already exists
      }
    }
    throw new Error('Could not generate a unique application ID');
  })();
}

// Admin only (see routes/admin.js). Returns the updated application, or null if the ID does not exist.
// Every real change is also written to application_status_history so the timeline can show when it happened.
export function setStatus(id, status) {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const before = db.prepare('SELECT status, student_id, internship_title FROM applications WHERE id = ?').get(id);
    if (!before) return null;
    db.prepare('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    if (before.status !== status) {
      db.prepare('INSERT INTO application_status_history (application_id, status, changed_at) VALUES (?, ?, ?)').run(id, status, now);
      const t = before.internship_title;
      const text = {
        Approved: ['application_approved', 'Application approved', `Congratulations! Your application for ${t} was approved.`],
        Rejected: ['application_rejected', 'Application not selected', `Your application for ${t} was not selected this time.`],
      }[status] ?? ['application_status', 'Application status changed', `Your application for ${t} is now “${status}”.`];
      notify({ studentId: before.student_id, type: text[0], title: text[1], message: text[2], applicationId: id });
    }
    return findById(id);
  })();
}

// Stage 05A: dashboard reads. Both are scoped by student_id, so they only ever see the signed-in student's rows.
export const countByStatus = (studentId) =>
  db.prepare('SELECT status, COUNT(*) AS n FROM applications WHERE student_id = ? GROUP BY status').all(studentId)
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

export const listRecentForStudent = (studentId, limit) =>
  db.prepare('SELECT * FROM applications WHERE student_id = ? ORDER BY submitted_at DESC, id LIMIT ?').all(studentId, limit).map(toApplication);

// Stage 05B. Student list with an optional status filter and pagination. Always scoped by student_id.
// `status` must already be validated against APPLICATION_STATUSES by the caller (it is still bound as a parameter).
export function pageForStudent(studentId, { status = null, limit, offset }) {
  const where = status ? 'student_id = ? AND status = ?' : 'student_id = ?';
  const args = status ? [studentId, status] : [studentId];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM applications WHERE ${where} ORDER BY submitted_at DESC, id LIMIT ? OFFSET ?`)
    .all(...args, limit, offset).map(toApplication);
  return { total, rows };
}

// Latest time each status was set for one application: { 'Under Review': iso, Approved: iso, ... }.
// Callers must only pass an application ID they have already verified the student owns.
export function statusDates(applicationId) {
  const rows = db.prepare('SELECT status, changed_at FROM application_status_history WHERE application_id = ? ORDER BY id').all(applicationId);
  return rows.reduce((acc, r) => ({ ...acc, [r.status]: r.changed_at }), {});
}

// Admin only: who owns an application (used when an administrator links an enrollment to it).
export const ownerOf = (id) => db.prepare('SELECT student_id FROM applications WHERE id = ?').get(id)?.student_id ?? null;

// ---- Admin console reads (routes/admin.js only). Every value is bound as a parameter; LIKE wildcards in the search are escaped. ----
const escapeLike = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
export function pageForAdmin({ status = null, q = '', limit, offset }) {
  const where = []; const args = [];
  if (status) { where.push('a.status = ?'); args.push(status); }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push("(a.id LIKE ? ESCAPE '\\' OR a.full_name LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\' OR a.internship_title LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM applications a ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT a.*, e.id AS enrollment_id, e.status AS enrollment_status FROM applications a
      LEFT JOIN enrollments e ON e.application_id = a.id ${w} ORDER BY a.submitted_at DESC, a.id LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)
    .map((r) => ({ ...toApplication(r), studentId: r.student_id, internshipRecord: r.enrollment_id ? { id: r.enrollment_id, status: r.enrollment_status } : null }));
  return { total, rows };
}
export const countAllByStatus = () =>
  db.prepare('SELECT status, COUNT(*) AS n FROM applications GROUP BY status').all().reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

// Stage 07 (background worker): approved applications that still have no internship record, with the time they were approved.
export const listApprovedWithoutEnrollment = () =>
  db.prepare(`SELECT a.id, (SELECT MAX(h.changed_at) FROM application_status_history h WHERE h.application_id = a.id AND h.status = 'Approved') AS approved_at
    FROM applications a LEFT JOIN enrollments e ON e.application_id = a.id WHERE a.status = 'Approved' AND e.id IS NULL ORDER BY a.updated_at, a.id`)
    .all().map((r) => ({ id: r.id, approvedAt: r.approved_at }));
export const approvedAt = (applicationId) =>
  db.prepare("SELECT MAX(changed_at) AS t FROM application_status_history WHERE application_id = ? AND status = 'Approved'").get(applicationId)?.t ?? null;

// ---------- Stage 07B: reviewed status changes, internal notes and the admin detail view ----------
import { HttpError } from '../utils/errors.js';
import { canTransition, allowedNext } from '../utils/applicationTransitions.js';

const actorOf = (admin) => ({ id: admin?.id ?? null, name: admin?.fullName ?? (admin?.via === 'key' ? 'Admin API key' : 'Administrator') });

// Validated status change. The current status is read INSIDE the transaction, so two admins can't both apply a stale transition.
// Appends one history row (from, to, who, why, when) and one student notification, or changes nothing at all.
// Returns { application, changed }, or null when the ID doesn't exist.
export function changeStatus(id, status, { admin, note = null } = {}) {
  return db.transaction(() => {
    const before = db.prepare('SELECT status, student_id, internship_title FROM applications WHERE id = ?').get(id);
    if (!before) return null;
    if (before.status === status) return { application: findById(id), changed: false };
    if (!canTransition(before.status, status)) {
      throw new HttpError(409, `An application that is “${before.status}” can’t be changed to “${status}”.`, {
        code: 'INVALID_TRANSITION', details: { from: before.status, to: status, allowed: allowedNext(before.status) },
      });
    }
    const now = new Date().toISOString();
    const who = actorOf(admin);
    db.prepare('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    db.prepare('INSERT INTO application_status_history (application_id, status, changed_at, from_status, changed_by, changed_by_name, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, status, now, before.status, who.id, who.name, note);
    const t = before.internship_title;
    const text = {
      Approved: ['application_approved', 'Application approved', `Congratulations! Your application for ${t} was approved.`],
      Rejected: ['application_rejected', 'Application not selected', `Your application for ${t} was not selected this time.`],
    }[status] ?? ['application_status', 'Application status changed', `Your application for ${t} is now “${status}”.`];
    notify({ studentId: before.student_id, type: text[0], title: text[1], message: text[2], applicationId: id });
    audit({ admin, action: 'application.status_change', targetType: 'application', targetId: id, reason: `${before.status} → ${status}${note ? ` — ${note}` : ''}` });
    return { application: findById(id), changed: true };
  })();
}

export function addNote(applicationId, note, admin) {
  const who = actorOf(admin);
  const exists = db.prepare('SELECT 1 FROM applications WHERE id = ?').get(applicationId);
  if (!exists) return null;
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO application_notes (application_id, admin_id, admin_name, note, created_at) VALUES (?, ?, ?, ?, ?)').run(applicationId, who.id, who.name, note, now);
  return { id: Number(r.lastInsertRowid), note, adminName: who.name, createdAt: now };
}

// Everything the admin detail view needs. Student contact details are read live from the student record; the application's own
// snapshot (what the student submitted) is returned separately and never overwritten.
export function adminDetails(id) {
  const base = findById(id);
  if (!base) return null;
  const row = db.prepare(`SELECT a.student_id, a.terms_accepted_at, s.full_name AS s_name, s.email AS s_email, s.phone AS s_phone, s.college AS s_college,
      s.graduation_year AS s_grad, s.github_url, s.linkedin_url, s.created_at AS s_created FROM applications a LEFT JOIN students s ON s.id = a.student_id WHERE a.id = ?`).get(id);
  const history = db.prepare('SELECT id, status, changed_at, from_status, changed_by_name, note FROM application_status_history WHERE application_id = ? ORDER BY id').all(id)
    .map((h) => ({ id: h.id, from: h.from_status, status: h.status, changedAt: h.changed_at, changedBy: h.changed_by_name, note: h.note }));
  const notes = db.prepare('SELECT id, admin_name, note, created_at FROM application_notes WHERE application_id = ? ORDER BY id').all(id)
    .map((n) => ({ id: n.id, note: n.note, adminName: n.admin_name, createdAt: n.created_at }));
  const decision = [...history].reverse().find((h) => h.status === 'Approved' || h.status === 'Rejected');
  const enr = db.prepare('SELECT id, status FROM enrollments WHERE application_id = ?').get(id);
  return {
    ...base,
    student: { id: row.student_id, fullName: row.s_name ?? base.responses.fullName, email: row.s_email ?? base.responses.email, phone: row.s_phone ?? base.responses.phone,
      college: row.s_college ?? base.responses.college, graduationYear: row.s_grad ?? null, github: row.github_url || null, linkedin: row.linkedin_url || null, registeredAt: row.s_created ?? null },
    termsAcceptedAt: row.terms_accepted_at,
    decidedAt: decision && base.status === decision.status ? decision.changedAt : null,
    history, notes, allowedNext: enr ? [] : allowedNext(base.status), internshipRecord: enr ? { id: enr.id, status: enr.status } : null,
  };
}

// Instant offer (admin): an application the ADMINISTRATOR creates on behalf of a student, for a listing the student may not have
// applied to (for example a private, unpublished internship). The student's own profile is read, never changed. The row starts as
// "Submitted"; the caller then approves it through changeStatus() so history, notification and audit entries are written the usual way.
export function createByAdmin({ student, internship, note }) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newApplicationId();
      try {
        db.prepare(`INSERT INTO applications (id, student_id, internship_id, internship_title, internship_category,
            internship_duration_days, full_name, email, phone, college, degree, branch, academic_year, skills, motivation,
            terms_accepted_at, status, submitted_at, updated_at)
          VALUES (@id, @studentId, @internshipId, @title, @category, @days, @fullName, @email, @phone, @college, @degree,
            @branch, @academicYear, @skills, @motivation, @now, 'Submitted', @now, @now)`)
          .run({
            id, studentId: student.id, internshipId: internship.id, title: internship.title, category: internship.category, days: internship.durationDays,
            fullName: student.fullName, email: student.email, phone: student.phone || 'Not provided', college: student.college || 'Not provided',
            degree: student.degree || 'Not provided', branch: student.branch || 'Not provided', academicYear: student.academicYear || 'Not provided',
            skills: JSON.stringify(student.skills ?? []), motivation: note, now,
          });
        db.prepare('INSERT INTO application_status_history (application_id, status, changed_at) VALUES (?, \'Submitted\', ?)').run(id, now);
        return findById(id);
      } catch (err) {
        if (!isConstraint(err)) throw err;
        if (/applications\.id\b/.test(err.message)) continue;
        throw new DuplicateApplicationError();
      }
    }
    throw new Error('Could not generate a unique application ID');
  })();
}
