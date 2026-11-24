import crypto from 'node:crypto';
import { config } from '../config/index.js';

// Verification reference: ELV-VER-XXXX-XXXX-XXXX (12 random characters, ~60 bits). It is printed on the document and encoded in
// the QR code. It is unguessable and independent of the document number and ID. Stage 06B adds the public lookup; this file
// fixes the identifier format and the ONLY fields a public lookup may ever return.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const VERIFICATION_RE = /^ELV-VER-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
export const VERIFICATION_PLACEHOLDER = 'ELV-VER-XXXX-XXXX-XXXX';
export const newVerificationCode = () => {
  const c = Array.from({ length: 12 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `ELV-VER-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
};
// URL the QR code points to (the public /verify/:reference page). Uses CLIENT_URL so it works on any host.
export const verificationUrl = (code) => `${config.clientUrl}/verify/${encodeURIComponent(code)}`;

// Phones and people add case/whitespace noise when typing a reference; accept that, then require the exact format.
// Returns the canonical reference, or null when it is malformed (the public route answers "invalid" without touching the database).
export function normalizeReference(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const ref = raw.trim().toUpperCase();
  return VERIFICATION_RE.test(ref) ? ref : null;
}

// Public-safe projection: the ONLY fields the public verification page may ever show. Deliberately omits: student email/phone/ID,
// college, storage key, file name, hash, snapshot, revocation reason, internal document ID.
// The student's name is shown as printed, because verifying a certificate means confirming who it was issued to.
// A Draft is not an issued document, so it has no public projection (the caller treats it exactly like "not found").
// replacedByReference (Stage 10A Part 2): set only when this document was replaced by a free administrative correction. It is the replacement's public
// verification reference, so a person holding the old certificate can be sent to the current one. The old one is never shown as valid.
export function toPublicVerification(doc, organizationName = null, replacedByReference = null) {
  if (!doc || doc.status === 'Draft') return null;
  const superseded = doc.status === 'Revoked' && Boolean(replacedByReference);
  return {
    valid: doc.status === 'Issued',
    result: doc.status === 'Issued' ? 'valid' : superseded ? 'superseded' : 'revoked',
    status: superseded ? 'Superseded' : doc.status,
    ...(superseded ? { replacedByReference } : {}),
    type: doc.type,
    documentNumber: doc.documentNumber,
    elvoraId: doc.enrollmentId ?? null, // the single ID printed on the document
    studentName: doc.snapshot?.student?.fullName ?? null,
    internshipTitle: doc.snapshot?.internship?.title ?? null,
    durationDays: doc.snapshot?.internship?.durationDays ?? null,
    issuedAt: doc.issuedAt,
    revokedAt: doc.status === 'Revoked' ? doc.revokedAt : null,
    organizationName,
  };
}
