import { Bell, ClipboardCheck, ClipboardList, XCircle, Briefcase, PlayCircle, Flag, FileText, Award, Megaphone, Github, AlertTriangle, Send } from 'lucide-react';
import { studentRoutes } from '../config/dashboard';

// How each backend notification type is shown and where its action leads. Only the types the backend writes are listed.
const META = {
  application_submitted: { icon: ClipboardList, tone: 'blue', label: 'Application' },
  application_status: { icon: ClipboardList, tone: 'blue', label: 'Application' },
  application_approved: { icon: ClipboardCheck, tone: 'teal', label: 'Application' },
  application_rejected: { icon: XCircle, tone: 'muted', label: 'Application' },
  internship_activated: { icon: PlayCircle, tone: 'teal', label: 'Internship' },
  internship_progress: { icon: Briefcase, tone: 'blue', label: 'Internship' },
  internship_completed: { icon: Flag, tone: 'teal', label: 'Internship' },
  offer_letter_issued: { icon: FileText, tone: 'blue', label: 'Document' },
  certificate_issued: { icon: Award, tone: 'teal', label: 'Document' },
  document_revoked: { icon: FileText, tone: 'muted', label: 'Document' },
  announcement: { icon: Megaphone, tone: 'blue', label: 'Announcement' },
  tasks_assigned: { icon: ClipboardList, tone: 'blue', label: 'Task' },
  github_connected: { icon: Github, tone: 'teal', label: 'GitHub' },
  github_repo_created: { icon: Github, tone: 'teal', label: 'GitHub' },
  github_repo_failed: { icon: AlertTriangle, tone: 'muted', label: 'GitHub' },
  github_repo_linked: { icon: Github, tone: 'blue', label: 'GitHub' },
  github_verification_failed: { icon: AlertTriangle, tone: 'muted', label: 'GitHub' },
  github_verification_pending: { icon: Github, tone: 'blue', label: 'GitHub' },
  project_submitted: { icon: Send, tone: 'blue', label: 'Project' },
  submission_verified: { icon: ClipboardCheck, tone: 'teal', label: 'Project' },
  task_approved: { icon: ClipboardCheck, tone: 'teal', label: 'Task' },
  task_changes_requested: { icon: ClipboardList, tone: 'blue', label: 'Task' },
  task_rejected: { icon: XCircle, tone: 'muted', label: 'Task' },
};
export const notificationMeta = (type) => META[type] ?? { icon: Bell, tone: 'blue', label: 'Update' };

// Relevant navigation action for a notification, or null when there is nowhere useful to go.
export function notificationAction(n) {
  if (n.type.endsWith('_issued') && n.documentId) return { label: 'View documents', to: studentRoutes.documents };
  if (n.studentTaskId) return { label: 'Open task', to: `${studentRoutes.tasks}/${encodeURIComponent(n.studentTaskId)}` };
  if (n.enrollmentId) return { label: 'View internship', to: `${studentRoutes.internship}?id=${encodeURIComponent(n.enrollmentId)}` };
  if (n.applicationId) return { label: 'View application', to: `${studentRoutes.applications}/${encodeURIComponent(n.applicationId)}` };
  return null;
}

// Tells the header bell to refresh its unread count.
export const NOTIFICATIONS_CHANGED = 'elvora:notifications-changed';
export const announceNotificationsChanged = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
