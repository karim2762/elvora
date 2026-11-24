import { config } from '../config/index.js';
import { newToken, hashToken } from './tokens.js';
import * as sessions from '../db/sessions.js';
import * as students from '../db/students.js';
import { unauthorized } from '../utils/errors.js';

const { cookieName, sameSite, secure } = config.session;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ } }
  }
  return out;
}
const baseCookie = { httpOnly: true, sameSite, secure, path: '/' };

export function startSession(res, studentId, remember) {
  const ttl = remember ? config.session.longTtlMs : config.session.shortTtlMs;
  const token = newToken();
  sessions.createSession(hashToken(token), studentId, Date.now() + ttl);
  // "Remember me" => persistent cookie. Otherwise a browser-session cookie (also capped server-side at 24h).
  res.cookie(cookieName, token, remember ? { ...baseCookie, maxAge: ttl } : baseCookie);
}

export function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[cookieName];
  if (token) sessions.deleteSession(hashToken(token));
  res.clearCookie(cookieName, baseCookie);
}

// Attaches req.student (full record, server-side only) or throws 401.
export function requireAuth(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[cookieName];
  const session = token && sessions.findValidSession(hashToken(token));
  const student = session && students.findById(session.studentId);
  if (!student || student.accountStatus === 'suspended') return next(unauthorized()); // a suspended account is signed out everywhere
  req.student = student;
  next();
}

// Same as requireAuth but never errors: used by /auth/me to answer "who am I?".
export function optionalAuth(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[cookieName];
  const session = token && sessions.findValidSession(hashToken(token));
  const found = session && students.findById(session.studentId);
  req.student = found && found.accountStatus !== 'suspended' ? found : null;
  next();
}

// Hash of the session cookie on this request (used to keep the current session when others are revoked).
export const currentTokenHash = (req) => { const t = parseCookies(req.headers.cookie)[cookieName]; return t ? hashToken(t) : null; };
