import { badRequest } from './errors.js';
import { isValidDate } from './dates.js';

// Server-side validation is authoritative. The client mirrors these rules for instant feedback only.
export const DEGREES = ['B.Tech', 'B.E.', 'BCA', 'MCA', 'B.Sc', 'M.Sc', 'M.Tech', 'M.E.', 'BBA', 'MBA', 'Diploma', 'Other'];
export const ACADEMIC_YEARS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year', 'Graduated'];
export const graduationYearRange = () => { const y = new Date().getFullYear(); return [y - 5, y + 8]; };

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', 'qwerty123', 'iloveyou1', 'admin123', 'welcome1', 'letmein123']);
// Strips control characters and collapses whitespace.
const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '');

export function normalizeEmail(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
export function normalizePhone(v) {
  if (typeof v !== 'string') return null;
  const digits = v.replace(/[\s\-().]/g, '');
  const m = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(digits);
  return m ? m[1] : null;
}
function normalizeProfileUrl(v, host, pathRe) {
  const raw = clean(v);
  if (!raw) return '';
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const h = url.hostname.toLowerCase().replace(/^www\./, '');
  if (h !== host || !pathRe.test(url.pathname) || raw.length > 200) return null;
  return `https://${host === 'linkedin.com' ? 'www.' : ''}${host}${url.pathname.replace(/\/$/, '')}`;
}

export function validatePassword(pw, { email = '' } = {}) {
  if (typeof pw !== 'string' || !pw) return 'Password is required';
  if (pw.length < 8) return 'Use at least 8 characters';
  if (pw.length > 128) return 'Password must be 128 characters or fewer';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Include at least one letter and one number';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'That password is too common. Choose something harder to guess';
  if (email && pw.toLowerCase() === email.toLowerCase()) return 'Password cannot be the same as your email';
  return '';
}

// Fields shared by registration and profile update. Returns { value, errors }.
function profileFields(body) {
  const errors = {}; const value = {};
  const text = (key, label, min, max) => {
    const v = clean(body[key]);
    if (!v) errors[key] = `${label} is required`;
    else if (v.length < min) errors[key] = `${label} is too short`;
    else if (v.length > max) errors[key] = `${label} must be ${max} characters or fewer`;
    value[key] = v;
  };
  text('fullName', 'Full name', 2, 80);
  if (!errors.fullName && !/^[\p{L}][\p{L}\p{M} .'-]*$/u.test(value.fullName)) errors.fullName = 'Use letters, spaces, dots, hyphens or apostrophes only';

  const phone = normalizePhone(body.phone);
  if (!clean(body.phone)) errors.phone = 'Mobile number is required';
  else if (!phone) errors.phone = 'Enter a valid 10-digit Indian mobile number (starts with 6-9)';
  value.phone = phone;

  text('college', 'College / University', 2, 120);
  text('branch', 'Branch / Department', 2, 80);
  value.degree = clean(body.degree);
  if (!value.degree) errors.degree = 'Degree is required';
  else if (!DEGREES.includes(value.degree)) errors.degree = 'Choose a degree from the list';
  value.academicYear = clean(body.academicYear);
  if (!value.academicYear) errors.academicYear = 'Academic year is required';
  else if (!ACADEMIC_YEARS.includes(value.academicYear)) errors.academicYear = 'Choose an academic year from the list';

  const [minY, maxY] = graduationYearRange();
  const gy = typeof body.graduationYear === 'string' && /^\d{4}$/.test(body.graduationYear.trim()) ? Number(body.graduationYear) : body.graduationYear;
  if (gy === '' || gy === undefined || gy === null) errors.graduationYear = 'Graduation year is required';
  else if (!Number.isInteger(gy) || gy < minY || gy > maxY) errors.graduationYear = `Enter a year between ${minY} and ${maxY}`;
  value.graduationYear = gy;

  let skills = body.skills;
  if (skills === undefined || skills === null || skills === '') skills = [];
  if (typeof skills === 'string') skills = skills.split(',');
  if (!Array.isArray(skills)) { errors.skills = 'Skills must be a list'; skills = []; }
  const seen = new Set(); const out = [];
  for (const s of skills) {
    const t = clean(s);
    if (!t) continue;
    if (t.length > 30) { errors.skills = 'Each skill must be 30 characters or fewer'; break; }
    if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  if (out.length > 20) errors.skills = 'Add up to 20 skills';
  value.skills = out;

  const gh = normalizeProfileUrl(body.github, 'github.com', /^\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/?$/);
  if (gh === null) errors.github = 'Enter a GitHub profile like github.com/username';
  value.github = gh || '';
  const li = normalizeProfileUrl(body.linkedin, 'linkedin.com', /^\/in\/[A-Za-z0-9\-_%]{3,100}\/?$/);
  if (li === null) errors.linkedin = 'Enter a LinkedIn profile like linkedin.com/in/username';
  value.linkedin = li || '';
  return { value, errors };
}

const finish = (value, errors) => {
  if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields', errors);
  return value;
};
const asObject = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

export function parseRegistration(input) {
  const body = asObject(input);
  const { value, errors } = profileFields(body);
  value.email = normalizeEmail(body.email);
  if (!value.email) errors.email = 'Email is required';
  else if (value.email.length > 254 || !EMAIL_RE.test(value.email)) errors.email = 'Enter a valid email address';
  const pwErr = validatePassword(body.password, { email: value.email });
  if (pwErr) errors.password = pwErr;
  if (!body.confirmPassword) errors.confirmPassword = 'Confirm your password';
  else if (body.password !== body.confirmPassword) errors.confirmPassword = 'Passwords do not match';
  value.password = body.password;
  return finish(value, errors);
}

export function parseProfileUpdate(input) {
  const { value, errors } = profileFields(asObject(input)); // email, password and id are never read from the body
  return finish(value, errors);
}

export function parseLogin(input) {
  const body = asObject(input);
  const email = normalizeEmail(body.email);
  const errors = {};
  if (!email) errors.email = 'Email is required';
  if (typeof body.password !== 'string' || !body.password) errors.password = 'Password is required';
  if (typeof body.password === 'string' && body.password.length > 1024) errors.password = 'Invalid password';
  return finish({ email, password: body.password, remember: body.remember === true }, errors);
}

export function parseForgot(input) {
  const email = normalizeEmail(asObject(input).email);
  if (!email || !EMAIL_RE.test(email)) throw badRequest('Enter a valid email address', { email: 'Enter a valid email address' });
  return { email };
}

export function parseReset(input) {
  const body = asObject(input);
  const errors = {};
  if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(body.token)) errors.token = 'This reset link is invalid';
  const pwErr = validatePassword(body.password);
  if (pwErr) errors.password = pwErr;
  if (!body.confirmPassword) errors.confirmPassword = 'Confirm your password';
  else if (body.password !== body.confirmPassword) errors.confirmPassword = 'Passwords do not match';
  return finish({ token: body.token, password: body.password }, errors);
}

// ---------- Stage 04B: internship applications ----------
export const APPLICATION_STATUSES = ['Submitted', 'Under Review', 'Approved', 'Rejected', 'Cancelled'];
export const MOTIVATION_MIN = 50;
export const MOTIVATION_MAX = 1000;

// Like clean(), but keeps paragraph breaks: strips control characters (except newlines), trims each line,
// and allows at most one blank line in a row.
const cleanMultiline = (v) => (typeof v === 'string'
  ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  : '');

const APPLICATION_PROFILE_KEYS = ['fullName', 'phone', 'college', 'degree', 'branch', 'academicYear', 'skills'];

// The authenticated student's record supplies identity (email) and the profile fields the form does not collect.
// Nothing about WHO is applying is ever read from the request body.
export function parseApplication(input, student) {
  const body = asObject(input);
  // Reuse the profile rules so the application form and the profile page can never disagree. Fields the application
  // form does not collect come from the stored profile and are ignored below (so an old graduation year can't block an application).
  const { value: profile, errors: profileErrors } = profileFields({ ...body, graduationYear: student.graduationYear, github: student.github, linkedin: student.linkedin });
  const errors = {};
  const responses = {};
  for (const k of APPLICATION_PROFILE_KEYS) { responses[k] = profile[k]; if (profileErrors[k]) errors[k] = profileErrors[k]; }
  if (!errors.skills && responses.skills.length === 0) errors.skills = 'Add at least one technical skill';

  const internshipId = typeof body.internshipId === 'string' ? body.internshipId.trim() : '';
  if (!/^[A-Za-z0-9-]{1,40}$/.test(internshipId)) errors.internshipId = 'Choose an internship to apply for';

  const motivation = cleanMultiline(body.motivation);
  if (!motivation) errors.motivation = 'Tell us why you want to join this internship';
  else if (motivation.length < MOTIVATION_MIN) errors.motivation = `Please write at least ${MOTIVATION_MIN} characters`;
  else if (motivation.length > MOTIVATION_MAX) errors.motivation = `Please keep this to ${MOTIVATION_MAX} characters or fewer`;
  responses.motivation = motivation;

  // The form shows the registered email read-only. If one is sent, it must be that email; it can never change here.
  if (body.email !== undefined && body.email !== '' && normalizeEmail(body.email) !== student.email.toLowerCase()) {
    errors.email = 'Your registered email can’t be changed here';
  }
  if (body.termsAccepted !== true) errors.termsAccepted = 'You must accept the Terms and Conditions to apply';
  if (body.privacyAccepted !== true) errors.privacyAccepted = 'You must agree to the Privacy Policy to apply';

  return finish({ internshipId, responses }, errors);
}

export function parseStatusUpdate(input) {
  const status = asObject(input).status;
  if (!APPLICATION_STATUSES.includes(status)) throw badRequest('Choose a valid status', { status: `Status must be one of: ${APPLICATION_STATUSES.join(', ')}` });
  return { status };
}

// ---------- Stage 05B: internship enrollments (administrator input only) ----------
export const ENROLLMENT_STATUSES = ['Awaiting Start', 'Active', 'Completed', 'Suspended', 'Cancelled'];
export const OBJECTIVES_MAX = 12;
export const OBJECTIVE_MAX_LEN = 200;
export const PROJECT_MAX_LEN = 200;
export const INSTRUCTIONS_MAX_LEN = 3000;

const optionalDate = (v, key, errors) => {
  if (v === undefined || v === null || v === '') return null;
  if (!isValidDate(v)) { errors[key] = 'Use a valid date in YYYY-MM-DD format'; return null; }
  return v;
};

// Details an administrator can set on an enrollment. Missing fields become null / [] (never invented).
export function parseEnrollmentDetails(input) {
  const body = asObject(input);
  const errors = {};
  const startDate = optionalDate(body.startDate, 'startDate', errors);
  const expectedEndDate = optionalDate(body.expectedEndDate, 'expectedEndDate', errors);
  if (startDate && expectedEndDate && expectedEndDate < startDate) errors.expectedEndDate = 'The end date can’t be before the start date';

  const assignedProject = clean(body.assignedProject) || null;
  if (assignedProject && assignedProject.length > PROJECT_MAX_LEN) errors.assignedProject = `Keep the project name to ${PROJECT_MAX_LEN} characters or fewer`;

  let learningObjectives = [];
  if (body.learningObjectives !== undefined && body.learningObjectives !== null) {
    if (!Array.isArray(body.learningObjectives)) errors.learningObjectives = 'Learning objectives must be a list';
    else {
      learningObjectives = body.learningObjectives.map(clean).filter(Boolean);
      if (learningObjectives.length > OBJECTIVES_MAX) errors.learningObjectives = `Add at most ${OBJECTIVES_MAX} learning objectives`;
      else if (learningObjectives.some((o) => o.length > OBJECTIVE_MAX_LEN)) errors.learningObjectives = `Keep each objective to ${OBJECTIVE_MAX_LEN} characters or fewer`;
    }
  }
  const instructions = cleanMultiline(body.instructions) || null;
  if (instructions && instructions.length > INSTRUCTIONS_MAX_LEN) errors.instructions = `Keep the instructions to ${INSTRUCTIONS_MAX_LEN} characters or fewer`;

  return finish({ startDate, expectedEndDate, assignedProject, learningObjectives, instructions }, errors);
}

export function parseEnrollmentStatus(input) {
  const body = asObject(input);
  const errors = {};
  if (!ENROLLMENT_STATUSES.includes(body.status)) errors.status = `Status must be one of: ${ENROLLMENT_STATUSES.join(', ')}`;
  const startDate = optionalDate(body.startDate, 'startDate', errors);
  const expectedEndDate = optionalDate(body.expectedEndDate, 'expectedEndDate', errors);
  if (startDate && expectedEndDate && expectedEndDate < startDate) errors.expectedEndDate = 'The end date can’t be before the start date';
  const reason = cleanMultiline(body.reason) || null;
  if (reason && reason.length > 500) errors.reason = 'Keep the reason to 500 characters or fewer';
  return finish({ status: body.status, startDate, expectedEndDate, reason }, errors);
}

// Query string for GET /applications/my. Unknown values are rejected (400), never silently ignored.
export const APPLICATIONS_PAGE_SIZE_DEFAULT = 10;
export const APPLICATIONS_PAGE_SIZE_MAX = 50;
export function parseApplicationsQuery(query) {
  const q = asObject(query);
  const errors = {};
  let status = null;
  if (q.status !== undefined && q.status !== '' && q.status !== 'All') {
    if (!APPLICATION_STATUSES.includes(q.status)) errors.status = `Status must be one of: ${APPLICATION_STATUSES.join(', ')}`;
    else status = q.status;
  }
  const intIn = (v, key, min, max, dflt) => {
    if (v === undefined || v === '') return dflt;
    if (!/^\d{1,6}$/.test(String(v)) || Number(v) < min || Number(v) > max) { errors[key] = `${key} must be a whole number from ${min} to ${max}`; return dflt; }
    return Number(v);
  };
  const page = intIn(q.page, 'page', 1, 100000, 1);
  const pageSize = intIn(q.pageSize, 'pageSize', 1, APPLICATIONS_PAGE_SIZE_MAX, APPLICATIONS_PAGE_SIZE_DEFAULT);
  return finish({ status, page, pageSize }, errors);
}

// ---------- Stage 05C: documents, notifications, profile, password ----------
// PATCH /student/profile accepts any subset of the editable fields. Missing fields keep their stored value, then the
// whole record goes through the same rules as sign-up, so a partial update can never store something invalid.
// Email, id, role and password fields are never read. An email that differs from the account's is rejected, not ignored.
export const PROFILE_EDITABLE = ['fullName', 'phone', 'college', 'degree', 'branch', 'academicYear', 'graduationYear', 'skills', 'github', 'linkedin'];
export function parseProfilePatch(input, student) {
  const body = asObject(input);
  if (body.email !== undefined && normalizeEmail(body.email) !== student.email.toLowerCase()) {
    throw badRequest('Email can’t be changed here', { email: 'Email can’t be changed here' });
  }
  const merged = {
    fullName: student.fullName, phone: student.phone, college: student.college, degree: student.degree, branch: student.branch,
    academicYear: student.academicYear, graduationYear: student.graduationYear, skills: student.skills, github: student.github, linkedin: student.linkedin,
  };
  let changed = 0;
  for (const k of PROFILE_EDITABLE) if (Object.hasOwn(body, k)) { merged[k] = body[k]; changed++; }
  if (!changed) throw badRequest('Nothing to update', { _form: 'Send at least one field to change' });
  return parseProfileUpdate(merged);
}

export function parsePasswordChange(input, student) {
  const body = asObject(input);
  const errors = {};
  const { currentPassword, newPassword, confirmPassword } = body;
  if (typeof currentPassword !== 'string' || !currentPassword) errors.currentPassword = 'Enter your current password';
  else if (currentPassword.length > 1024) errors.currentPassword = 'Invalid password';
  const pwErr = validatePassword(newPassword, { email: student.email });
  if (pwErr) errors.newPassword = pwErr;
  else if (newPassword === currentPassword) errors.newPassword = 'Choose a password different from your current one';
  if (!confirmPassword) errors.confirmPassword = 'Confirm your new password';
  else if (newPassword !== confirmPassword) errors.confirmPassword = 'Passwords do not match';
  return finish({ currentPassword, newPassword }, errors);
}

export const NOTIFICATIONS_PAGE_SIZE_DEFAULT = 10;
export const NOTIFICATIONS_PAGE_SIZE_MAX = 50;
export function parseNotificationsQuery(query) {
  const q = asObject(query);
  const errors = {};
  let unreadOnly = false;
  if (q.unread !== undefined && q.unread !== '') {
    if (q.unread === 'true') unreadOnly = true; else if (q.unread !== 'false') errors.unread = 'unread must be true or false';
  }
  const intIn = (v, key, min, max, dflt) => {
    if (v === undefined || v === '') return dflt;
    if (!/^\d{1,6}$/.test(String(v)) || Number(v) < min || Number(v) > max) { errors[key] = `${key} must be a whole number from ${min} to ${max}`; return dflt; }
    return Number(v);
  };
  const page = intIn(q.page, 'page', 1, 100000, 1);
  const pageSize = intIn(q.pageSize, 'pageSize', 1, NOTIFICATIONS_PAGE_SIZE_MAX, NOTIFICATIONS_PAGE_SIZE_DEFAULT);
  return finish({ unreadOnly, page, pageSize }, errors);
}

// Admin announcement. studentId is optional (omit it to reach every student).
export function parseAnnouncement(input) {
  const body = asObject(input);
  const errors = {};
  const title = clean(body.title);
  if (!title) errors.title = 'Title is required'; else if (title.length > 120) errors.title = 'Keep the title to 120 characters or fewer';
  const message = cleanMultiline(body.message);
  if (!message) errors.message = 'Message is required'; else if (message.length > 1000) errors.message = 'Keep the message to 1000 characters or fewer';
  let studentId = null;
  if (body.studentId !== undefined && body.studentId !== null && body.studentId !== '') {
    if (typeof body.studentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.studentId)) errors.studentId = 'Invalid student ID'; else studentId = body.studentId;
  }
  return finish({ title, message, studentId }, errors);
}

// Admin: officially issued document upload. The PDF arrives as the raw request body; type/title are query parameters.
export function parseDocumentUpload(query, body, maxBytes) {
  const q = asObject(query);
  const errors = {};
  if (!['offer_letter', 'certificate'].includes(q.type)) errors.type = 'type must be offer_letter or certificate';
  const title = q.title === undefined || q.title === '' ? (q.type === 'certificate' ? 'Internship Completion Certificate' : 'Internship Offer Letter') : clean(q.title);
  if (title.length < 3 || title.length > 120) errors.title = 'Title must be 3 to 120 characters';
  if (!Buffer.isBuffer(body) || body.length === 0) errors.file = 'Send the PDF as the request body with Content-Type: application/pdf';
  else if (body.length > maxBytes) errors.file = `The PDF must be ${Math.round(maxBytes / 1048576)} MB or smaller`;
  else if (body.subarray(0, 5).toString('latin1') !== '%PDF-') errors.file = 'The file is not a valid PDF';
  return finish({ type: q.type, title }, errors);
}

// Stage 06B: administrator document requests. issuedBy / revokedBy are free-text labels for the audit trail (the platform has a
// single shared admin key), so they are bounded and stripped of control characters.
const label = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
export function parseIssueRequest(body) {
  const b = asObject(body);
  const errors = {};
  if (typeof b.internshipId !== 'string' || !b.internshipId.trim()) errors.internshipId = 'internshipId is required';
  const issuedBy = b.issuedBy === undefined || b.issuedBy === '' ? '' : label(b.issuedBy);
  if (issuedBy && (issuedBy.length < 2 || issuedBy.length > 60)) errors.issuedBy = 'issuedBy must be 2 to 60 characters';
  return finish({ internshipId: String(b.internshipId ?? '').trim(), issuedBy }, errors);
}
export function parseRevokeRequest(body) {
  const b = asObject(body);
  const errors = {};
  const reason = label(b.reason);
  if (reason.length < 3 || reason.length > 300) errors.reason = 'A reason of 3 to 300 characters is required';
  const revokedBy = b.revokedBy === undefined || b.revokedBy === '' ? '' : label(b.revokedBy);
  if (revokedBy && (revokedBy.length < 2 || revokedBy.length > 60)) errors.revokedBy = 'revokedBy must be 2 to 60 characters';
  return finish({ reason, revokedBy }, errors);
}

// Stage 07: administrator's certificate decision for one internship.
export const CERTIFICATE_DECISIONS = ['Pending', 'Approved', 'Declined'];
export function parseCertificateDecision(body) {
  const b = asObject(body);
  const errors = {};
  if (!CERTIFICATE_DECISIONS.includes(b.decision)) errors.decision = `decision must be one of: ${CERTIFICATE_DECISIONS.join(', ')}`;
  const note = cleanMultiline(b.note) || '';
  if (note.length > 300) errors.note = 'Keep the note to 300 characters or fewer';
  const decidedBy = b.decidedBy === undefined || b.decidedBy === '' ? '' : label(b.decidedBy);
  if (decidedBy && (decidedBy.length < 2 || decidedBy.length > 60)) errors.decidedBy = 'decidedBy must be 2 to 60 characters';
  return finish({ decision: b.decision, note, decidedBy: decidedBy || 'Administrator' }, errors);
}

// ---------- Stage 07B: internship listings + application review (administrator input only) ----------
import { CATEGORY_SLUGS, DURATION_DAYS, DIFFICULTIES, INTERNSHIP_TYPES } from '../internships/categories.js';
import { todayIST } from './dates.js';

const stringList = (v, key, label, { min, max, maxLen, errors }) => {
  const raw = typeof v === 'string' ? v.split('\n') : v;
  if (!Array.isArray(raw)) { errors[key] = `${label} must be a list`; return []; }
  const seen = new Set(); const out = [];
  for (const item of raw) {
    const t = clean(item);
    if (!t || seen.has(t.toLowerCase())) continue;
    if (t.length > maxLen) { errors[key] = `Keep each item in ${label.toLowerCase()} to ${maxLen} characters or fewer`; return out; }
    seen.add(t.toLowerCase()); out.push(t);
  }
  if (out.length < min) errors[key] = `Add at least ${min} item${min > 1 ? 's' : ''} to ${label.toLowerCase()}`;
  else if (out.length > max) errors[key] = `Add at most ${max} items to ${label.toLowerCase()}`;
  return out;
};

// Validates a COMPLETE listing (create) or an existing listing with changes applied (edit). Unknown keys are ignored, so the
// request can never set ID, publication, activation, archive or audit fields; those only change through the dedicated actions.
export function parseListing(input, { creating = false } = {}) {
  const body = asObject(input);
  const errors = {};
  const title = clean(body.title);
  if (!title) errors.title = 'Title is required'; else if (title.length < 3) errors.title = 'Title is too short'; else if (title.length > 120) errors.title = 'Title must be 120 characters or fewer';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  if (!category) errors.category = 'Category is required'; else if (!CATEGORY_SLUGS.includes(category)) errors.category = 'Choose a category from the list';
  const description = cleanMultiline(body.description);
  if (!description) errors.description = 'Description is required'; else if (description.length < 20) errors.description = 'Write at least 20 characters'; else if (description.length > 600) errors.description = 'Keep the description to 600 characters or fewer';
  const durationDays = typeof body.durationDays === 'string' && /^\d+$/.test(body.durationDays) ? Number(body.durationDays) : body.durationDays;
  if (durationDays === undefined || durationDays === null || durationDays === '') errors.durationDays = 'Duration is required';
  else if (!DURATION_DAYS.includes(durationDays)) errors.durationDays = 'Duration must be 7 days, 1 month, 2 months or 3 months';
  const skills = stringList(body.skills, 'skills', 'Skills required', { min: 1, max: 20, maxLen: 40, errors });
  const outcomes = stringList(body.outcomes, 'outcomes', 'Learning outcomes', { min: 1, max: 12, maxLen: 200, errors });
  const el = asObject(body.eligibility);
  const who = cleanMultiline(el.who); const academic = cleanMultiline(el.academic);
  const knowledge = stringList(el.knowledge ?? [], 'eligibility', 'Prerequisites', { min: 0, max: 10, maxLen: 120, errors });
  if (!who) errors.eligibility = 'Describe who this internship is for'; else if (who.length > 300) errors.eligibility = 'Keep "who is it for" to 300 characters or fewer';
  if (academic.length > 300) errors.eligibility = 'Keep the academic requirement to 300 characters or fewer';
  const type = typeof body.type === 'string' ? body.type : '';
  if (!INTERNSHIP_TYPES.includes(type)) errors.type = 'Choose an internship type';
  const difficulty = typeof body.difficulty === 'string' ? body.difficulty : '';
  if (!DIFFICULTIES.includes(difficulty)) errors.difficulty = 'Choose a difficulty';
  let seats = body.seats;
  if (seats === '' || seats === undefined || seats === null) seats = null;
  else {
    seats = typeof seats === 'string' && /^\d+$/.test(seats) ? Number(seats) : seats;
    if (!Number.isInteger(seats) || seats < 1 || seats > 10000) { errors.seats = 'Seats must be a whole number from 1 to 10000 (or leave blank)'; seats = null; }
  }
  let deadline = body.deadline;
  if (deadline === '' || deadline === undefined || deadline === null) deadline = null;
  else if (!isValidDate(deadline)) { errors.deadline = 'Use a valid date in YYYY-MM-DD format'; deadline = null; }
  const status = body.status === undefined || body.status === '' ? 'open' : body.status;
  if (!['open', 'upcoming'].includes(status)) errors.status = 'Application window must be Open or Opens soon';
  if (status === 'open' && creating && deadline && deadline < todayIST()) errors.deadline = 'The deadline can’t be in the past';
  return finish({ title, category, description, durationDays, skills, outcomes, eligibility: { who, academic, knowledge }, type, difficulty, seats, deadline, status, featured: body.featured === true }, errors);
}

export function parseListingsQuery(query) {
  const q = asObject(query);
  const errors = {};
  const state = q.state === undefined || q.state === '' || q.state === 'all' ? null : q.state;
  if (state && !['published', 'draft', 'active', 'inactive', 'archived'].includes(state)) errors.state = 'Unknown filter';
  const category = q.category === undefined || q.category === '' ? null : q.category;
  if (category && !CATEGORY_SLUGS.includes(category)) errors.category = 'Unknown category';
  const num = (v, key, dflt, max) => { if (v === undefined || v === '') return dflt; if (!/^\d{1,6}$/.test(String(v)) || Number(v) < 1 || Number(v) > max) { errors[key] = `${key} must be a whole number from 1 to ${max}`; return dflt; } return Number(v); };
  const page = num(q.page, 'page', 1, 100000); const pageSize = num(q.pageSize, 'pageSize', 10, 50);
  return finish({ state, category, page, pageSize, q: typeof q.q === 'string' ? q.q.trim().slice(0, 80) : '' }, errors);
}

export const NOTE_MAX = 1000;
// Body of PATCH /admin/applications/:id/status: the new status plus an optional internal note stored with the history entry.
export function parseStatusChange(input) {
  const { status } = parseStatusUpdate(input);
  const note = cleanMultiline(asObject(input).note);
  if (note.length > NOTE_MAX) throw badRequest('Please fix the highlighted fields', { note: `Keep the note to ${NOTE_MAX} characters or fewer` });
  return { status, note: note || null };
}
export function parseReviewNote(input) {
  const note = cleanMultiline(asObject(input).note);
  const errors = {};
  if (!note) errors.note = 'Write a note first'; else if (note.length > NOTE_MAX) errors.note = `Keep the note to ${NOTE_MAX} characters or fewer`;
  return finish({ note }, errors);
}
