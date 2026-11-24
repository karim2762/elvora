import { db } from './index.js';

// A new request invalidates any earlier unused token for the same student.
export function createReset(tokenHash, studentId, expiresAt) {
  db.transaction(() => {
    db.prepare('DELETE FROM password_resets WHERE student_id = ? AND used_at IS NULL').run(studentId);
    db.prepare('INSERT INTO password_resets (token_hash, student_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, studentId, new Date().toISOString(), expiresAt);
  })();
}

// Atomically claims a token: succeeds once, only while unexpired and unused. Returns the student id or null.
export function consumeReset(tokenHash) {
  return db.transaction(() => {
    const row = db.prepare('SELECT student_id AS studentId FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(tokenHash, Date.now());
    if (!row) return null;
    const res = db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
      .run(new Date().toISOString(), tokenHash);
    return res.changes === 1 ? row.studentId : null;
  })();
}

export const purgeOldResets = () => db.prepare('DELETE FROM password_resets WHERE expires_at <= ? OR used_at IS NOT NULL').run(Date.now() - 24 * 3600 * 1000);
