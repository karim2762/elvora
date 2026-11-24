import * as applications from '../db/applications.js';
import * as enrollments from '../db/enrollments.js';

const RECENT_LIMIT = 5;

// Everything here is derived from the signed-in student's own rows (studentId comes from the session, never the request).
// Internships (Stage 05B): counted from the student's own enrollment records (approved applications only).
export function buildDashboard(student) {
  const byStatus = applications.countByStatus(student.id);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const internships = enrollments.countByStatusForStudent(student.id);
  return {
    student: { fullName: student.fullName },
    stats: {
      totalApplications: total,
      approvedApplications: byStatus.Approved ?? 0,
      activeInternships: internships.Active ?? 0,
      completedInternships: internships.Completed ?? 0,
      internshipsTracked: true,
    },
    recentApplications: applications.listRecentForStudent(student.id, RECENT_LIMIT).map((a) => ({
      id: a.id,
      internship: { id: a.internship.id, title: a.internship.title, category: a.internship.category, durationDays: a.internship.durationDays },
      status: a.status,
      submittedAt: a.submittedAt,
    })),
  };
}
