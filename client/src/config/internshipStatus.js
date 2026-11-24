import { Clock, PlayCircle, Award, PauseCircle, Ban } from 'lucide-react';

// The five internship states mirror server/src/utils/validation.js (ENROLLMENT_STATUSES).
// Only administrators can change them. `tone` maps to .status--<tone> in applications.css / tracking.css.
export const INTERNSHIP_STATUS = {
  'Awaiting Start': { label: 'Awaiting Start', tone: 'blue', icon: Clock, help: 'Your internship is set up. It will become active when ELVORA starts it.' },
  Active: { label: 'Active', tone: 'teal', icon: PlayCircle, help: 'Your internship is in progress.' },
  Completed: { label: 'Completed', tone: 'indigo', icon: Award, help: 'You have completed this internship. Well done!' },
  Suspended: { label: 'Suspended', tone: 'amber', icon: PauseCircle, help: 'Your internship is on hold. Contact the ELVORA team if you have questions.' },
  Cancelled: { label: 'Cancelled', tone: 'slate', icon: Ban, help: 'This internship was cancelled by ELVORA.' },
};
export const internshipStatusMeta = (s) => INTERNSHIP_STATUS[s] ?? { label: s, tone: 'slate', icon: Clock, help: '' };

// Application filter tabs (the five application statuses plus "All").
export const APPLICATION_FILTERS = ['All', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Cancelled'];
