import { HttpError, notFound } from '../utils/errors.js';
import * as enrollments from '../db/enrollments.js';
import * as docs from '../db/documents.js';
import * as students from '../db/students.js';
import { DOCUMENT_TYPES } from './constants.js';
import { checkEligibility } from './eligibility.js';
import { buildDocumentData, SAMPLE, STRESS } from './data.js';
import { getOrganization, missingForIssuance } from './organization.js';
import { renderHtml } from './renderers/index.js';
import { taskGate } from '../services/completionEligibility.js';
import { listTemplates } from './templates/registry.js';

// Administrator-facing entry points of the document system (Stage 06A: eligibility + preview only; nothing is issued here).
const assertType = (type) => { if (!DOCUMENT_TYPES.includes(type)) throw notFound('Unknown document type', 'INVALID_TYPE'); };

export function previewSample(type, { stress = false } = {}) {
  assertType(type);
  const s = stress ? STRESS : SAMPLE;
  return renderHtml(buildDocumentData(type, { enrollment: s.enrollment, student: s.student, preview: 'sample' }));
}

// Eligibility report for one internship: rules + configuration needed to issue for real.
export function eligibility(enrollmentId, type) {
  assertType(type);
  const enrollment = enrollments.findById(enrollmentId);
  if (!enrollment) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  const verdict = checkEligibility({ type, enrollment, existing: docs.findByEnrollmentAndType(enrollment.id, type), strict: true, taskGate: type === 'certificate' ? taskGate(enrollment) : null });
  const approval = type === 'certificate' ? { decision: enrollment.certificateReview.decision, needed: true } : null;
  const missingConfig = missingForIssuance(getOrganization());
  return { type, ...verdict, approval, organizationReady: missingConfig.length === 0, missingConfiguration: missingConfig, enrollment };
}

// Draft preview of a real internship. Refused unless the record is eligible (a certificate draft would otherwise claim completion).
export function previewForEnrollment(enrollmentId, type) {
  const report = eligibility(enrollmentId, type);
  if (!report.eligible && report.code !== 'DOCUMENT_EXISTS') throw new HttpError(409, report.message, { code: report.code });
  const student = students.findById(report.enrollment.studentId);
  if (!student) throw notFound('Student not found', 'STUDENT_NOT_FOUND');
  return renderHtml(buildDocumentData(type, { enrollment: report.enrollment, student, preview: 'draft' }));
}

export const templateSummary = () => listTemplates();
