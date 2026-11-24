import { db } from './index.js';
import { newDocumentId } from '../utils/documentId.js';
import { insert as notify } from './notifications.js';
import { allocateNumber } from '../documents/numbering.js';
import { newVerificationCode } from '../documents/verification.js';
import { record as audit } from './audit.js';

// All document SQL lives here. Student reads are scoped by student_id, so someone else's document ID is
// indistinguishable from a missing one.
const toDocument = (r) => r && ({
  id: r.id, type: r.type, status: r.status, title: r.title, issuedAt: r.issued_at, fileName: r.file_name, sizeBytes: r.size_bytes,
  enrollmentId: r.enrollment_id, applicationId: r.application_id, internshipId: r.internship_id, studentName: r.student_name ?? null,
  internship: { title: r.internship_title }, enrollmentCompletedAt: r.enrollment_completed_at ?? null, storageKey: r.storage_key, studentId: r.student_id,
  documentNumber: r.document_number, verificationCode: r.verification_code, templateVersion: r.template_version,
  issuedBy: r.issued_by, createdAt: r.created_at, revokedAt: r.revoked_at, revokedReason: r.revoked_reason, revokedBy: r.revoked_by, sha256: r.sha256,
  snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
});
const SELECT = `SELECT d.*, a.internship_title, e.completed_at AS enrollment_completed_at, s.full_name AS student_name FROM documents d JOIN enrollments e ON e.id = d.enrollment_id
  JOIN applications a ON a.id = e.application_id JOIN students s ON s.id = d.student_id`;

// Stage 06C: a student sees documents that were officially issued, and the ones later revoked (shown as revoked, never as valid).
// Drafts (not yet issued) are never visible.
export const listForStudent = (studentId) =>
  db.prepare(`${SELECT} WHERE d.student_id = ? AND e.student_id = ? AND d.status IN ('Issued', 'Revoked') ORDER BY d.issued_at DESC, d.id`).all(studentId, studentId).map(toDocument);
export const findOwned = (id, studentId) =>
  toDocument(db.prepare(`${SELECT} WHERE d.id = ? AND d.student_id = ? AND e.student_id = ? AND d.status IN ('Issued', 'Revoked')`).get(id, studentId, studentId));
// Public verification lookup by the unguessable reference. Returns Draft rows too; the caller decides (a Draft is "not found").
export const findByVerificationCode = (code) =>
  toDocument(db.prepare(`${SELECT} WHERE d.verification_code = ?`).get(code));
// Admin/system read by ID, any status. Never use for student-facing routes.
export const findAny = (id) => toDocument(db.prepare(`${SELECT} WHERE d.id = ?`).get(id));
export const findByEnrollmentAndType = (enrollmentId, type) =>
  toDocument(db.prepare(`${SELECT} WHERE d.enrollment_id = ? AND d.type = ? AND d.status <> 'Revoked'`).get(enrollmentId, type));

export class DuplicateDocumentError extends Error {}

// Records an officially issued document, tells the student, and (for a certificate) records the certificate on the
// internship so the progress timeline can show it. All or nothing.
export function issue({ enrollment, type, title, storageKey, fileName, sizeBytes, sha256, admin = null }) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newDocumentId();
      try {
        db.prepare(`INSERT INTO documents (id, student_id, enrollment_id, application_id, internship_id, type, status, title, template_version,
            storage_key, file_name, size_bytes, sha256, issued_by, created_at, issued_at)
          VALUES (@id, @studentId, @enrollmentId, @applicationId, @internshipId, @type, 'Issued', @title, 'uploaded',
            @storageKey, @fileName, @sizeBytes, @sha256, 'admin', @now, @now)`)
          .run({ id, studentId: enrollment.studentId, enrollmentId: enrollment.id, applicationId: enrollment.applicationId,
            internshipId: enrollment.internship.id, type, title, storageKey, fileName, sizeBytes, sha256, now });
        if (type === 'certificate') {
          db.prepare('UPDATE enrollments SET certificate_id = ?, certificate_issued_at = ?, updated_at = ? WHERE id = ?').run(id, now, now, enrollment.id);
        }
        notify({
          studentId: enrollment.studentId, type: type === 'certificate' ? 'certificate_issued' : 'offer_letter_issued',
          title: type === 'certificate' ? 'Your certificate has been issued' : 'Your offer letter has been issued',
          message: `${title} for ${enrollment.internship.title} is now available in Documents.`,
          applicationId: enrollment.applicationId, enrollmentId: enrollment.id, documentId: id,
        });
        audit({ admin, action: type === 'certificate' ? 'certificate.issue' : 'offer_letter.issue', targetType: 'document', targetId: id, reason: 'Uploaded PDF' });
        return findOwned(id, enrollment.studentId);
      } catch (err) {
        if (!String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT')) throw err;
        if (/documents\.id\b/.test(err.message)) continue;
        throw new DuplicateDocumentError();
      }
    }
    throw new Error('Could not generate a unique document ID');
  })();
}

