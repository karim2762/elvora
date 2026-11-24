import { db } from '../db/index.js';
import { badRequest, notFound, HttpError } from '../utils/errors.js';
import { DEGREES, ACADEMIC_YEARS } from '../utils/validation.js';
import * as repo from '../db/announcements.js';
import * as audit from '../db/audit.js';
import * as students from '../db/students.js';

// Stage 07C — administrator announcements. Mass messaging needs: a signed-in administrator (enforced in the route), valid content, an
// explicit confirmation that names the recipient count the server just calculated, and it is audited. Nothing is reported as delivered
// unless the notification rows were actually written (the count returned is read back from the database).
const CATEGORIES = Object.keys(repo.CATEGORY_TYPE);
const INTERNSHIP_STATUSES = ['Awaiting Start', 'Active', 'Completed', 'Suspended', 'Cancelled'];
const ID_RE = /^ANN-[0-9A-F]{10}$/;
const STUDENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const line = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim() : '');
const block = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim() : '');

export function parseAnnouncementRequest(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const title = line(b.title);
  if (!title) errors.title = 'Title is required'; else if (title.length < 3) errors.title = 'Title must be at least 3 characters'; else if (title.length > 120) errors.title = 'Keep the title to 120 characters or fewer';
  const message = block(b.message);
  if (!message) errors.message = 'Message is required'; else if (message.length < 10) errors.message = 'Message must be at least 10 characters'; else if (message.length > 1000) errors.message = 'Keep the message to 1000 characters or fewer';
  const category = b.category === undefined ? 'general' : b.category;
  if (!CATEGORIES.includes(category)) errors.category = `Category must be one of: ${CATEGORIES.join(', ')}`;
  let audience = { type: 'all' };
  const a = b.audience;
  if (b.studentId && !a) { // the original single-student form
    if (typeof b.studentId !== 'string' || !STUDENT_RE.test(b.studentId)) errors.audience = 'Invalid student ID'; else audience = { type: 'student', studentId: b.studentId.toLowerCase() };
  } else if (a !== undefined) {
    if (!a || typeof a !== 'object' || !['all', 'group', 'student'].includes(a.type)) errors.audience = 'Audience type must be all, group or student';
    else if (a.type === 'student') { if (typeof a.studentId !== 'string' || !STUDENT_RE.test(a.studentId)) errors.audience = 'Invalid student ID'; else audience = { type: 'student', studentId: a.studentId.toLowerCase() }; }
    else if (a.type === 'group') {
      const g = { type: 'group' };
      if (a.degree !== undefined) { if (DEGREES.includes(a.degree)) g.degree = a.degree; else errors.audience = 'Unknown degree'; }
      if (a.academicYear !== undefined) { if (ACADEMIC_YEARS.includes(a.academicYear)) g.academicYear = a.academicYear; else errors.audience = 'Unknown academic year'; }
      if (a.internshipStatus !== undefined) { if (INTERNSHIP_STATUSES.includes(a.internshipStatus)) g.internshipStatus = a.internshipStatus; else errors.audience = 'Unknown internship status'; }
      if (!errors.audience && Object.keys(g).length === 1) errors.audience = 'Choose at least one group filter (degree, academicYear or internshipStatus), or send to all students';
      audience = g;
    }
  }
  if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields', errors);
  return { title, message, category, audience };
}

const resolve = (audience) => {
  if (audience.type === 'student' && !students.findById(audience.studentId)) throw notFound('Student not found', 'STUDENT_NOT_FOUND');
  return repo.recipientIds(audience);
};

// Step 1: how many students would receive it. Returns a COUNT only (no names or e-mail addresses).
export function preview(body) {
  const a = parseAnnouncementRequest(body);
  return { announcement: { title: a.title, category: a.category, audience: a.audience }, recipientCount: resolve(a.audience).length };
}

