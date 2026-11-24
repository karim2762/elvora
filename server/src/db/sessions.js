import { db } from './index.js';

export const createSession = (tokenHash, studentId, expiresAt) =>
  db.prepare('INSERT INTO sessions (token_hash, student_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash, studentId, new Date().toISOString(), expiresAt);

export const findValidSession = (tokenHash) =>
  db.prepare('SELECT student_id AS studentId, expires_at AS expiresAt FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(tokenHash, Date.now());

export const deleteSession = (tokenHash) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
export const deleteSessionsForStudent = (studentId) => db.prepare('DELETE FROM sessions WHERE student_id = ?').run(studentId);
export const purgeExpiredSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
export const deleteOtherSessions = (studentId, keepTokenHash) => db.prepare('DELETE FROM sessions WHERE student_id = ? AND token_hash <> ?').run(studentId, keepTokenHash);
