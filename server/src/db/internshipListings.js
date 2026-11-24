import { db } from './index.js';
import { CATEGORIES } from '../internships/categories.js';

// Stage 07B — all internship_listings SQL. Every value is bound as a parameter; LIKE wildcards in search are escaped.
const json = (v, d) => { try { return JSON.parse(v ?? ''); } catch { return d; } };
export const toListing = (r) => r && ({
  id: r.id, title: r.title, category: r.category, description: r.description, durationDays: r.duration_days,
  skills: json(r.skills, []), eligibility: json(r.eligibility, {}), outcomes: json(r.outcomes, []),
  type: r.type, difficulty: r.difficulty, seats: r.seats, deadline: r.deadline, status: r.status,
  published: !!r.is_published, active: !!r.is_active, featured: !!r.is_featured, archivedAt: r.archived_at,
  extra: json(r.extra, {}), createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by, updatedBy: r.updated_by,
});
const escapeLike = (v) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export const findById = (id) => (typeof id === 'string' ? toListing(db.prepare('SELECT * FROM internship_listings WHERE id = ?').get(id)) : null);
export const count = () => db.prepare('SELECT COUNT(*) AS n FROM internship_listings WHERE archived_at IS NULL').get().n;
export const applicationCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM applications WHERE internship_id = ?').get(id).n;
export const findDuplicate = ({ title, durationDays, excludeId = null }) =>
  toListing(db.prepare('SELECT * FROM internship_listings WHERE lower(title) = lower(?) AND duration_days = ? AND archived_at IS NULL AND id <> ?').get(title, durationDays, excludeId ?? ''));

// What the public site may show: published and not archived. (An inactive listing is shown as "closed" by the caller.)
export const listPublic = () => db.prepare('SELECT * FROM internship_listings WHERE is_published = 1 AND archived_at IS NULL ORDER BY created_at DESC, id').all().map(toListing);

const STATE_SQL = {
  published: 'l.is_published = 1 AND l.archived_at IS NULL', draft: 'l.is_published = 0 AND l.archived_at IS NULL',
  active: 'l.is_active = 1 AND l.archived_at IS NULL', inactive: 'l.is_active = 0 AND l.archived_at IS NULL', archived: 'l.archived_at IS NOT NULL',
};
export function pageForAdmin({ q = '', category = null, state = null, limit, offset }) {
  const where = []; const args = [];
  if (state && STATE_SQL[state]) where.push(STATE_SQL[state]); else where.push('l.archived_at IS NULL'); // archived ones only when asked for
  if (category) { where.push('l.category = ?'); args.push(category); }
  if (q) { const like = `%${escapeLike(q)}%`; where.push("(l.id LIKE ? ESCAPE '\\' OR l.title LIKE ? ESCAPE '\\')"); args.push(like, like); }
  const w = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM internship_listings l ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM applications a WHERE a.internship_id = l.id) AS application_count
      FROM internship_listings l ${w} ORDER BY l.created_at DESC, l.id LIMIT ? OFFSET ?`).all(...args, limit, offset)
    .map((r) => ({ ...toListing(r), applicationCount: r.application_count }));
  return { total, rows };
}
export function counts() {
  const r = db.prepare(`SELECT
      SUM(archived_at IS NULL) AS live, SUM(is_published = 1 AND archived_at IS NULL) AS published, SUM(is_published = 0 AND archived_at IS NULL) AS draft,
      SUM(is_active = 1 AND archived_at IS NULL) AS active, SUM(is_active = 0 AND archived_at IS NULL) AS inactive, SUM(archived_at IS NOT NULL) AS archived
    FROM internship_listings`).get();
  return { all: r.live ?? 0, published: r.published ?? 0, draft: r.draft ?? 0, active: r.active ?? 0, inactive: r.inactive ?? 0, archived: r.archived ?? 0 };
}

const params = (l) => ({
  title: l.title, category: l.category, description: l.description, days: l.durationDays, skills: JSON.stringify(l.skills),
  eligibility: JSON.stringify(l.eligibility), outcomes: JSON.stringify(l.outcomes), type: l.type, difficulty: l.difficulty,
  seats: l.seats, deadline: l.deadline, status: l.status, featured: l.featured ? 1 : 0,
});

// IDs follow the existing convention ELV-<PREFIX>-<3 digits>, e.g. ELV-PY-003. The next number is max+1 for that prefix.
export function insert(listing, adminName) {
  const prefix = CATEGORIES.find((c) => c.slug === listing.category).prefix;
  return db.transaction(() => {
    const now = new Date().toISOString();
    const re = new RegExp(`^ELV-${prefix}-(\\d+)$`);
    const max = db.prepare('SELECT id FROM internship_listings WHERE id LIKE ?').all(`ELV-${prefix}-%`).reduce((m, r) => Math.max(m, Number(re.exec(r.id)?.[1] ?? 0)), 0);
    const id = `ELV-${prefix}-${String(max + 1).padStart(3, '0')}`;
    db.prepare(`INSERT INTO internship_listings (id, title, category, description, duration_days, skills, eligibility, outcomes, type, difficulty, seats,
        deadline, status, is_published, is_active, is_featured, extra, created_at, updated_at, created_by, updated_by)
      VALUES (@id, @title, @category, @description, @days, @skills, @eligibility, @outcomes, @type, @difficulty, @seats, @deadline, @status, 0, 1, @featured, '{}', @now, @now, @by, @by)`)
      .run({ ...params(listing), id, now, by: adminName });
    return findById(id);
  })();
}
export function update(id, listing, adminName) {
  db.prepare(`UPDATE internship_listings SET title=@title, category=@category, description=@description, duration_days=@days, skills=@skills,
      eligibility=@eligibility, outcomes=@outcomes, type=@type, difficulty=@difficulty, seats=@seats, deadline=@deadline, status=@status,
      is_featured=@featured, updated_at=@now, updated_by=@by WHERE id=@id`).run({ ...params(listing), id, now: new Date().toISOString(), by: adminName });
  return findById(id);
}
export function setFlags(id, flags, adminName) {
  const sets = Object.keys(flags).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE internship_listings SET ${sets}, updated_at = @now, updated_by = @by WHERE id = @id`).run({ ...flags, id, now: new Date().toISOString(), by: adminName });
  return findById(id);
}
export const remove = (id) => db.prepare('DELETE FROM internship_listings WHERE id = ?').run(id).changes;
