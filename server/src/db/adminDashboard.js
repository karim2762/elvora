import { db } from './index.js';

// Stage 07A — read-only aggregation for the administrator overview. Every number is a COUNT over real rows; nothing is cached or invented.
// Administrator accounts (students.role = 'admin') are never counted as students.
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const grouped = (sql) => db.prepare(sql).all().reduce((acc, r) => ({ ...acc, [r.k]: r.n }), {});

export function statistics() {
  const apps = grouped('SELECT status AS k, COUNT(*) AS n FROM applications GROUP BY status');
  const enr = grouped('SELECT status AS k, COUNT(*) AS n FROM enrollments GROUP BY status');
  const docs = grouped("SELECT type AS k, COUNT(*) AS n FROM documents WHERE status = 'Issued' GROUP BY type");
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return {
    totalStudents: count("SELECT COUNT(*) AS n FROM students WHERE role = 'student'"),
    totalApplications: sum(apps),
    pendingApplications: (apps.Submitted ?? 0) + (apps['Under Review'] ?? 0),
    approvedApplications: apps.Approved ?? 0,
    activeInternships: enr.Active ?? 0,
    completedInternships: enr.Completed ?? 0,
    internshipRecords: sum(enr),
    documentsIssued: sum(docs),
    breakdown: { applications: apps, internshipRecords: enr, documents: docs },
  };
}

// Newest real events across the platform. Each branch reads a timestamp that is already stored; no row is created for display.
export function recentActivity(limit = 10) {
  return db.prepare(`
    SELECT * FROM (
      SELECT 'student_registered' AS kind, s.created_at AS at, s.full_name AS who, s.email AS ref, NULL AS detail, NULL AS title
        FROM students s WHERE s.role = 'student'
      UNION ALL
      SELECT CASE WHEN h.status = 'Submitted' THEN 'application_submitted' ELSE 'application_status' END, h.changed_at, a.full_name, a.id, h.status, a.internship_title
        FROM application_status_history h JOIN applications a ON a.id = h.application_id
      UNION ALL
      SELECT 'internship_created', e.created_at, a.full_name, e.id, NULL, a.internship_title FROM enrollments e JOIN applications a ON a.id = e.application_id
      UNION ALL
      SELECT 'internship_activated', e.activated_at, a.full_name, e.id, NULL, a.internship_title FROM enrollments e JOIN applications a ON a.id = e.application_id WHERE e.activated_at IS NOT NULL
      UNION ALL
      SELECT 'internship_completed', e.completed_at, a.full_name, e.id, NULL, a.internship_title FROM enrollments e JOIN applications a ON a.id = e.application_id WHERE e.completed_at IS NOT NULL
      UNION ALL
      SELECT CASE WHEN d.type = 'certificate' THEN 'certificate_issued' ELSE 'offer_letter_issued' END, d.issued_at, s.full_name, COALESCE(d.document_number, d.id), NULL, d.title
        FROM documents d JOIN students s ON s.id = d.student_id WHERE d.status = 'Issued' AND d.issued_at IS NOT NULL
    ) ORDER BY at DESC, ref LIMIT ?`).all(limit);
}
