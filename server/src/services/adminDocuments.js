import fs from 'node:fs';
import crypto from 'node:crypto';
import { badRequest, notFound } from '../utils/errors.js';
import { DOCUMENT_ID_RE } from '../utils/documentId.js';
import { DOCUMENT_TYPES, DOCUMENT_STATUSES } from '../documents/constants.js';
import { ENROLLMENT_ID_RE } from '../utils/enrollmentId.js';
import * as docs from '../db/documents.js';
import * as audit from '../db/audit.js';
import * as storage from '../documents/storage.js';
import { toPublicVerification, verificationUrl } from '../documents/verification.js';
import { getOrganization } from '../documents/organization.js';
import { toAdminDocument } from '../documents/issuance.js';

// Stage 07C — admin document management reads (search, filter, verify, history). Issuing and revoking stay in documents/issuance.js
// (the Stage 06 generator and its eligibility rules); nothing here creates or changes a document.
const num = (v, d, min, max, field) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest('Invalid pagination value', { [field]: `Use a whole number from ${min} to ${max}` });
  return n;
};

export function listDocuments(query) {
  const one = (k) => (typeof query?.[k] === 'string' ? query[k] : undefined);
  const type = one('type') && one('type') !== 'All' ? one('type') : null;
  const status = one('status') && one('status') !== 'All' ? one('status') : null;
  const errors = {};
  if (type && !DOCUMENT_TYPES.includes(type)) errors.type = `Type must be one of: ${DOCUMENT_TYPES.join(', ')}`;
  if (status && !DOCUMENT_STATUSES.includes(status)) errors.status = `Status must be one of: ${DOCUMENT_STATUSES.join(', ')}`;
  const enrollmentId = one('internshipId') ?? null;
  if (enrollmentId && !ENROLLMENT_ID_RE.test(enrollmentId)) errors.internshipId = 'Invalid internship ID';
  if (Object.keys(errors).length) throw badRequest('Unknown type, status or internship filter', errors);
  const q = (one('q') ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  const pageSize = num(one('pageSize'), 25, 1, 100, 'pageSize');
  const probe = docs.pageForAdmin({ type, status, q, enrollmentId, limit: 1, offset: 0 });
  const totalPages = Math.max(1, Math.ceil(probe.total / pageSize));
  const page = Math.min(num(one('page'), 1, 1, 100000, 'page'), totalPages);
  const { total, rows } = docs.pageForAdmin({ type, status, q, enrollmentId, limit: pageSize, offset: (page - 1) * pageSize });
  const counts = docs.countsByStatus();
  return { documents: rows.map((d) => toAdminDocument(d)), pagination: { page, pageSize, total, totalPages }, counts: { Issued: counts.Issued ?? 0, Revoked: counts.Revoked ?? 0, Draft: counts.Draft ?? 0 } };
}

const load = (id) => {
  const d = DOCUMENT_ID_RE.test(id) ? docs.findAny(id) : null;
  if (!d) throw notFound('Document not found', 'DOCUMENT_NOT_FOUND');
  return d;
};

// Verify one document: what the PUBLIC verification page shows for it right now, plus a check that the stored file still matches its recorded hash.
export function verifyDocument(id) {
  const d = load(id);
  let integrity = { state: 'not_applicable' };
  if (d.storageKey) {
    if (!storage.exists(d.storageKey)) integrity = { state: 'missing' };
    else integrity = { state: crypto.createHash('sha256').update(fs.readFileSync(storage.pathFor(d.storageKey))).digest('hex') === d.sha256 ? 'match' : 'mismatch' };
  }
  return {
    documentId: d.id, status: d.status, verificationReference: d.verificationCode,
    verificationUrl: d.verificationCode && d.status !== 'Draft' ? verificationUrl(d.verificationCode) : null,
    publicVerification: toPublicVerification(d, getOrganization().name), // null for a Draft: the public page treats a Draft as "not found"
    integrity: { ...integrity, checkedAt: new Date().toISOString() },
  };
}

// Issuance history: this document's events and audit entries, plus every other document (any status) ever made for the same internship.
export function documentHistory(id) {
  const d = load(id);
  return {
    document: toAdminDocument(d),
    events: docs.eventsFor(id),
    audit: audit.forTarget('document', id),
    sameInternship: docs.listForAdmin({ enrollmentId: d.enrollmentId }).map((x) => toAdminDocument(x)),
  };
}
