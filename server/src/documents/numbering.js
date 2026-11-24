import { db } from '../db/index.js';
import { NUMBER_PREFIX } from './constants.js';

// Document numbers: ELV-OL-2026-000001 (offer letters) and ELV-CRT-2026-000001 (certificates). One counter per type and
// calendar year (India time), allocated ONLY when a document is issued, so drafts and previews never burn a number.
// The number is a label, not a secret: it grants no access. Verification uses a separate random code (verification.js).
export const NUMBER_RE = /^ELV-(OL|CRT)-\d{4}-\d{6}$/;
export const NUMBER_PLACEHOLDER = (type) => `ELV-${NUMBER_PREFIX[type]}-YYYY-######`;
export const formatNumber = (type, year, seq) => `ELV-${NUMBER_PREFIX[type]}-${year}-${String(seq).padStart(6, '0')}`;
export const yearIST = (now = new Date()) => Number(new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 4));

// Atomic: BEGIN IMMEDIATE (db.transaction) serialises writers, so two issuances can never receive the same value.
// Call inside the same transaction that inserts the document so a failed issuance does not leave a gap.
export function allocateNumber(type, now = new Date()) {
  const year = yearIST(now);
  return db.transaction(() => {
    db.prepare('INSERT INTO document_sequences (type, year, last_value) VALUES (?, ?, 0) ON CONFLICT(type, year) DO NOTHING').run(type, year);
    db.prepare('UPDATE document_sequences SET last_value = last_value + 1 WHERE type = ? AND year = ?').run(type, year);
    const { last_value: seq } = db.prepare('SELECT last_value FROM document_sequences WHERE type = ? AND year = ?').get(type, year);
    return formatNumber(type, year, seq);
  })();
}