// ---------------------------------------------------------------------------------------------------------------------
// Stage 06B: generated documents. Lifecycle: createDraft (number + verification code allocated, nothing printed yet)
// → finalizeIssued (PDF stored, status Issued, student notified) → revoke. Every step also writes an audit event.
// ---------------------------------------------------------------------------------------------------------------------

export class DocumentStateError extends Error {}

export function addEvent(documentId, event, { actor = null, actorKey = null, detail = null } = {}) {
  db.prepare('INSERT INTO document_events (document_id, event, actor, actor_key, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(documentId, event, actor, actorKey, detail, new Date().toISOString());
}
export const eventsFor = (documentId) =>
  db.prepare('SELECT event, actor, actor_key, detail, at FROM document_events WHERE document_id = ? ORDER BY id').all(documentId)
    .map((e) => ({ event: e.event, actor: e.actor, actorKey: e.actor_key, detail: e.detail, at: e.at }));

export function createDraft({ enrollment, type, title, templateVersion, snapshot, actor, actorKey }) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newDocumentId();
      try {
        const number = allocateNumber(type); // inside this transaction: a failed insert rolls the number back, so no gaps
        db.prepare(`INSERT INTO documents (id, student_id, enrollment_id, application_id, internship_id, type, status, title, document_number,
            verification_code, template_version, snapshot, created_at)
          VALUES (@id, @studentId, @enrollmentId, @applicationId, @internshipId, @type, 'Draft', @title, @number, @code, @templateVersion, @snapshot, @now)`)
          .run({ id, studentId: enrollment.studentId, enrollmentId: enrollment.id, applicationId: enrollment.applicationId,
            internshipId: enrollment.internship.id, type, title, number, code: newVerificationCode(), templateVersion, snapshot: JSON.stringify(snapshot), now });
        addEvent(id, 'created', { actor, actorKey, detail: number });
        return findAny(id);
      } catch (err) {
        if (!String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT')) throw err;
        if (/documents\.(id|verification_code)\b/.test(err.message)) continue;
        throw new DuplicateDocumentError();
      }
    }
    throw new Error('Could not generate a unique document ID');
  })();
}

export const refreshSnapshot = (id, snapshot) =>
  db.prepare("UPDATE documents SET snapshot = ? WHERE id = ? AND status = 'Draft'").run(JSON.stringify(snapshot), id);

