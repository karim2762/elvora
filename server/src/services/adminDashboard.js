import * as Pay from '../db/payments.js';
import { can } from './payments.js';
import * as repo from '../db/adminDashboard.js';
import { catalogSize } from '../internships/catalog.js';

// Where each event type can be opened. Only pages that exist today are linked: the Stage 05B console at /admin.
// Student records have no page yet (Stage 07B), so that event has no action.
const CONSOLE = '/admin';
const DESCRIBE = {
  student_registered: (r) => ({ text: `New student registered: ${r.who}`, link: null }),
  application_submitted: (r) => ({ text: `${r.who} applied for ${r.title}`, link: CONSOLE }),
  application_status: (r) => ({ text: `Application for ${r.title} (${r.who}) marked ${r.detail}`, link: CONSOLE }),
  internship_created: (r) => ({ text: `Internship set up for ${r.who}: ${r.title}`, link: CONSOLE }),
  internship_activated: (r) => ({ text: `Internship activated: ${r.title} (${r.who})`, link: CONSOLE }),
  internship_completed: (r) => ({ text: `Internship completed: ${r.title} (${r.who})`, link: CONSOLE }),
  offer_letter_issued: (r) => ({ text: `Offer letter issued to ${r.who}`, link: CONSOLE }),
  certificate_issued: (r) => ({ text: `Certificate issued to ${r.who}`, link: CONSOLE }),
};

// The administrator comes from the authenticated session (req.admin), never from the request body or query.
export function buildAdminDashboard(admin) {
  const stats = repo.statistics();
  const { breakdown, ...numbers } = stats;
  return {
    admin: { fullName: admin.fullName, email: admin.email },
    stats: { ...numbers, totalInternships: catalogSize() },
    breakdown,
    ...(can(admin, 'payment.review') ? { payments: { pendingVerification: Pay.queueCounts().pending, overdue: Pay.overdueCount(), openRefunds: (Pay.refundCounts().REFUND_REQUESTED ?? 0) + (Pay.refundCounts().REFUND_PENDING ?? 0) } } : {}),
    recentActivity: repo.recentActivity(10).map((r) => {
      const d = DESCRIBE[r.kind]?.(r) ?? { text: r.kind, link: null };
      return { type: r.kind, description: d.text, at: r.at, reference: r.ref, link: d.link };
    }),
    generatedAt: new Date().toISOString(),
  };
}
