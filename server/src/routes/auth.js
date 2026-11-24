import { Router } from 'express';
import { config } from '../config/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import { parseRegistration, parseLogin, parseForgot, parseReset } from '../utils/validation.js';
import { toPublicStudent } from '../utils/profile.js';
import { isEmailConfigured, sendPasswordResetEmail } from '../utils/mailer.js';
import { hashPassword, verifyPassword, dummyVerify } from '../auth/password.js';
import { newToken, hashToken } from '../auth/tokens.js';
import { startSession, endSession, optionalAuth } from '../auth/session.js';
import { loginLimiter, loginAccountLimiter, registerLimiter, forgotLimiter, resetLimiter } from '../auth/rateLimit.js';
import * as students from '../db/students.js';
import * as sessions from '../db/sessions.js';
import * as resets from '../db/passwordResets.js';
import { record as audit } from '../db/audit.js';

const router = Router();
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
router.use(noStore);

router.post('/register', registerLimiter, asyncHandler(async (req, res) => {
  const data = parseRegistration(req.body);
  if (students.findByEmail(data.email)) {
    throw new HttpError(409, 'An account with this email already exists. Try logging in instead.', { code: 'EMAIL_TAKEN', fields: { email: 'This email is already registered' } });
  }
  const { password, ...profile } = data;
  let student;
  try {
    student = students.createStudent({ ...profile, passwordHash: await hashPassword(password) });
  } catch (err) { // race between the check above and the insert
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'An account with this email already exists. Try logging in instead.', { code: 'EMAIL_TAKEN', fields: { email: 'This email is already registered' } });
    throw err;
  }
  startSession(res, student.id, false);
  res.status(201).json({ user: toPublicStudent(student) });
}));

router.post('/login', loginLimiter, loginAccountLimiter, asyncHandler(async (req, res) => {
  const { email, password, remember } = parseLogin(req.body);
  const student = students.findByEmail(email);
  const ok = student ? await verifyPassword(password, student.passwordHash) : await dummyVerify(password);
  if (!student || !ok) throw new HttpError(401, 'Incorrect email or password', { code: 'INVALID_CREDENTIALS' });
  if (student.accountStatus === 'suspended') throw new HttpError(403, 'This account is suspended. Please contact ELVORA support.', { code: 'ACCOUNT_SUSPENDED' }); // only after the password was correct
  startSession(res, student.id, remember);
  res.json({ user: toPublicStudent(student) });
}));

// Stage 07A: administrator sign-in. Same credentials check, rate limits and session cookie as /login, but a session is started
// ONLY for an account whose database role is 'admin'. A student's correct password gets the same generic failure as a wrong one,
// so this endpoint cannot be used to find out which emails are administrators.
router.post('/admin/login', loginLimiter, loginAccountLimiter, asyncHandler(async (req, res) => {
  const { email, password, remember } = parseLogin(req.body);
  const account = students.findByEmail(email);
  const ok = account ? await verifyPassword(password, account.passwordHash) : await dummyVerify(password);
  const asAdmin = account?.role === 'admin' ? { via: 'session', id: account.id, fullName: account.fullName } : null;
  // Only real administrator accounts are logged (no e-mail, no password): a wrong password for one is a recorded failure.
  if (asAdmin && !ok) audit({ admin: asAdmin, action: 'admin.login', targetType: 'session', result: 'failure', reason: 'Incorrect password' });
  if (!account || !ok || account.role !== 'admin') throw new HttpError(401, 'Incorrect email or password', { code: 'INVALID_CREDENTIALS' });
  startSession(res, account.id, remember);
  audit({ admin: asAdmin, action: 'admin.login', targetType: 'session' });
  res.json({ user: toPublicStudent(account) });
}));

router.post('/logout', optionalAuth, (req, res) => {
  if (req.student?.role === 'admin') audit({ admin: { via: 'session', id: req.student.id, fullName: req.student.fullName }, action: 'admin.logout', targetType: 'session' });
  endSession(req, res);
  res.status(204).end();
});

router.get('/me', optionalAuth, (req, res) => {
  res.json({ user: req.student ? toPublicStudent(req.student) : null });
});

// Always answers the same way whether or not the account exists (no account enumeration).
router.post('/forgot-password', forgotLimiter, asyncHandler(async (req, res) => {
  const { email } = parseForgot(req.body);
  const emailConfigured = isEmailConfigured();
  const student = students.findByEmail(email);
  // In production without email there is nobody to deliver a token to, so none is created.
  if (student && (emailConfigured || config.devLogResetLinks)) {
    const token = newToken();
    resets.createReset(hashToken(token), student.id, Date.now() + config.resetTokenTtlMs);
    const link = `${config.clientUrl}/reset-password?token=${token}`;
    if (emailConfigured) {
      // Not awaited: response time stays identical for known and unknown emails.
      sendPasswordResetEmail({ to: student.email, name: student.fullName.split(' ')[0], link, minutes: Math.round(config.resetTokenTtlMs / 60000) })
        .catch((err) => console.error('[mail] password reset email FAILED to send (the student was NOT emailed):', err.message)); // never logs the link/token
    } else {
      console.log(`[dev] Password reset link for ${student.email} (email not configured): ${link}`);
    }
  }
  res.json({
    ok: true,
    emailDelivery: emailConfigured ? 'enabled' : 'not_configured',
    message: emailConfigured
      ? 'If an account exists for that email, we will email a reset link. It expires soon and works once. If nothing arrives within a few minutes, check your spam folder or contact the ELVORA administrator.'
      : 'Password reset emails are not set up on this server, so no email was sent. Please contact the ELVORA administrator.',
  });
}));

router.post('/reset-password', resetLimiter, asyncHandler(async (req, res) => {
  const { token, password } = parseReset(req.body);
  const studentId = resets.consumeReset(hashToken(token)); // single use, expiry enforced in SQL
  if (!studentId) throw new HttpError(400, 'This reset link is invalid or has expired. Please request a new one.', { code: 'RESET_TOKEN_INVALID' });
  students.setPasswordHash(studentId, await hashPassword(password));
  sessions.deleteSessionsForStudent(studentId); // sign out everywhere
  res.json({ ok: true, message: 'Password updated. You can now log in.' });
}));

export default router;
