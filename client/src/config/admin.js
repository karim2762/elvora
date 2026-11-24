import { priorityNavItem, priorityPricingNavItem, paymentVerificationNavItem } from '../components/admin/priorityNav';
import { LayoutDashboard, Briefcase, ClipboardList, Users, FileText, Bell, ScrollText, Settings, LibraryBig, ClipboardCheck, BadgeCheck } from 'lucide-react';

// Administrator console structure (Stage 07A). Overview, Internships, Applications and Students are built (07A/07B); the other sections are placeholders until later stages,
// and say so on the page. `legacy` points at the part of the existing admin console (/admin) that already does that job.
export const adminBase = '/admin';
export const adminRoutes = {
  login: `${adminBase}/login`,
  overview: `${adminBase}/dashboard`,
  internships: `${adminBase}/internships`,
  applications: `${adminBase}/applications`,
  taskLibrary: `${adminBase}/task-library`,
  projects: `${adminBase}/projects`,
  students: `${adminBase}/students`,
  documents: `${adminBase}/documents`,
  notifications: `${adminBase}/notifications`,
  audit: `${adminBase}/audit-logs`,
  settings: `${adminBase}/settings`,
  console: adminBase, // the existing key/session admin console
};
export const adminNav = [
  { label: 'Overview', to: adminRoutes.overview, icon: LayoutDashboard },
  { label: 'Internships', to: adminRoutes.internships, icon: Briefcase },
  { label: 'Applications', to: adminRoutes.applications, icon: ClipboardList },
  { label: 'Task Library', to: adminRoutes.taskLibrary, icon: LibraryBig },
  { label: 'Project Reviews', to: adminRoutes.projects, icon: ClipboardCheck },
  { label: 'Students', to: adminRoutes.students, icon: Users },
  { label: 'Documents', to: adminRoutes.documents, icon: FileText },
  priorityNavItem(BadgeCheck),
  paymentVerificationNavItem(BadgeCheck),
  priorityPricingNavItem(BadgeCheck), // admin-only entry; its path lives with the admin components, not in public/layout configuration
  { label: 'Notifications', to: adminRoutes.notifications, icon: Bell },
  { label: 'Audit Logs', to: adminRoutes.audit, icon: ScrollText },
  { label: 'Settings', to: adminRoutes.settings, icon: Settings },
];
// All sections are built (Stage 07C). Kept as an empty map so unknown /admin/:section paths fall back to the Overview.
export const adminSections = {};
