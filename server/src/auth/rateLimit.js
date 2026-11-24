import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';

const { windowMs, loginMax, loginPerAccountMax, registerMax, forgotMax, resetMax, applyMax, applicationReadMax, paymentWriteMax, paymentUploadMax, adminPaymentWriteMax, adminExportMax, unreadPollMax, passwordChangeMax, adminMax, publicVerifyMax, publicVerifyMissMax } = config.rateLimit;
const make = (max, message, extra = {}) => rateLimit({
  windowMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { message, code: 'RATE_LIMITED' } }),
  ...extra,
});

const tooMany = 'Too many attempts. Please wait a few minutes and try again.';
// Failed logins only (successful ones don't count), per IP and per account+IP.
export const loginLimiter = make(loginMax, tooMany, { skipSuccessfulRequests: true });
export const loginAccountLimiter = make(loginPerAccountMax, tooMany, {
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}|${String(req.body?.email || '').trim().toLowerCase().slice(0, 254)}`,
});
export const registerLimiter = make(registerMax, 'Too many sign-up attempts. Please try again later.', { windowMs: 60 * 60 * 1000 });
export const forgotLimiter = make(forgotMax, tooMany);
export const resetLimiter = make(resetMax, tooMany);

// Stage 04B. These run AFTER requireAuth, so they are keyed by the authenticated student (not just the IP).
const perStudent = (req) => `student:${req.student?.id ?? req.ip}`;
export const applySubmitLimiter = make(applyMax, 'You are submitting applications too quickly. Please wait a while and try again.', { windowMs: 60 * 60 * 1000, keyGenerator: perStudent });
// Stage 09B Part 2A: task submissions per student per hour (a correction round needs a handful, never hundreds).
export const taskSubmitLimiter = make(config.rateLimit.taskSubmitMax, 'You are submitting too quickly. Please wait a while and try again.', { windowMs: 60 * 60 * 1000, keyGenerator: perStudent });
export const applicationReadLimiter = make(applicationReadMax, tooMany, { keyGenerator: perStudent });
// Counts only rejected admin keys (401), per IP. A real admin's typo (400/404) never locks them out.
export const adminLimiter = make(adminMax, tooMany, { skipSuccessfulRequests: true, requestWasSuccessful: (_req, res) => res.statusCode !== 401 });

// Stage 05C. Only wrong-current-password attempts count (validation mistakes don't), so a wrong current password can't be brute-forced from a stolen session.
export const passwordChangeLimiter = make(passwordChangeMax, tooMany, { skipSuccessfulRequests: true, requestWasSuccessful: (_req, res) => res.locals.wrongPassword !== true, keyGenerator: perStudent });
// The header bell asks for the unread count on every page change; it has its own budget so it never uses up the reads the pages need.
export const unreadPollLimiter = make(unreadPollMax, tooMany, { keyGenerator: perStudent });

// Stage 06C: public document verification (no login). Two budgets per IP: every lookup, and, much tighter, lookups that find nothing
// (hits don't count against the second), which is what makes guessing references impractical. Keyed by IP: set TRUST_PROXY behind a proxy.
export const publicVerifyLimiter = make(publicVerifyMax, 'Too many verification requests. Please wait a few minutes and try again.');
export const publicVerifyMissLimiter = make(publicVerifyMissMax, 'Too many verification requests. Please wait a few minutes and try again.', {
  skipSuccessfulRequests: true, requestWasSuccessful: (_req, res) => res.locals.verifyHit === true,
});

// Stage 10C Part 1: payments. Student limiters run AFTER requireAuth (keyed by student); the administrator limiters run after requireAdminSession (keyed by administrator),
// so one noisy account never locks out another and a shared office IP is not penalised. Every attempt counts, including rejected ones, which is what slows UTR guessing.
const perAdmin = (req) => `admin:${req.admin?.id ?? req.ip}`;
export const paymentWriteLimiter = make(paymentWriteMax, 'Too many payment requests. Please wait a few minutes and try again.', { keyGenerator: perStudent });
export const paymentUploadLimiter = make(paymentUploadMax, 'Too many file uploads. Please wait a few minutes and try again.', { keyGenerator: perStudent });
export const adminPaymentWriteLimiter = make(adminPaymentWriteMax, tooMany, { keyGenerator: perAdmin });
export const adminExportLimiter = make(adminExportMax, tooMany, { keyGenerator: perAdmin });
