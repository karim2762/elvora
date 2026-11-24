// Builds the 7-step internship progress timeline from backend records only.
// Inputs: the application (status), its status dates (application_status_history) and the enrollment (or null).
// Rules: a milestone is "completed" only when a record proves it; the future is never marked completed; "Certificate
// Issued" is completed only when an official certificate record exists (otherwise it stays pending, with no date).
//
// state: 'completed' | 'current' | 'pending' | 'stopped'   ('stopped' = the process ended here: rejected/cancelled/…)
export const MILESTONES = [
  ['submitted', 'Application Submitted'],
  ['under_review', 'Under Review'],
  ['approved', 'Approved'],
  ['activated', 'Internship Activated'],
  ['in_progress', 'In Progress'],
  ['completed', 'Completed'],
  ['certificate', 'Certificate Issued'],
];

export function buildTimeline({ application, dates, enrollment }) {
  const appStatus = application.status;
  const e = enrollment ?? null;
  const m = Object.fromEntries(MILESTONES.map(([key, label]) => [key, { key, label, state: 'pending', date: null, note: null }]));

  // 1. Submitted: every application has been submitted.
  Object.assign(m.submitted, { state: 'completed', date: application.submittedAt });

  // 2–3. Review and decision.
  const reviewed = Boolean(dates['Under Review']) || ['Approved', 'Rejected'].includes(appStatus);
  if (appStatus === 'Submitted') {
    Object.assign(m.under_review, { state: 'current', note: 'Waiting for the team to pick up your application.' });
  } else if (appStatus === 'Under Review') {
    Object.assign(m.under_review, { state: 'current', date: dates['Under Review'] ?? null, note: 'The team is reviewing your application.' });
  } else if (reviewed) {
    Object.assign(m.under_review, { state: 'completed', date: dates['Under Review'] ?? null });
  }
  if (appStatus === 'Approved') Object.assign(m.approved, { state: 'completed', date: dates.Approved ?? null });
  if (appStatus === 'Rejected') Object.assign(m.approved, { state: 'stopped', date: dates.Rejected ?? null, note: 'Your application was not selected.' });
  if (appStatus === 'Cancelled') {
    // The process ended wherever it had got to; show it on the next unreached step.
    const where = m.under_review.state === 'completed' ? m.approved : m.under_review;
    Object.assign(where, { state: 'stopped', date: dates.Cancelled ?? null, note: 'This application was cancelled.' });
  }

  // 4–6. Internship progress (only for an approved application that has an enrollment record).
  if (appStatus === 'Approved') {
    if (!e) {
      Object.assign(m.activated, { state: 'current', note: 'Waiting for ELVORA to set up your internship.' });
    } else {
      const activated = Boolean(e.activatedAt);
      if (activated) Object.assign(m.activated, { state: 'completed', date: e.activatedAt });

      if (e.status === 'Awaiting Start') {
        Object.assign(m.activated, { state: 'current', note: e.startDate ? 'Your internship is set up and waiting to start.' : 'Your internship is set up. A start date will be shared.' });
      } else if (e.status === 'Active') {
        Object.assign(m.in_progress, { state: 'current', date: e.startDate ?? e.activatedAt });
      } else if (e.status === 'Suspended') {
        Object.assign(m.in_progress, { state: 'current', date: e.startDate ?? e.activatedAt, note: 'Your internship is currently suspended.' });
      } else if (e.status === 'Completed') {
        Object.assign(m.in_progress, { state: 'completed', date: e.startDate ?? e.activatedAt });
        Object.assign(m.completed, { state: 'completed', date: e.completedAt });
      } else if (e.status === 'Cancelled') {
        const where = activated ? m.in_progress : m.activated;
        if (activated) Object.assign(m.in_progress, { date: e.startDate ?? e.activatedAt });
        Object.assign(where, { state: 'stopped', date: e.cancelledAt, note: 'This internship was cancelled.' });
      }
      if (e.certificate) Object.assign(m.certificate, { state: 'completed', date: e.certificate.issuedAt });
    }
  }
  return MILESTONES.map(([key]) => m[key]);
}
