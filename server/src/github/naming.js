// Stage 09C — repository naming: elvora-[internship-code]-[student-public-id]-[project-slug]
// Only public identifiers are used: the internship listing code (ELV-PY-001) and the public journey ID of the enrollment (ELV-7K3Q9XMD).
// E-mail, phone, name and database IDs of the student never appear.
const seg = (s, max) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
export const REPO_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
export function repositoryName({ internshipId, enrollmentId, title, studentTaskId = null, disambiguate = false }) {
  const code = seg(internshipId, 30) || 'internship';
  const who = seg(enrollmentId, 20) || 'student';
  const suffix = disambiguate && studentTaskId ? `-${seg(String(studentTaskId).replace(/^STK-/i, ''), 8)}` : '';
  const head = `elvora-${code}-${who}-`;
  const room = Math.max(1, 100 - head.length - suffix.length);
  const slug = seg(title, Math.min(40, room)) || 'project';
  return `${head}${slug}${suffix}`.slice(0, 100).replace(/-+$/g, '');
}
