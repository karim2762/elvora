import crypto from 'node:crypto';
import { HttpError, notFound } from '../utils/errors.js';
import * as enrollments from '../db/enrollments.js';
import * as applications from '../db/applications.js';
import * as students from '../db/students.js';
import * as docs from '../db/documents.js';
import * as storage from './storage.js';
import { DOCUMENT_TYPES, DEFAULT_TITLES, TEMPLATE_VERSIONS } from './constants.js';
import { checkEligibility } from './eligibility.js';
import { buildDocumentData } from './data.js';
import { getOrganization, missingForIssuance } from './organization.js';
import { renderPdf } from './renderers/index.js';
import { NUMBER_PLACEHOLDER } from './numbering.js';
import { VERIFICATION_PLACEHOLDER } from './verification.js';
import { config } from '../config/index.js';
import { record as audit } from '../db/audit.js';
import { taskGate } from '../services/completionEligibility.js';

// Document issuance (Stage 06B). Called only from administrator routes. Everything printed comes from backend records
// (enrollment, application, student) looked up here by internship ID; nothing about the student is ever read from the request.
const conflict = (message, code, details) => new HttpError(409, message, { code, details });
const actorKeyFingerprint = () => crypto.createHash('sha256').update(config.adminApiKey).digest('hex').slice(0, 8);

// The minimum that must stay true about a document after issuance (public verification and audits use it).
// Kept in the private database only; nothing here is public.
export const snapshotOf = (enrollment, student) => ({
  student: { fullName: student.fullName, email: student.email },
  internship: { title: enrollment.internship.title, category: enrollment.internship.category, durationDays: enrollment.internship.durationDays },
  dates: { start: enrollment.startDate, expectedEnd: enrollment.expectedEndDate, completedAt: enrollment.completedAt },
});

// Trusted loading: the internship, its application and the student must all belong together.
export function loadTrusted(enrollmentId) {
  const enrollment = enrollments.findById(enrollmentId);
  if (!enrollment) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  const student = students.findById(enrollment.studentId);
  if (!student) throw conflict('The student record for this internship no longer exists.', 'STUDENT_NOT_FOUND');
  const owner = applications.ownerOf(enrollment.applicationId);
  if (owner !== student.id) throw conflict('The internship, application and student records do not match.', 'RECORD_MISMATCH');
  return { enrollment, student };
}

// A refused or failed issuance attempt is audited too (result 'failure', reason = the error code). The success row is written by
// docs.finalizeIssued inside the same transaction as the Issued status, so a document can never be issued without its audit row.
export async function issueGenerated(args) {
  try { return await issueGeneratedInner(args); } catch (err) {
    failureAudit({ admin: args.admin, action: args.type === 'certificate' ? 'certificate.issue' : 'offer_letter.issue', targetType: 'internship', targetId: args.enrollmentId, err });
    throw err;
  }
}
function failureAudit({ admin, action, targetType, targetId, err }) {
  try { audit({ admin, action, targetType, targetId, result: 'failure', reason: err?.code ?? 'ERROR' }); } catch (e) { console.error('[audit] could not record a failed attempt:', e.message); }
}

