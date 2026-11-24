import { HttpError, notFound } from '../utils/errors.js';
import { parseListing } from '../utils/validation.js';
import { effectiveStatus } from '../internships/catalog.js';
import * as repo from '../db/internshipListings.js';
import { LISTING_ACTIONS } from '../internships/categories.js';
import { db } from '../db/index.js';
import { record as audit } from '../db/audit.js';

// Stage 07B — business rules for administrator-managed internship listings. Routes only parse input and call these.
const who = (admin) => admin?.fullName ?? (admin?.via === 'key' ? 'Admin API key' : 'admin');
const conflict = (message, code) => new HttpError(409, message, { code });
const LISTING_ID_RE = /^ELV-[A-Z]{1,3}-\d{3,}$/;

function load(id) {
  const l = LISTING_ID_RE.test(String(id)) ? repo.findById(id) : null;
  if (!l) throw notFound('Internship not found', 'LISTING_NOT_FOUND');
  return l;
}
const duplicateCheck = (v, excludeId) => {
  const d = repo.findDuplicate({ title: v.title, durationDays: v.durationDays, excludeId });
  if (d) throw new HttpError(409, `An internship titled “${d.title}” with this duration already exists (${d.id}).`, { code: 'DUPLICATE_LISTING', fields: { title: 'This title is already used for the same duration' } });
};

export const toAdminView = (l, applicationCount = repo.applicationCount(l.id)) => {
  const { extra: _x, createdBy: _c, ...rest } = l;
  return { ...rest, applicationCount, canDelete: applicationCount === 0, acceptingApplications: !l.archivedAt && l.published && l.active && effectiveStatus({ status: l.status, deadline: l.deadline }) === 'open' };
};

export function createListing(body, admin) {
  const v = parseListing(body, { creating: true });
  duplicateCheck(v, null);
  return db.transaction(() => { // the listing and its audit row commit together
    const l = repo.insert(v, who(admin));
    audit({ admin, action: 'listing.create', targetType: 'listing', targetId: l.id, reason: l.title });
    return toAdminView(l, 0); // always created as an unpublished draft
  })();
}

export function editListing(id, body, admin) {
  const current = load(id);
  if (current.archivedAt) throw conflict('Archived internships can’t be edited. Restore it first.', 'LISTING_ARCHIVED');
  const merged = { ...current, ...(body && typeof body === 'object' ? body : {}) };
  merged.eligibility = { ...current.eligibility, ...(body?.eligibility && typeof body.eligibility === 'object' ? body.eligibility : {}) };
  const v = parseListing(merged);
  if (v.category !== current.category && repo.applicationCount(id) > 0) {
    throw new HttpError(409, 'The category can’t change once students have applied (the ID and history are tied to it).', { code: 'CATEGORY_LOCKED', fields: { category: 'Locked because applications exist' } });
  }
  duplicateCheck(v, id);
  return db.transaction(() => {
    const l = repo.update(id, v, who(admin));
    audit({ admin, action: 'listing.update', targetType: 'listing', targetId: id, reason: l.title });
    return toAdminView(l);
  })();
}

export function applyAction(id, action, admin) {
  if (!LISTING_ACTIONS.includes(action)) throw new HttpError(400, 'Unknown action', { code: 'VALIDATION', fields: { action: `Action must be one of: ${LISTING_ACTIONS.join(', ')}` } });
  const l = load(id);
  const by = who(admin);
  const flags = {
    publish: () => { if (l.archivedAt) throw conflict('Restore this archived internship before publishing it.', 'LISTING_ARCHIVED'); if (l.published) throw conflict('Already published.', 'NO_CHANGE'); return { is_published: 1 }; },
    unpublish: () => { if (!l.published) throw conflict('Already unpublished.', 'NO_CHANGE'); return { is_published: 0 }; },
    activate: () => { if (l.archivedAt) throw conflict('Restore this archived internship first.', 'LISTING_ARCHIVED'); if (l.active) throw conflict('Already active.', 'NO_CHANGE'); return { is_active: 1 }; },
    deactivate: () => { if (!l.active) throw conflict('Already inactive.', 'NO_CHANGE'); return { is_active: 0 }; },
    // Archiving hides the listing from students and stops applications, but keeps the record and every application that references it.
    archive: () => { if (l.archivedAt) throw conflict('Already archived.', 'NO_CHANGE'); return { archived_at: new Date().toISOString(), is_published: 0, is_active: 0 }; },
    restore: () => { if (!l.archivedAt) throw conflict('This internship is not archived.', 'NO_CHANGE'); return { archived_at: null }; }, // comes back unpublished and inactive: re-publish deliberately
  }[action]();
  return db.transaction(() => {
    const l = repo.setFlags(id, flags, by);
    audit({ admin, action: `listing.${action}`, targetType: 'listing', targetId: id, reason: l.title });
    return toAdminView(l);
  })();
}

// Hard delete is only allowed when nothing references the listing. Otherwise the caller is told to archive instead.
export function deleteListing(id, admin = null) {
  const l = load(id);
  const n = repo.applicationCount(id);
  if (n > 0) throw new HttpError(409, `This internship has ${n} application${n === 1 ? '' : 's'}, so it can’t be deleted. Archive it instead to keep the history.`, { code: 'LISTING_IN_USE', details: { applications: n } });
  if (l.published && !l.archivedAt) throw conflict('Unpublish or archive this internship before deleting it.', 'LISTING_PUBLISHED');
  db.transaction(() => {
    if (!repo.remove(id)) throw notFound('Internship not found', 'LISTING_NOT_FOUND');
    audit({ admin, action: 'listing.delete', targetType: 'listing', targetId: id, reason: l.title });
  })();
}

export const getListing = (id) => toAdminView(load(id));

// Public shape: what the student-facing site renders (same fields as the original demo records).
export function toPublic(l, now = new Date()) {
  const x = l.extra ?? {};
  const status = l.active ? effectiveStatus({ status: l.status, deadline: l.deadline }, now) : 'closed';
  return {
    id: l.id, title: l.title, category: l.category, description: l.description, overview: x.overview ?? l.description,
    durationDays: l.durationDays, difficulty: l.difficulty, type: l.type, skills: l.skills, technologies: x.technologies ?? [],
    outcomes: l.outcomes, keywords: x.keywords ?? [],
    eligibility: { who: l.eligibility.who ?? '', knowledge: l.eligibility.knowledge ?? [], academic: l.eligibility.academic ?? '' },
    structure: x.structure ?? { plan: [], project: '', assessment: '', completion: [] },
    certificate: x.certificate ?? 'A completion certificate is issued after you meet all completion requirements and your submission has been reviewed.',
    status, seats: l.seats, featured: l.featured, postedAt: x.postedAt ?? l.createdAt.slice(0, 10), deadline: l.deadline,
  };
}
export const listPublic = () => repo.listPublic().map((l) => toPublic(l));
export const getPublic = (id) => { const l = repo.findById(id); return l && l.published && !l.archivedAt ? toPublic(l) : null; };
