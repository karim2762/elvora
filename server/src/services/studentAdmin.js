import { notFound, badRequest } from '../utils/errors.js';
import { DEGREES, ACADEMIC_YEARS } from '../utils/validation.js';
import * as students from '../db/students.js';

// Stage 07B — administrator student management. Read-mostly: the only write is the account status (active/suspended).
// The role is never read from, or written by, anything in this module.
export const ACCOUNT_STATUSES = ['active', 'suspended'];
const REASON_MIN = 5; const REASON_MAX = 500;
export const STUDENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const intIn = (v, fallback, min, max, field, errors) => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) { errors[field] = `Use a whole number from ${min} to ${max}`; return fallback; }
  return n;
};
export function parseStudentsQuery(query) {
  const errors = {};
  const one = (k) => (typeof query[k] === 'string' ? query[k] : undefined);
  const page = intIn(one('page'), 1, 1, 100000, 'page', errors);
  const pageSize = intIn(one('pageSize'), 10, 1, 50, 'pageSize', errors);
  const status = one('status'); const degree = one('degree'); const academicYear = one('academicYear');
  if (status && status !== 'All' && !ACCOUNT_STATUSES.includes(status)) errors.status = 'Unknown status';
  if (degree && degree !== 'All' && !DEGREES.includes(degree)) errors.degree = 'Unknown degree';
  if (academicYear && academicYear !== 'All' && !ACADEMIC_YEARS.includes(academicYear)) errors.academicYear = 'Unknown academic year';
  if (Object.keys(errors).length) throw badRequest('Invalid filter', errors);
  const q = (one('q') ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return { page, pageSize, q, status: status && status !== 'All' ? status : null, degree: degree && degree !== 'All' ? degree : null, academicYear: academicYear && academicYear !== 'All' ? academicYear : null };
}

export function listStudents(query) {
  const f = parseStudentsQuery(query);
  const probe = students.pageForAdmin({ ...f, limit: 1, offset: 0 });
  const totalPages = Math.max(1, Math.ceil(probe.total / f.pageSize));
  const page = Math.min(f.page, totalPages);
  const { total, rows } = students.pageForAdmin({ ...f, limit: f.pageSize, offset: (page - 1) * f.pageSize });
  return { students: rows, pagination: { page, pageSize: f.pageSize, total, totalPages }, counts: students.statusCounts() };
}
export function studentDetail(id) {
  const d = STUDENT_ID_RE.test(id) ? students.detailForAdmin(id) : null;
  if (!d) throw notFound('Student not found', 'STUDENT_NOT_FOUND');
  return d;
}
// Body: { status: 'active' | 'suspended', reason }. Nothing else in the body is read, so a role (or any other field) can't be changed here.
export function changeAccountStatus(id, body, admin) {
  if (!STUDENT_ID_RE.test(id)) throw notFound('Student not found', 'STUDENT_NOT_FOUND');
  const status = body?.status;
  if (!ACCOUNT_STATUSES.includes(status)) throw badRequest('Please fix the highlighted fields', { status: 'Status must be active or suspended' });
  const reason = typeof body?.reason === 'string' ? body.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (status === 'suspended' && reason.length < REASON_MIN) throw badRequest('Please fix the highlighted fields', { reason: `Give a reason (at least ${REASON_MIN} characters)` });
  if (reason.length > REASON_MAX) throw badRequest('Please fix the highlighted fields', { reason: `Keep the reason to ${REASON_MAX} characters or fewer` });
  const r = students.setAccountStatus(id, status, { admin, reason: reason || null });
  if (!r) throw notFound('Student not found', 'STUDENT_NOT_FOUND'); // also the answer for an administrator account: it can't be changed here
  return { ...studentDetail(id), changed: r.changed };
}
