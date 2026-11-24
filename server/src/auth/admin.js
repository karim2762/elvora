import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { HttpError, unauthorized } from '../utils/errors.js';
import { optionalAuth } from './session.js';

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
const keyMatches = (supplied) => typeof supplied === 'string' && config.adminApiKey && crypto.timingSafeEqual(digest(supplied), digest(config.adminApiKey));
const forbidden = () => new HttpError(403, 'Administrator access required', { code: 'ADMIN_REQUIRED' });

// Stage 07A — role-based administrator access. An administrator is a normal account whose role (stored in the database,
// never taken from the request) is 'admin'. The role is read from the server-side session on EVERY request.
//   - no session            -> 401 (log in)
//   - session, not an admin -> 403 (students can never pass)
// req.admin is built from the database record, so nothing the client sends can name or impersonate an administrator.
export function requireAdminSession(req, res, next) {
  optionalAuth(req, res, (err) => {
    if (err) return next(err);
    if (!req.student) return next(unauthorized());
    if (req.student.role !== 'admin') return next(forbidden());
    req.admin = { id: req.student.id, fullName: req.student.fullName, email: req.student.email, via: 'session' };
    next();
  });
}

// Existing admin console API (Stage 05B–07): accepts an administrator session OR the shared ADMIN_API_KEY in `X-Admin-Key`.
// Stage 08A: the answer is the same whether or not a shared key is configured, so a client can always tell what happened:
//   - administrator session, or a matching shared key -> allowed
//   - signed in as a student (not an administrator)    -> 403
//   - nobody signed in (or the session has expired)    -> 401
// (Before 08A these routes answered 404 when no key was configured, so an expired administrator session looked like a missing page.)
export function requireAdmin(req, res, next) {
  optionalAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.student?.role === 'admin') {
      req.admin = { id: req.student.id, fullName: req.student.fullName, email: req.student.email, via: 'session' };
      return next();
    }
    // Compare fixed-length digests in constant time so the key can't be learned from response timing.
    if (config.adminApiKey && keyMatches(req.headers['x-admin-key'])) { req.admin = { via: 'key' }; return next(); }
    if (req.student) return next(forbidden());
    return next(new HttpError(401, 'Administrator access required', { code: 'ADMIN_REQUIRED' }));
  });
}
