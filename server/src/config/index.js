import dotenv from 'dotenv';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';
const int = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const list = (v, d) => String(v || d).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

// Secrets must never have a hard-coded fallback in production.
let sessionSecret = process.env.SESSION_SECRET || '';
if (!sessionSecret) {
  if (isProd) throw new Error('SESSION_SECRET is required when NODE_ENV=production');
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] SESSION_SECRET not set: using a temporary secret. Sessions will reset on every restart.');
} else if (isProd && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production');
}

// DATABASE_URL: "file:./data/elevora.db" (SQLite file) or "file::memory:". Relative paths resolve from /server.
const dbUrl = process.env.DATABASE_URL || 'file:./data/elevora.db';
const dbPath = /:memory:/.test(dbUrl) ? ':memory:' : path.resolve(serverRoot, dbUrl.replace(/^(file|sqlite):(\/\/)?/, ''));

const configuredOrigins = list(process.env.CORS_ORIGIN, 'http://localhost:5173');
// Development convenience: http://localhost:X and http://127.0.0.1:X are the same machine, so allow both. Never in production.
const corsOrigins = isProd ? configuredOrigins
  : [...new Set(configuredOrigins.flatMap((o) => (/^http:\/\/localhost(:\d+)?$/.test(o) ? [o, o.replace('localhost', '127.0.0.1')] : [o])))];
const sameSite = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();

// Administrators update application statuses with a shared secret sent in the X-Admin-Key header (no student
// account can ever be an admin). Shorter than 32 characters is treated as "not configured": the admin API stays off.
let adminApiKey = process.env.ADMIN_API_KEY || '';
if (adminApiKey && adminApiKey.length < 32) {
  console.warn('[config] ADMIN_API_KEY is shorter than 32 characters, so the admin API is disabled.');
  adminApiKey = '';
}

// Stage 08A: the shared key is read-only by default. Anything that CHANGES data (statuses, documents, listings, settings...) needs a signed-in
// administrator session so the action is tied to a named account. Set ADMIN_API_KEY_ALLOW_WRITES=true only as a temporary bridge for old
// scripts that still send X-Admin-Key (see README, "Admin API key"); every such write is audited under the key's fingerprint.
const adminKeyWrites = process.env.ADMIN_API_KEY_ALLOW_WRITES === 'true';
if (adminApiKey && adminKeyWrites) console.warn('[config] ADMIN_API_KEY_ALLOW_WRITES=true: the shared key can still change data. Migrate to administrator sessions and turn this off.');

// Stage 06C: QR codes on official documents point at CLIENT_URL, so in production it must be HTTPS (plain http is allowed only
// for a localhost smoke test of a production build).
{
  const url = (process.env.CLIENT_URL || configuredOrigins[0]).replace(/\/$/, '');
  if (isProd && !/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) {
    throw new Error('CLIENT_URL must be an https:// URL when NODE_ENV=production (it is printed in document QR codes)');
  }
}

