import { LayoutDashboard, UserRound, ClipboardList, Briefcase, FileText, Bell, Settings, ListChecks } from 'lucide-react';

// Sidebar structure. My Applications and My Internship live inside the dashboard as of Stage 05B; My Profile still
// moved into the dashboard in Stage 05C (the old /profile URL redirects here).
export const studentBase = '/student';
export const studentRoutes = {
  overview: `${studentBase}/dashboard`,
  profile: `${studentBase}/profile`,
  applications: `${studentBase}/applications`,
  internship: `${studentBase}/internship`,
  tasks: `${studentBase}/tasks`,
  documents: `${studentBase}/documents`,
  notifications: `${studentBase}/notifications`,
  settings: `${studentBase}/settings`,
};
export const studentNav = [
  { label: 'Overview', to: studentRoutes.overview, icon: LayoutDashboard },
  { label: 'My Profile', to: studentRoutes.profile, icon: UserRound },
  { label: 'My Applications', to: studentRoutes.applications, icon: ClipboardList },
  { label: 'My Internship', to: studentRoutes.internship, icon: Briefcase },
  { label: 'My Tasks', to: studentRoutes.tasks, icon: ListChecks },
  { label: 'Documents', to: studentRoutes.documents, icon: FileText },
  { label: 'Notifications', to: studentRoutes.notifications, icon: Bell },
  { label: 'Settings', to: studentRoutes.settings, icon: Settings },
];