// Draft → Issued. The WHERE status = 'Draft' guard makes concurrent issuance safe: exactly one caller changes the row.
export function finalizeIssued({ id, enrollment, storageKey, fileName, sizeBytes, sha256, issuedAt, actor, actorKey, admin = null }) {
  return db.transaction(() => {
    const r = db.prepare(`UPDATE documents SET status = 'Issued', storage_key = @storageKey, file_name = @fileName, size_bytes = @sizeBytes,
        sha256 = @sha256, issued_at = @issuedAt, issued_by = @actor WHERE id = @id AND status = 'Draft'`)
      .run({ id, storageKey, fileName, sizeBytes, sha256, issuedAt, actor });
    if (!r.changes) throw new DocumentStateError();
    const d = findAny(id);
    if (d.type === 'certificate') {
      db.prepare('UPDATE enrollments SET certificate_id = ?, certificate_issued_at = ?, updated_at = ? WHERE id = ?').run(id, issuedAt, issuedAt, enrollment.id);
    }
    notify({
      studentId: d.studentId, type: d.type === 'certificate' ? 'certificate_issued' : 'offer_letter_issued',
      title: d.type === 'certificate' ? 'Your certificate has been issued' : 'Your offer letter has been issued',
      message: `${d.title} for ${enrollment.internship.title} is now available in Documents.`,
      applicationId: d.applicationId, enrollmentId: d.enrollmentId, documentId: id,
    });
    addEvent(id, 'issued', { actor, actorKey, detail: `sha256:${sha256.slice(0, 16)}` });
    audit({ admin, action: d.type === 'certificate' ? 'certificate.issue' : 'offer_letter.issue', targetType: 'document', targetId: id, reason: d.documentNumber });
    return findAny(id);
  })();
}

export function revoke({ id, reason, actor, actorKey, admin = null }) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const r = db.prepare("UPDATE documents SET status = 'Revoked', revoked_at = ?, revoked_reason = ?, revoked_by = ? WHERE id = ? AND status = 'Issued'")
      .run(now, reason, actor, id);
    if (!r.changes) throw new DocumentStateError();
    const d = findAny(id);
    // A revoked certificate no longer counts as the internship's certificate (the progress timeline stops showing it).
    db.prepare('UPDATE enrollments SET certificate_id = NULL, certificate_issued_at = NULL, updated_at = ? WHERE id = ? AND certificate_id = ?').run(now, d.enrollmentId, id);
    notify({ studentId: d.studentId, type: 'document_revoked', title: 'A document was withdrawn',
      message: `${d.title} for ${d.internship.title} is no longer valid. Contact ELVORA if you have questions.`,
      applicationId: d.applicationId, enrollmentId: d.enrollmentId, documentId: id });
    addEvent(id, 'revoked', { actor, actorKey, detail: reason });
    audit({ admin, action: 'document.revoke', targetType: 'document', targetId: id, reason });
    return findAny(id);
  })();
}

export function listForAdmin({ type = null, status = null, enrollmentId = null, limit = 100 } = {}) {
  const where = []; const args = [];
  if (type) { where.push('d.type = ?'); args.push(type); }
  if (status) { where.push('d.status = ?'); args.push(status); }
  if (enrollmentId) { where.push('d.enrollment_id = ?'); args.push(enrollmentId); }
  return db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.created_at DESC, d.id LIMIT ?`).all(...args, limit).map(toDocument);
}

// Stage 07C: searchable, paginated admin list. `q` matches document ID, document number, verification reference, student name and
// internship title. LIKE wildcards in the search text are escaped, so it is always a plain substring search.
export function pageForAdmin({ type = null, status = null, enrollmentId = null, q = '', limit, offset }) {
  const where = []; const args = [];
  if (type) { where.push('d.type = ?'); args.push(type); }
  if (status) { where.push('d.status = ?'); args.push(status); }
  if (enrollmentId) { where.push('d.enrollment_id = ?'); args.push(enrollmentId); }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(d.id LIKE ? ESCAPE '\\' OR d.document_number LIKE ? ESCAPE '\\' OR d.verification_code LIKE ? ESCAPE '\\' OR s.full_name LIKE ? ESCAPE '\\' OR a.internship_title LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like, like);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM documents d JOIN enrollments e ON e.id = d.enrollment_id JOIN applications a ON a.id = e.application_id JOIN students s ON s.id = d.student_id ${w}`).get(...args).n;
  const rows = db.prepare(`${SELECT} ${w} ORDER BY d.created_at DESC, d.id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(toDocument);
  return { total, rows };
}
export const countsByStatus = () => Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM documents GROUP BY status').all().map((r) => [r.status, r.n]));
