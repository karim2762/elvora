import { Send, Hourglass, CheckCircle2, XCircle, Ban } from 'lucide-react';

// The five statuses mirror server/src/utils/validation.js (APPLICATION_STATUSES). Only administrators can change them.
// `tone` maps to .status--<tone> in applications.css. Each status is also shown as text, never by colour alone.
export const APPLICATION_STATUS = {
  Submitted: { label: 'Submitted', tone: 'blue', icon: Send, help: 'We have your application. It is waiting to be picked up for review.' },
  'Under Review': { label: 'Under Review', tone: 'amber', icon: Hourglass, help: 'The ELVORA team is reviewing your application.' },
  Approved: { label: 'Approved', tone: 'teal', icon: CheckCircle2, help: 'Congratulations! Your application has been approved.' },
  Rejected: { label: 'Rejected', tone: 'red', icon: XCircle, help: 'Your application was not selected this time. You can explore other internships.' },
  Cancelled: { label: 'Cancelled', tone: 'slate', icon: Ban, help: 'This application was cancelled by ELVORA.' },
};
export const statusMeta = (s) => APPLICATION_STATUS[s] ?? { label: s, tone: 'slate', icon: Send, help: '' };
