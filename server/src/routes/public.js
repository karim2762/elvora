import { Router } from 'express';
import { publicVerifyLimiter, publicVerifyMissLimiter } from '../auth/rateLimit.js';
import { normalizeReference, toPublicVerification } from '../documents/verification.js';
import { getOrganization } from '../documents/organization.js';
import * as docs from '../db/documents.js';
import { replacementReferenceFor } from '../db/priorityAdmin.js';

// Stage 06C: public, unauthenticated, read-only. Nothing here reads a cookie or an admin key, and nothing here can write.
// It is a separate router from /student and /admin on purpose: public verification never touches private document access.
const router = Router();
router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }); next(); }); // a revocation must show immediately
router.use(publicVerifyLimiter, publicVerifyMissLimiter);

const MESSAGES = {
  invalid: 'This is not a valid ELVORA verification reference. Check that it was typed or scanned correctly.',
  not_found: 'No ELVORA document matches this reference.',
};

// GET /public/documents/verify/:reference
//   200 { result: 'valid' | 'revoked', document }   issued documents, and ones since revoked (clearly not valid)
//   400 { result: 'invalid' }                       malformed reference (never reaches the database)
//   404 { result: 'not_found' }                     no such reference, or a Draft that was never issued. Identical in both cases,
//                                                   so the response reveals nothing about which references exist.
router.get('/documents/verify/:reference', (req, res) => {
  const reference = normalizeReference(req.params.reference);
  if (!reference) return res.status(400).json({ result: 'invalid', message: MESSAGES.invalid });
  const doc = docs.findByVerificationCode(reference);
  const document = doc && doc.status !== 'Draft' && doc.issuedAt ? toPublicVerification(doc, getOrganization().name, doc.status === 'Revoked' ? replacementReferenceFor(doc.id) : null) : null;
  if (!document) return res.status(404).json({ result: 'not_found', message: MESSAGES.not_found });
  res.locals.verifyHit = true;
  return res.json({ result: document.result, document });
});

export default router;