async function issueGeneratedInner({ type, enrollmentId, issuedBy, admin = null }) {
  if (!DOCUMENT_TYPES.includes(type)) throw notFound('Unknown document type', 'INVALID_TYPE');
  const actor = issuedBy || 'Administrator', actorKey = actorKeyFingerprint();
  const { enrollment, student } = loadTrusted(enrollmentId);

  const live = docs.findByEnrollmentAndType(enrollment.id, type); // Draft or Issued (never Revoked)
  const verdict = checkEligibility({ type, enrollment, existing: live?.status === 'Issued' ? live : null, strict: true, requireApproval: true, taskGate: type === 'certificate' ? taskGate(enrollment) : null });
  if (!verdict.eligible) throw conflict(verdict.message, verdict.code);

  const organization = getOrganization();
  const missing = missingForIssuance(organization);
  if (missing.length) throw conflict(`Organization details are incomplete. Open Admin → Settings and fill in: ${missing.map((m) => ({ ORG_ADDRESS: 'official address', ORG_EMAIL: 'contact email', ORG_SIGNATORY_NAME: 'signatory name', ORG_SIGNATORY_TITLE: 'signatory title' }[m] ?? m)).join(', ')}.`, 'ORGANIZATION_INCOMPLETE', { missing });

  // Dry run BEFORE a number is allocated: unprintable characters or text that cannot fit are rejected without consuming a number.
  const trial = buildDocumentData(type, { enrollment, student, organization,
    document: { documentNumber: NUMBER_PLACEHOLDER(type).replace('YYYY', '0000').replace('######', '000000'), verificationCode: 'ELV-VER-AAAA-AAAA-AAAA', issuedAt: new Date().toISOString() } });
  await renderPdf(trial);

  // Draft holds the number and verification code. A retry after a failure re-uses the same draft (no gaps, no duplicates).
  const draft = live ?? docs.createDraft({ enrollment, type, title: DEFAULT_TITLES[type], templateVersion: TEMPLATE_VERSIONS[type], snapshot: snapshotOf(enrollment, student), actor, actorKey });
  if (live) docs.refreshSnapshot(draft.id, snapshotOf(enrollment, student));

  const issuedAt = new Date().toISOString();
  let pdf;
  try {
    pdf = await renderPdf(buildDocumentData(type, { enrollment, student, organization, document: { ...draft, issuedAt } }));
  } catch (err) {
    docs.addEvent(draft.id, 'issue_failed', { actor, actorKey, detail: String(err.code ?? 'RENDER_ERROR') });
    throw err;
  }
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-' || pdf.length > config.maxDocumentBytes) {
    docs.addEvent(draft.id, 'issue_failed', { actor, actorKey, detail: 'BAD_OUTPUT' });
    throw new HttpError(500, 'The generated PDF was not valid.', { code: 'PDF_INVALID' });
  }

  const storageKey = storage.newKey();
  storage.put(storageKey, pdf);
  try {
    return docs.finalizeIssued({
      id: draft.id, enrollment, storageKey, issuedAt, actor, actorKey, admin, sizeBytes: pdf.length,
      fileName: `${type === 'certificate' ? 'ELVORA-Certificate' : 'ELVORA-Offer-Letter'}-${enrollment.id}.pdf`,
      sha256: crypto.createHash('sha256').update(pdf).digest('hex'),
    });
  } catch (err) {
    storage.remove(storageKey); // no orphan file when the record could not be saved or another request won the race
    if (err instanceof docs.DocumentStateError) throw conflict('This document has already been issued for this internship.', 'DOCUMENT_EXISTS');
    throw err;
  }
}

export function revokeDocument(id, { reason, revokedBy }, admin = null) {
  try { return revokeInner(id, { reason, revokedBy }, admin); } catch (err) {
    if (err instanceof HttpError && err.status === 409) failureAudit({ admin, action: 'document.revoke', targetType: 'document', targetId: id, err });
    throw err;
  }
}
function revokeInner(id, { reason, revokedBy }, admin) {
  const d = docs.findAny(id);
  if (!d) throw notFound('Document not found', 'DOCUMENT_NOT_FOUND');
  if (d.status === 'Revoked') throw conflict('This document is already revoked.', 'ALREADY_REVOKED');
  if (d.status !== 'Issued') throw conflict('Only an issued document can be revoked.', 'NOT_ISSUED');
  try {
    return docs.revoke({ id, reason, actor: revokedBy || 'Administrator', actorKey: actorKeyFingerprint(), admin });
  } catch (err) {
    if (err instanceof docs.DocumentStateError) throw conflict('This document is already revoked.', 'ALREADY_REVOKED');
    throw err;
  }
}

// What an administrator sees. Never the storage key.
export const toAdminDocument = (d, { events = false } = {}) => ({
  id: d.id, type: d.type, status: d.status, title: d.title, documentNumber: d.documentNumber, verificationCode: d.verificationCode,
  templateVersion: d.templateVersion, enrollmentId: d.enrollmentId, applicationId: d.applicationId, internshipId: d.internshipId, studentId: d.studentId,
  studentName: d.snapshot?.student?.fullName ?? d.studentName ?? null, internshipTitle: d.internship.title,
  createdAt: d.createdAt, issuedAt: d.issuedAt, issuedBy: d.issuedBy, revokedAt: d.revokedAt, revokedBy: d.revokedBy, revokedReason: d.revokedReason,
  sizeBytes: d.sizeBytes, sha256: d.sha256, fileAvailable: Boolean(d.storageKey) && storage.exists(d.storageKey),
  ...(events ? { events: docs.eventsFor(d.id) } : {}),
});

// Admin file access (any issued or revoked document, e.g. for audit). Drafts have no file.
export function adminFile(id) {
  const d = docs.findAny(id);
  if (!d || !d.storageKey) throw notFound('Document file not found', 'DOCUMENT_NOT_FOUND');
  if (!storage.exists(d.storageKey)) throw notFound('The stored file is missing.', 'DOCUMENT_FILE_MISSING');
  return { path: storage.pathFor(d.storageKey), fileName: d.fileName };
}
