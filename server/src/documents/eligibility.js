import { DOCUMENT_TYPES } from './constants.js';

// The single definition of "may this document be issued?". Pure: it only looks at the records it is given, so the same
// rules serve the existing PDF upload route (Stage 05C) and the generator (Stage 06B). Students never reach this code:
// every caller is behind the administrator key.
//
//   offer_letter  needs an application that an administrator has set to Approved, an internship record that is not Cancelled.
//   certificate   needs the same approved application AND an internship the backend has moved to Completed by an
//                 administrator (status 'Completed' with a completed_at stamp). Nothing else counts as completion.
//
// strict:true is for generated documents, which print dates; the upload route keeps strict:false so existing behaviour holds.
// requireApproval:true (generated certificates) additionally needs the administrator's per-intern certificate approval.
// taskGate (Stage 09A, certificates only) is { blocking, message } from services/completionEligibility.js: when the student was given required tasks that
// are not all approved, a certificate can't be issued even if the internship record says Completed.
export function checkEligibility({ type, enrollment, existing = null, strict = false, requireApproval = false, taskGate = null }) {
  const no = (code, message) => ({ eligible: false, code, message });
  if (!DOCUMENT_TYPES.includes(type)) return no('INVALID_TYPE', 'Unknown document type.');
  if (!enrollment) return no('ENROLLMENT_NOT_FOUND', 'Internship not found.');
  if (enrollment.applicationStatus !== 'Approved') return no('APPLICATION_NOT_APPROVED', 'The application is not approved.');
  if (existing && existing.status !== 'Revoked') return no('DOCUMENT_EXISTS', 'This document has already been issued for this internship.');
  if (type === 'offer_letter') {
    if (enrollment.status === 'Cancelled') return no('ENROLLMENT_CLOSED', 'An offer letter can’t be issued for a cancelled internship.');
    if (strict && (!enrollment.startDate || !enrollment.expectedEndDate)) return no('ENROLLMENT_DATES_MISSING', 'Set the internship start and expected end dates before issuing an offer letter.');
  } else {
    if (enrollment.status !== 'Completed' || !enrollment.completedAt) return no('ENROLLMENT_NOT_COMPLETED', 'A certificate can only be issued for a completed internship.');
    if (taskGate?.blocking) return no('TASKS_INCOMPLETE', `The required internship tasks are not all approved. ${taskGate.message ?? ''}`.trim());
    if (requireApproval && enrollment.certificateReview?.decision !== 'Approved') {
      return no('CERTIFICATE_NOT_APPROVED', enrollment.certificateReview?.decision === 'Declined'
        ? 'An administrator declined a certificate for this intern. Approve it in Certificate approvals first.'
        : 'An administrator must approve a certificate for this intern first (Certificate approvals).');
    }
    if (strict) {
      if (!enrollment.startDate) return no('ENROLLMENT_DATES_MISSING', 'The internship has no start date, so a certificate can’t state one.');
      if (enrollment.completedAt.slice(0, 10) < enrollment.startDate) return no('COMPLETION_BEFORE_START', 'The completion date is earlier than the start date. Correct the internship record first.');
    }
  }
  return { eligible: true, code: 'ELIGIBLE', message: 'Eligible.' };
}
