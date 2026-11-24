import { DEGREES, ACADEMIC_YEARS, graduationYearRange } from '../config/student';

// Instant feedback only. The server re-validates everything.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const t = (v) => (typeof v === 'string' ? v.trim() : '');

export const isValidPhone = (v) => /^(?:\+91|91|0)?[6-9]\d{9}$/.test(String(v).replace(/[\s\-().]/g, ''));

const text = (label, min, max) => (v) => {
  const s = t(v);
  if (!s) return `${label} is required`;
  if (s.length < min) return `${label} is too short`;
  if (s.length > max) return `${label} must be ${max} characters or fewer`;
  return '';
};
const profileUrl = (host, pathRe, example) => (v) => {
  const raw = t(v);
  if (!raw) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.hostname.toLowerCase().replace(/^www\./, '') === host && pathRe.test(u.pathname)) return '';
  } catch { /* fall through */ }
  return `Enter a profile like ${example}`;
};

export function passwordStrength(pw = '') {
  const checks = [
    { label: '8+ characters', ok: pw.length >= 8 },
    { label: 'A letter', ok: /[A-Za-z]/.test(pw) },
    { label: 'A number', ok: /\d/.test(pw) },
    { label: 'A symbol or mixed case', ok: /[^A-Za-z0-9]/.test(pw) || (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) },
  ];
  let score = checks.filter((c) => c.ok).length;
  if (pw.length >= 12 && score >= 3) score = 4;
  if (pw.length < 8 || !checks[1].ok || !checks[2].ok) score = Math.min(score, 1);
  if (!pw) score = 0;
  return { score, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][score], checks };
}

export const rules = {
  fullName: (v) => text('Full name', 2, 80)(v) || (/^[\p{L}][\p{L}\p{M} .'-]*$/u.test(t(v)) ? '' : 'Use letters, spaces, dots, hyphens or apostrophes only'),
  email: (v) => (!t(v) ? 'Email is required' : EMAIL_RE.test(t(v)) ? '' : 'Enter a valid email address'),
  phone: (v) => (!t(v) ? 'Mobile number is required' : isValidPhone(v) ? '' : 'Enter a valid 10-digit Indian mobile number (starts with 6-9)'),
  password: (v) => {
    if (!v) return 'Password is required';
    if (v.length < 8) return 'Use at least 8 characters';
    if (v.length > 128) return 'Password must be 128 characters or fewer';
    if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return 'Include at least one letter and one number';
    return '';
  },
  confirmPassword: (v, all) => (!v ? 'Confirm your password' : v !== all.password ? 'Passwords do not match' : ''),
  college: text('College / University', 2, 120),
  branch: text('Branch / Department', 2, 80),
  degree: (v) => (!v ? 'Choose your degree' : DEGREES.includes(v) ? '' : 'Choose a degree from the list'),
  academicYear: (v) => (!v ? 'Choose your current year' : ACADEMIC_YEARS.includes(v) ? '' : 'Choose a year from the list'),
  graduationYear: (v) => {
    const [min, max] = graduationYearRange();
    if (!t(String(v ?? ''))) return 'Graduation year is required';
    const n = Number(v);
    return Number.isInteger(n) && /^\d{4}$/.test(String(v).trim()) && n >= min && n <= max ? '' : `Enter a year between ${min} and ${max}`;
  },
  skills: (v) => (Array.isArray(v) && v.length > 20 ? 'Add up to 20 skills' : Array.isArray(v) && v.some((s) => s.length > 30) ? 'Each skill must be 30 characters or fewer' : ''),
  github: profileUrl('github.com', /^\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/?$/, 'github.com/username'),
  linkedin: profileUrl('linkedin.com', /^\/in\/[A-Za-z0-9\-_%]{3,100}\/?$/, 'linkedin.com/in/username'),
};

export const SIGNUP_FIELDS = ['fullName', 'email', 'phone', 'password', 'confirmPassword', 'college', 'degree', 'branch', 'academicYear', 'graduationYear', 'skills', 'github', 'linkedin'];
export const PROFILE_FIELDS = ['fullName', 'phone', 'college', 'degree', 'branch', 'academicYear', 'graduationYear', 'skills', 'github', 'linkedin'];

export function validate(values, fields, ruleSet = rules) {
  const errors = {};
  for (const f of fields) { const e = ruleSet[f](values[f], values); if (e) errors[f] = e; }
  return errors;
}

// ---- Stage 04B: internship application ----
export const MOTIVATION_MIN = 50;
export const MOTIVATION_MAX = 1000;
// Same clean-up the server applies before counting: tidy spaces, keep paragraph breaks.
export const tidyMotivation = (v) => String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();

export const applicationRules = {
  ...rules,
  skills: (v) => (!Array.isArray(v) || v.length === 0 ? 'Add at least one technical skill' : rules.skills(v)),
  motivation: (v) => {
    const n = tidyMotivation(v).length;
    if (!n) return 'Tell us why you want to join this internship';
    if (n < MOTIVATION_MIN) return `Please write at least ${MOTIVATION_MIN} characters (${n} so far)`;
    if (n > MOTIVATION_MAX) return `Please keep this to ${MOTIVATION_MAX} characters or fewer`;
    return '';
  },
};
export const APPLICATION_FIELDS = ['fullName', 'phone', 'college', 'degree', 'branch', 'academicYear', 'skills', 'motivation'];
