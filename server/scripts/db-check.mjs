// Stage 08A — read-only database integrity check. Usage: node server/scripts/db-check.mjs  (uses DB_PATH like the server does)
// Reports foreign-key enforcement, PRAGMA foreign_key_check, PRAGMA integrity_check and a few relationship orphan counts.
// It does not modify data (importing the db module applies any pending migrations, exactly as server start does).
import { db } from '../src/db/index.js';

const out = [];
const rec = (name, ok, detail = '') => { out.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` | ${detail}` : ''}`); };

rec('foreign_keys enforcement is ON', db.pragma('foreign_keys', { simple: true }) === 1);
const integrity = db.pragma('integrity_check');
rec('PRAGMA integrity_check', integrity.length === 1 && integrity[0].integrity_check === 'ok', JSON.stringify(integrity).slice(0, 120));
const fk = db.pragma('foreign_key_check');
rec('PRAGMA foreign_key_check (no violations)', fk.length === 0, `${fk.length} violation(s)`);

const count = (sql) => db.prepare(sql).get().n;
const checks = {
  'applications without a student': 'SELECT COUNT(*) n FROM applications a LEFT JOIN students s ON s.id = a.student_id WHERE s.id IS NULL',
  'enrollments without an application': 'SELECT COUNT(*) n FROM enrollments e LEFT JOIN applications a ON a.id = e.application_id WHERE a.id IS NULL',
  'enrollments whose student differs from their application\'s student': 'SELECT COUNT(*) n FROM enrollments e JOIN applications a ON a.id = e.application_id WHERE a.student_id <> e.student_id',
  'documents whose enrollment/student/application disagree': 'SELECT COUNT(*) n FROM documents d JOIN enrollments e ON e.id = d.enrollment_id WHERE e.student_id <> d.student_id OR e.application_id <> d.application_id',
  'notifications without a student': 'SELECT COUNT(*) n FROM notifications n2 LEFT JOIN students s ON s.id = n2.student_id WHERE s.id IS NULL',
  'applications whose internship_id has no listing (informational: snapshot design)': 'SELECT COUNT(*) n FROM applications a LEFT JOIN internship_listings l ON l.id = a.internship_id WHERE l.id IS NULL',
};
for (const [label, sql] of Object.entries(checks)) {
  const n = count(sql);
  // The last check is informational only: applications keep a snapshot of the listing and are not tied to it by a foreign key on purpose.
  rec(label, label.includes('informational') ? true : n === 0, `${n} row(s)`);
}
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_applications_internship','idx_applications_status','idx_enrollments_status')").all().map((r) => r.name);
rec('Stage 08A indexes present', idx.length === 3, idx.join(', '));
process.exit(out.every((o) => o.ok) ? 0 : 1);
