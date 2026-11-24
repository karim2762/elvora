import { badRequest } from '../utils/errors.js';
import * as audit from '../db/audit.js';

// Stage 07C — audit log reads. There is deliberately no write, edit or delete function here: the log is only ever added to by the
// backend operations themselves (db/audit.js record()), and the database rejects UPDATE/DELETE on it.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export function listAuditLogs(query) {
  const one = (k) => (typeof query?.[k] === 'string' && query[k] !== '' && query[k] !== 'All' ? query[k] : null);
  const errors = {};
  const action = one('action'); const result = one('result'); const from = one('from'); const to = one('to'); const adminId = one('adminId');
  if (action && !audit.AUDIT_ACTIONS.includes(action)) errors.action = 'Unknown action type';
  if (result && !audit.AUDIT_RESULTS.includes(result)) errors.result = 'Result must be success or failure';
  if (from && !validDate(from)) errors.from = 'Use a date like 2026-11-21';
  if (to && !validDate(to)) errors.to = 'Use a date like 2026-11-21';
  if (from && to && !errors.from && !errors.to && from > to) errors.to = 'The end date can’t be before the start date';
  if (adminId && (adminId.length > 80 || /[\u0000-\u001f]/.test(adminId))) errors.adminId = 'Invalid admin reference';
  const num = (k, d, min, max) => { const v = query?.[k]; if (v === undefined || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) { errors[k] = `Use a whole number from ${min} to ${max}`; return d; } return n; };
  const pageSize = num('pageSize', 25, 1, 100); const wanted = num('page', 1, 1, 100000);
  if (Object.keys(errors).length) throw badRequest('Invalid filter', errors);
  const probe = audit.page({ action, from, to, adminId, result, limit: 1, offset: 0 });
  const totalPages = Math.max(1, Math.ceil(probe.total / pageSize));
  const page = Math.min(wanted, totalPages);
  const { total, rows } = audit.page({ action, from, to, adminId, result, limit: pageSize, offset: (page - 1) * pageSize });
  return { events: rows, pagination: { page, pageSize, total, totalPages }, filters: { actions: audit.AUDIT_ACTIONS, admins: audit.adminsInLog() } };
}
