import crypto from 'node:crypto';
import { config } from '../config/index.js';
import * as storage from '../documents/storage.js';
import { checkEligibility } from '../documents/eligibility.js';
import { HttpError, notFound } from '../utils/errors.js';
import { parseDocumentUpload } from '../utils/validation.js';
import { DOCUMENT_LABELS } from '../utils/documentId.js';
import * as docs from '../db/documents.js';
import * as enrollments from '../db/enrollments.js';
import { taskGate } from './completionEligibility.js';

// Documents are stored as <random>.pdf under config.documentsDir. The storage key is random, never derived from user
// input, and never leaves the server; students only ever fetch a file through the ownership-checked route.
const fileExists = (key) => Boolean(key) && storage.exists(key);

// What a student may see. No storage key, no student ID.
// Stage 06C: `status` is Issued or Revoked. A revoked document reports available:false (its file is never served) and carries
// only the withdrawal date, not the administrator's internal reason. completionDate is shown for certificates only.
export const toStudentDocument = (d) => ({
  id: d.id, type: d.type, typeLabel: DOCUMENT_LABELS[d.type], title: d.title, status: d.status, issuedAt: d.issuedAt,
  revokedAt: d.status === 'Revoked' ? d.revokedAt : null,
  documentNumber: d.documentNumber, verificationCode: d.verificationCode,
  enrollmentId: d.enrollmentId, internshipTitle: d.internship.title, fileName: d.fileName, sizeBytes: d.sizeBytes,
  completionDate: d.type === 'certificate' ? (d.snapshot?.dates?.completedAt ?? d.enrollmentCompletedAt ?? null) : null,
  available: d.status === 'Issued' && fileExists(d.storageKey),
});
export const listStudentDocuments = (student) => docs.listForStudent(student.id).map(toStudentDocument);
export const getOwnedDocument = (id, student) => {
  const d = docs.findOwned(id, student.id);
  if (!d) throw notFound('Document not found', 'DOCUMENT_NOT_FOUND');
  return d;
};
// Returns { path, fileName } for an owned document whose file exists, else throws 404 (DOCUMENT_FILE_MISSING).
export function resolveFile(id, student) {
  const d = getOwnedDocument(id, student);
  // A withdrawn document must not be previewed or downloaded as if it were valid (the PDF itself carries no revoked mark).
  if (d.status === 'Revoked') throw new HttpError(410, 'This document has been revoked and is no longer valid.', { code: 'DOCUMENT_REVOKED' });
  if (!fileExists(d.storageKey)) throw notFound('This document’s file is not available right now. Please contact ELVORA support.', 'DOCUMENT_FILE_MISSING');
  return { path: storage.pathFor(d.storageKey), fileName: d.fileName };
}

// Admin: attach an officially issued PDF to an internship.
export function issueDocument(enrollmentId, query, body, admin = null) {
  const enrollment = enrollments.findById(enrollmentId);
  if (!enrollment) throw notFound('Internship not found', 'ENROLLMENT_NOT_FOUND');
  const { type, title } = parseDocumentUpload(query, body, config.maxDocumentBytes);
  // Eligibility rules live in documents/eligibility.js (shared with the generator). Error codes are unchanged.
  const existing = docs.findByEnrollmentAndType(enrollment.id, type);
  const verdict = checkEligibility({ type, enrollment, existing, taskGate: type === 'certificate' ? taskGate(enrollment) : null });
  if (!verdict.eligible) throw new HttpError(409, verdict.message, { code: verdict.code });

  const storageKey = storage.newKey();
  storage.put(storageKey, body);
  try {
    const safe = `${type === 'certificate' ? 'ELVORA-Certificate' : 'ELVORA-Offer-Letter'}-${enrollment.id}.pdf`;
    return docs.issue({ enrollment, type, title, storageKey, fileName: safe, sizeBytes: body.length, admin, sha256: crypto.createHash('sha256').update(body).digest('hex') });
  } catch (err) {
    storage.remove(storageKey); // no orphan file if the record could not be saved
    if (err instanceof docs.DuplicateDocumentError) throw new HttpError(409, 'This document has already been issued for this internship.', { code: 'DOCUMENT_EXISTS' });
    throw err;
  }
}
