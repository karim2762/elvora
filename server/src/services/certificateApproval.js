import { HttpError, notFound } from '../utils/errors.js';
import * as enrollments from '../db/enrollments.js';
import * as docs from '../db/documents.js';

// Administrator's per-intern decision: may this intern receive a completion certificate?
//   Pending   nobody has decided (default). No certificate is generated.
//   Approved  the certificate is generated automatically as soon as the internship is Completed (see automation/worker.js).
//   Declined  no certificate. The administrator can change their mind later.
// A decision can be given while the internship is Active, Suspended or Completed, never for Awaiting Start or Cancelled.
// Once a certificate has been issued the decision is locked: withdraw the certificate (revoke) instead of un-approving it.
const conflict = (message, code) => new HttpError(409, message, { code });

export function decideCertificate(enrollmentId, { decision, note, decidedBy }) {
  const e = enrollments.findById(enrollmentId);
  if (!e) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  if (e.applicationStatus !== 'Approved') throw conflict('The application is no longer approved.', 'APPLICATION_NOT_APPROVED');
  if (!['Active', 'Suspended', 'Completed'].includes(e.status)) {
    throw conflict(`A certificate decision can’t be recorded while the internship is “${e.status}”.`, 'INVALID_STATE');
  }
  const live = docs.findByEnrollmentAndType(e.id, 'certificate');
  if (live?.status === 'Issued') throw conflict('A certificate has already been issued. Revoke it first if it must be withdrawn.', 'CERTIFICATE_ALREADY_ISSUED');
  if (decision === 'Declined' && !note) throw new HttpError(400, 'Please add a short reason when declining.', { code: 'VALIDATION', fields: { note: 'A reason is required when declining' } });
  const notice = {
    Approved: { type: 'certificate_approved', title: 'Certificate approved', message: e.status === 'Completed'
      ? 'Your certificate for {title} has been approved and is being generated. It will appear in Documents shortly.'
      : 'Your certificate for {title} has been approved. It will be issued automatically when your internship is completed.' },
    Declined: { type: 'certificate_declined', title: 'Certificate not approved', message: 'A certificate will not be issued for {title} at this time. Contact ELVORA if you have questions.' },
    Pending: null,
  }[decision];
  return enrollments.setCertificateDecision(e.id, { decision, note, decidedBy }, notice);
}