// Stage 09C: GitHub integration. Server-side only: nothing here is ever sent to the browser or logged.
const ghPerm = ['pull', 'triage', 'push'].includes(process.env.GITHUB_DEFAULT_REPOSITORY_PERMISSION) ? process.env.GITHUB_DEFAULT_REPOSITORY_PERMISSION : 'push';
const ghVis = ['private', 'internal', 'public'].includes(process.env.GITHUB_REPOSITORY_VISIBILITY) ? process.env.GITHUB_REPOSITORY_VISIBILITY : 'private';
if (isProd && process.env.GITHUB_CALLBACK_URL && !/^https:\/\//i.test(process.env.GITHUB_CALLBACK_URL)) throw new Error('GITHUB_CALLBACK_URL must be an https:// URL when NODE_ENV=production');

// All configuration is read here and nowhere else.
export const config = {
  env,
  isProd,
  port: int(process.env.PORT, 4000),
  corsOrigins,
  // Development only: lets one account review its own project submission (never honoured in production).
  allowSelfReview: !isProd && process.env.ALLOW_SELF_REVIEW === 'true',
  corsOrigin: configuredOrigins[0], // kept for backwards compatibility
  clientUrl: (process.env.CLIENT_URL || configuredOrigins[0]).replace(/\/$/, ''),
  trustProxy: process.env.TRUST_PROXY ? (Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY)) : false,
  dbPath,
  sessionSecret,
  session: {
    cookieName: 'elvora_session',
    sameSite: ['lax', 'strict', 'none'].includes(sameSite) ? sameSite : 'lax',
    secure: isProd || sameSite === 'none',
    shortTtlMs: 24 * 60 * 60 * 1000, // without "remember me"
    longTtlMs: 30 * 24 * 60 * 60 * 1000, // with "remember me"
  },
  adminApiKey,
  adminKeyWrites,
  // Private storage for officially issued documents. Never served statically; only the ownership-checked download route reads it.
  documentsDir: path.resolve(serverRoot, process.env.DOCUMENTS_DIR || './storage/documents'),
  maxDocumentBytes: int(process.env.MAX_DOCUMENT_MB, 5) * 1024 * 1024,
  // Stage 10B Part 1: manual UPI payments. No UPI ID / payee / bank detail lives in code or env: they are administrator settings stored in the database.
  payments: {
    proofDir: path.resolve(serverRoot, process.env.PAYMENT_PROOF_DIR || './storage/payment-proofs'), // private; never served statically
    maxProofBytes: int(process.env.PAYMENT_PROOF_MAX_MB, 3) * 1024 * 1024,
    orderExpiryHours: int(process.env.PAYMENT_ORDER_EXPIRY_HOURS, 72),
    maxPriceRupees: int(process.env.PAYMENT_MAX_PRICE_RUPEES, 10000),
    // Optional bootstrap: e-mails of administrator accounts that hold every payment permission. Others need a row in admin_permissions.
    adminEmails: list(process.env.PAYMENT_ADMIN_EMAILS, '').map((e) => e.toLowerCase()),
  },
  // Stage 10C Part 2: super administrators may grant or revoke the certificate.correct permission (only through scripts/certificate-permission.mjs; no HTTP route changes permissions).
  // Empty by default: with nobody listed the script refuses to change that permission.
  superAdminEmails: list(process.env.SUPER_ADMIN_EMAILS, '').map((e) => e.toLowerCase()),
  // Priority certificate service: open to every signed-in student by default (no invitation link needed). Set PRIORITY_PUBLIC_ACCESS=false to require invitations.
  priorityPublicAccess: process.env.PRIORITY_PUBLIC_ACCESS !== 'false',
  // Stage 06A: organization identity printed on official documents. Read here only; documents/organization.js normalizes it.
  organization: {
    name: process.env.ORG_NAME || 'ELVORA',
    legalName: process.env.ORG_LEGAL_NAME || '',
    logoPath: process.env.ORG_LOGO_PATH || '', // optional PNG/JPEG/SVG file; relative paths resolve from /server
    address: process.env.ORG_ADDRESS || '',
    email: process.env.ORG_EMAIL || '',
    website: process.env.ORG_WEBSITE || '',
    signatoryName: process.env.ORG_SIGNATORY_NAME || 'Gowtham',
    signatoryTitle: process.env.ORG_SIGNATORY_TITLE || 'Chief Executive Officer (CEO)',
    signatureEnabled: process.env.ORG_SIGNATURE_ENABLED !== 'false', // draws the signatory's name as a handwritten-style digital signature
    registrationLabel: process.env.ORG_REGISTRATION_LABEL || '',
    registrationNumber: process.env.ORG_REGISTRATION_NUMBER || '',
    registrationVerified: process.env.ORG_REGISTRATION_VERIFIED === 'true',
    footer: process.env.ORG_DOC_FOOTER || '',
    colorPrimary: process.env.ORG_COLOR_PRIMARY || '#1D4ED8',
    colorAccent: process.env.ORG_COLOR_ACCENT || '#0F766E',
    colorInk: process.env.ORG_COLOR_INK || '#101827',
  },
  resetTokenTtlMs: int(process.env.RESET_TOKEN_TTL_MINUTES, 30) * 60 * 1000,
  rateLimit: {
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MINUTES, 15) * 60 * 1000,
    loginMax: int(process.env.RATE_LIMIT_LOGIN_MAX, 10),
    loginPerAccountMax: int(process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX, 5),
    registerMax: int(process.env.RATE_LIMIT_REGISTER_MAX, 10),
    forgotMax: int(process.env.RATE_LIMIT_FORGOT_MAX, 5),
    resetMax: int(process.env.RATE_LIMIT_RESET_MAX, 10),
    applyMax: int(process.env.RATE_LIMIT_APPLY_MAX, 10), // application submissions per student per hour
    taskSubmitMax: int(process.env.RATE_LIMIT_TASK_SUBMIT_MAX, 30), // task submissions per student per hour
    applicationReadMax: int(process.env.RATE_LIMIT_APPLICATION_READ_MAX, 120), // application reads per student per window
    unreadPollMax: int(process.env.RATE_LIMIT_UNREAD_POLL_MAX, 300), // header-bell unread-count polls per student per window (separate from other reads)
    passwordChangeMax: int(process.env.RATE_LIMIT_PASSWORD_CHANGE_MAX, 5), // failed password changes per student per window
    paymentWriteMax: int(process.env.RATE_LIMIT_PAYMENT_WRITE_MAX, 30), // Stage 10C: payment orders / UTR submissions / corrections per student per window
    paymentUploadMax: int(process.env.RATE_LIMIT_PAYMENT_UPLOAD_MAX, 20), // Stage 10C: payment-proof uploads per student per window
    adminPaymentWriteMax: int(process.env.RATE_LIMIT_ADMIN_PAYMENT_WRITE_MAX, 200), // Stage 10C: confirm / reject / refund / configuration changes per administrator per window
    adminExportMax: int(process.env.RATE_LIMIT_ADMIN_EXPORT_MAX, 20), // Stage 10C: financial report views and CSV exports per administrator per window
    adminMax: int(process.env.RATE_LIMIT_ADMIN_MAX, 10), // failed admin-key attempts per IP per window
    publicVerifyMax: int(process.env.RATE_LIMIT_PUBLIC_VERIFY_MAX, 60), // public verification lookups per IP per window
    publicVerifyMissMax: int(process.env.RATE_LIMIT_PUBLIC_VERIFY_MISS_MAX, 15), // ...of which may find nothing (anti-guessing)
  },
  // Stage 07: background automation (offer letters, internship start, certificates after admin approval, document e-mails).
  automation: {
    enabled: process.env.AUTOMATION_ENABLED !== 'false',
    intervalMs: Math.max(1, int(process.env.AUTOMATION_INTERVAL_MINUTES, 5)) * 60 * 1000,
    autoEnroll: process.env.AUTO_ENROLL !== 'false', // create the internship record when an application is approved
    autoStartDelayDays: Math.max(0, int(process.env.AUTO_START_DELAY_DAYS, 3)), // default start date = approval day + this many days
    autoActivate: process.env.AUTO_ACTIVATE !== 'false', // Awaiting Start -> Active on the start date
    offerSlaHours: Math.max(1, int(process.env.OFFER_SLA_HOURS, 24)), // an offer letter later than this is reported as overdue
    emailDocuments: process.env.DOCUMENT_EMAILS !== 'false', // e-mail the PDF to the student (still needs SMTP settings)
    // Automatic APPLICATION approval (OFF unless AUTO_APPROVE_APPLICATIONS=true). An application is approved only when EVERY condition holds;
    // otherwise it simply waits for an administrator as before. Nothing is ever rejected automatically.
    autoApproveApplications: {
      enabled: process.env.AUTO_APPROVE_APPLICATIONS === 'true',
      delayMinutes: Math.max(0, int(process.env.AUTO_APPROVE_DELAY_MINUTES, 0)),             // wait this long after submission (gives an administrator time to look first)
      maxActivePerStudent: Math.max(1, int(process.env.AUTO_APPROVE_MAX_ACTIVE, 1)),         // a student may hold at most this many unfinished internships
      allowManualChecks: process.env.AUTO_APPROVE_ALLOW_MANUAL_CHECKS !== 'false',           // false = listings with free-text prerequisites always wait for a person
      internships: list(process.env.AUTO_APPROVE_INTERNSHIPS, '*'),                          // '*' = every listing, or a comma-separated list of listing IDs (e.g. ELV-WD-001)
      maxDurationDays: Math.max(0, int(process.env.AUTO_APPROVE_MAX_DURATION_DAYS, 0)),      // 0 = no limit; otherwise longer internships wait for a person
    },
  },
  // Stage 10C: when an internship has no tasks configured at all, hand students the published library tasks for its category instead of an empty list.
  tasks: {
    autoLibrary: process.env.AUTO_LIBRARY_TASKS !== 'false',
  },
  github: {
    appId: (process.env.GITHUB_APP_ID || '').trim(),
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim(), // PEM; "\n" escapes are accepted for single-line .env values
    clientId: (process.env.GITHUB_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GITHUB_CLIENT_SECRET || '').trim(),
    organization: (process.env.GITHUB_ORGANIZATION || '').trim(),
    callbackUrl: (process.env.GITHUB_CALLBACK_URL || '').trim(),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
    visibility: ghVis, // private | internal | public
    defaultPermission: ghPerm, // pull | triage | push (never above write for students)
    reviewTeam: (process.env.GITHUB_REVIEW_TEAM || '').trim(), // optional team slug that gets read access to every created repository
    tokenKey: process.env.GITHUB_TOKEN_ENCRYPTION_KEY || '', // optional; falls back to a key derived from SESSION_SECRET
    apiUrl: 'https://api.github.com',
  },
  // Email is only attempted when SMTP_HOST and MAIL_FROM are set.
  mail: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || '',
  },
  // Development convenience only (ignored in production): print reset links to the server console.
  devLogResetLinks: !isProd && process.env.DEV_LOG_RESET_LINKS === 'true',
};
