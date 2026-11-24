import crypto from 'node:crypto';
import { db } from './index.js';
import { insert as notify } from './notifications.js';
import { record as audit } from './audit.js';

const rowToStudent = (r) => r && ({
  id: r.id, fullName: r.full_name, email: r.email, phone: r.phone, passwordHash: r.password_hash,
  college: r.college, degree: r.degree, branch: r.branch, academicYear: r.academic_year,
  graduationYear: r.graduation_year, role: r.role, accountStatus: r.account_status ?? 'active', skills: JSON.parse(r.skills || '[]'),
  github: r.github_url || '', linkedin: r.linkedin_url || '', createdAt: r.created_at, updatedAt: r.updated_at,
});

export const findByEmail = (email) => rowToStudent(db.prepare('SELECT * FROM students WHERE email = ?').get(email));
export const findById = (id) => rowToStudent(db.prepare('SELECT * FROM students WHERE id = ?').get(id));

export function createStudent(s) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO students (id, full_name, email, phone, password_hash, college, degree, branch, academic_year,
      graduation_year, skills, github_url, linkedin_url, created_at, updated_at)
    VALUES (@id, @fullName, @email, @phone, @passwordHash, @college, @degree, @branch, @academicYear,
      @graduationYear, @skills, @github, @linkedin, @now, @now)`)
    .run({ ...s, id, skills: JSON.stringify(s.skills || []), github: s.github || null, linkedin: s.linkedin || null, now });
  return findById(id);
}

export function updateProfile(id, p) {
  db.prepare(`UPDATE students SET full_name=@fullName, phone=@phone, college=@college, degree=@degree, branch=@branch,
      academic_year=@academicYear, graduation_year=@graduationYear, skills=@skills, github_url=@github,
      linkedin_url=@linkedin, updated_at=@now WHERE id=@id`)
    .run({ ...p, id, skills: JSON.stringify(p.skills || []), github: p.github || null, linkedin: p.linkedin || null, now: new Date().toISOString() });
  return findById(id);
}

export const setPasswordHash = (id, hash) =>
  db.prepare('UPDATE students SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, new Date().toISOString(), id);

// Stage 04B: the application form can fill in or correct these fields. Email, password, graduation year and
// profile links are never touched here. Runs inside the application-insert transaction (see db/applications.js).
export function updateApplicationProfile(id, p) {
  db.prepare(`UPDATE students SET full_name=@fullName, phone=@phone, college=@college, degree=@degree, branch=@branch,
      academic_year=@academicYear, skills=@skills, updated_at=@now WHERE id=@id`)
    .run({
      id, fullName: p.fullName, phone: p.phone, college: p.college, degree: p.degree, branch: p.branch,
      academicYear: p.academicYear, skills: JSON.stringify(p.skills || []), now: new Date().toISOString(),
    });
}

// Stage 07A. The role is changed ONLY from here, and this module is called only by scripts/create-admin.mjs (never by a route).
export const setRole = (id, role) => {
  if (!['student', 'admin'].includes(role)) throw new Error('Invalid role');
  return db.prepare('UPDATE students SET role = ?, updated_at = ? WHERE id = ?').run(role, new Date().toISOString(), id).changes === 1;
};
export const countAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM students WHERE role = 'admin'").get().n;

// ---------- Stage 07B: administrator student management (routes/admin.js via services/studentAdmin.js only) ----------
// Only accounts with role 'student' are ever returned or changed here. Password hashes and tokens are never selected.
const escapeLike = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
const toListRow = (r) => ({
  id: r.id, fullName: r.full_name, email: r.email, college: r.college, degree: r.degree, branch: r.branch, academicYear: r.academic_year,
  registeredAt: r.created_at, accountStatus: r.account_status, applicationCount: r.application_count, isAdmin: r.role === 'admin',
});
export function pageForAdmin({ q = '', status = null, degree = null, academicYear = null, limit, offset }) {
  // Every account is listed (administrator accounts are flagged, and can't be suspended from here), so the list matches who actually signed up.
  const where = ['1 = 1']; const args = [];
  if (status) { where.push('s.account_status = ?'); args.push(status); }
  if (degree) { where.push('s.degree = ?'); args.push(degree); }
  if (academicYear) { where.push('s.academic_year = ?'); args.push(academicYear); }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push("(s.id LIKE ? ESCAPE '\\' OR s.full_name LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\' OR s.college LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM students s ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT s.id, s.full_name, s.email, s.college, s.degree, s.branch, s.academic_year, s.created_at, s.account_status, s.role,
      (SELECT COUNT(*) FROM applications a WHERE a.student_id = s.id) AS application_count
    FROM students s ${w} ORDER BY s.created_at DESC, s.id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(toListRow);
  return { total, rows };
}
export const statusCounts = () => {
  const by = db.prepare("SELECT account_status AS s, COUNT(*) AS n FROM students GROUP BY account_status").all().reduce((a, r) => ({ ...a, [r.s]: r.n }), {});
  return { all: (by.active ?? 0) + (by.suspended ?? 0), active: by.active ?? 0, suspended: by.suspended ?? 0 };
};
export const findStudentForAdmin = (id) => {
  const s = findById(id);
  return s && s.role === 'student' ? s : null;
};
export function detailForAdmin(id) {
  const s = findById(id); // read-only view also works for administrator accounts; changes still go through findStudentForAdmin rules
  if (!s) return null;
  const applications = db.prepare(`SELECT a.id, a.internship_id, a.internship_title, a.status, a.submitted_at, e.id AS enrollment_id
      FROM applications a LEFT JOIN enrollments e ON e.application_id = a.id WHERE a.student_id = ? ORDER BY a.submitted_at DESC, a.id`).all(id)
    .map((r) => ({ id: r.id, internshipId: r.internship_id, internshipTitle: r.internship_title, status: r.status, submittedAt: r.submitted_at, internshipRecordId: r.enrollment_id }));
  const internships = db.prepare(`SELECT e.id, e.application_id, e.status, e.start_date, e.expected_end_date, e.progress_percent, e.completed_at, a.internship_title
      FROM enrollments e JOIN applications a ON a.id = e.application_id WHERE e.student_id = ? ORDER BY e.created_at DESC, e.id`).all(id)
    .map((r) => ({ id: r.id, applicationId: r.application_id, title: r.internship_title, status: r.status, startDate: r.start_date, expectedEndDate: r.expected_end_date, progressPercent: r.progress_percent ?? null, completedAt: r.completed_at }));
  const documents = db.prepare('SELECT id, type, status, title, document_number, issued_at FROM documents WHERE student_id = ? ORDER BY issued_at DESC, id').all(id)
    .map((r) => ({ id: r.id, type: r.type, status: r.status, title: r.title, number: r.document_number, issuedAt: r.issued_at }));
  const history = db.prepare('SELECT id, from_status, to_status, reason, changed_by_name, changed_at FROM student_account_history WHERE student_id = ? ORDER BY id').all(id)
    .map((h) => ({ id: h.id, from: h.from_status, to: h.to_status, reason: h.reason, changedBy: h.changed_by_name, changedAt: h.changed_at }));
  return {
    student: { id: s.id, fullName: s.fullName, email: s.email, phone: s.phone, college: s.college, degree: s.degree, branch: s.branch, academicYear: s.academicYear,
      graduationYear: s.graduationYear, skills: s.skills, github: s.github || null, linkedin: s.linkedin || null, registeredAt: s.createdAt, accountStatus: s.accountStatus, isAdmin: s.role === 'admin' },
    applications, internships, documents, accountHistory: history,
  };
}
// Validated by the caller. The status check and the write happen in one transaction; sessions are revoked on suspension so it takes effect at once.
export function setAccountStatus(id, status, { admin, reason = null }) {
  return db.transaction(() => {
    const cur = db.prepare("SELECT account_status FROM students WHERE id = ? AND role = 'student'").get(id);
    if (!cur) return null;
    if (cur.account_status === status) return { changed: false };
    const now = new Date().toISOString();
    db.prepare("UPDATE students SET account_status = ?, updated_at = ? WHERE id = ? AND role = 'student'").run(status, now, id);
    db.prepare('INSERT INTO student_account_history (student_id, from_status, to_status, reason, changed_by, changed_by_name, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, cur.account_status, status, reason, admin?.id ?? null, admin?.fullName ?? 'Administrator', now);
    if (status === 'suspended') db.prepare('DELETE FROM sessions WHERE student_id = ?').run(id);
    notify({ studentId: id, type: 'account_status', title: status === 'suspended' ? 'Account suspended' : 'Account reactivated',
      message: status === 'suspended' ? `Your ELVORA account was suspended.${reason ? ` Reason: ${reason}` : ''} Contact ELVORA support if you have questions.` : 'Your ELVORA account is active again.' });
    audit({ admin, action: status === 'suspended' ? 'student.suspend' : 'student.reactivate', targetType: 'student', targetId: id, reason });
    return { changed: true };
  })();
}
