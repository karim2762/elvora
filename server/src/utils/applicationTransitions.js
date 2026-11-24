// Stage 07B — the only status changes an administrator may make. Enforced on the server inside the database transaction.
// A change to the SAME status is not a transition; the route treats it as a harmless no-op (nothing is written or sent).
export const TRANSITIONS = {
  Submitted: ['Under Review', 'Approved', 'Rejected', 'Cancelled'],
  'Under Review': ['Approved', 'Rejected', 'Cancelled'],
  Approved: ['Under Review', 'Rejected', 'Cancelled'],
  Rejected: ['Under Review'], // a rejection can be reopened for another look
  Cancelled: [], // terminal: a cancelled application can't be revived (the student can apply again if the internship is open)
};
export const allowedNext = (from) => TRANSITIONS[from] ?? [];
export const canTransition = (from, to) => allowedNext(from).includes(to);