// Step 2: send. `confirm: true` and `confirmRecipientCount` (the number from the preview) are both required.
export function send(body, admin) {
  const a = parseAnnouncementRequest(body);
  if (body?.confirm !== true) throw new HttpError(400, 'Confirm that you want to send this announcement.', { code: 'CONFIRMATION_REQUIRED', fields: { confirm: 'Send confirm: true after reviewing the recipient count' } });
  const ids = resolve(a.audience);
  if (!ids.length) throw new HttpError(409, 'No eligible students match this audience, so nothing was sent.', { code: 'NO_RECIPIENTS' });
  if (body.confirmRecipientCount !== ids.length) {
    throw new HttpError(409, `The audience now has ${ids.length} eligible student${ids.length === 1 ? '' : 's'}, not ${body.confirmRecipientCount ?? 'the number you confirmed'}. Review and confirm again.`, { code: 'RECIPIENT_COUNT_CHANGED', details: { recipientCount: ids.length } });
  }
  const dup = repo.recentDuplicate({ title: a.title, message: a.message, audience: a.audience, sinceIso: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  if (dup) throw new HttpError(409, `The same announcement was already sent in the last 10 minutes (${dup}).`, { code: 'DUPLICATE_ANNOUNCEMENT', details: { id: dup } });
  const who = audit.actorOf(admin);
  const id = repo.newAnnouncementId();
  const now = new Date().toISOString();
  db.transaction(() => {
    const delivered = repo.insertAndDeliver({ id, ...a, ids, admin: who, now });
    if (delivered !== ids.length) throw new Error('Announcement delivery could not be verified'); // rolls everything back
    audit.record({ admin, action: 'announcement.create', targetType: 'announcement', targetId: id, reason: `${a.category}: ${a.title}` });
    audit.record({ admin, action: 'announcement.send', targetType: 'announcement', targetId: id, reason: `${ids.length} recipient${ids.length === 1 ? '' : 's'} (${a.audience.type})` });
  })();
  const sent = repo.find(id);
  return { announcement: sent, delivered: sent.delivery.delivered };
}

export function withdraw(id, body, admin) {
  if (!ID_RE.test(id)) throw notFound('Announcement not found', 'ANNOUNCEMENT_NOT_FOUND');
  const reason = line(body?.reason);
  if (reason.length < 5 || reason.length > 300) throw badRequest('Please fix the highlighted fields', { reason: 'Give a reason of 5 to 300 characters' });
  const cur = repo.find(id);
  if (!cur) throw notFound('Announcement not found', 'ANNOUNCEMENT_NOT_FOUND');
  if (cur.status === 'Withdrawn') throw new HttpError(409, 'This announcement was already withdrawn.', { code: 'ALREADY_WITHDRAWN' });
  return db.transaction(() => {
    const w = repo.withdraw(id, { reason, adminName: audit.actorOf(admin).name });
    if (!w) throw new HttpError(409, 'This announcement was already withdrawn.', { code: 'ALREADY_WITHDRAWN' });
    audit.record({ admin, action: 'announcement.withdraw', targetType: 'announcement', targetId: id, reason });
    return w;
  })();
}

export function list(query) {
  const one = (k) => (typeof query?.[k] === 'string' ? query[k] : undefined);
  const n = (k, d, min, max) => { const v = one(k); if (v === undefined || v === '') return d; const x = Number(v); if (!Number.isInteger(x) || x < min || x > max) throw badRequest('Invalid pagination value', { [k]: `Use a whole number from ${min} to ${max}` }); return x; };
  const status = one('status');
  if (status && !['Sent', 'Withdrawn'].includes(status)) throw badRequest('Invalid filter', { status: 'Status must be Sent or Withdrawn' });
  const pageSize = n('pageSize', 10, 1, 50);
  const probe = repo.page({ status, limit: 1, offset: 0 });
  const totalPages = Math.max(1, Math.ceil(probe.total / pageSize));
  const current = Math.min(n('page', 1, 1, 100000), totalPages);
  const { total, rows } = repo.page({ status, limit: pageSize, offset: (current - 1) * pageSize });
  return { announcements: rows, pagination: { page: current, pageSize, total, totalPages } };
}
export function get(id) {
  const a = ID_RE.test(id) ? repo.find(id) : null;
  if (!a) throw notFound('Announcement not found', 'ANNOUNCEMENT_NOT_FOUND');
  return { announcement: a };
}
