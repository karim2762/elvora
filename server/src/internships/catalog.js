import * as listings from '../db/internshipListings.js';

// Server-side source of truth for "does this internship exist, and is it open?".
// Stage 07B: backed by the internship_listings table (managed by administrators). The first run imported the existing catalogue
// (migration 10). Callers still only use getInternship() and effectiveStatus().
// An unpublished or archived listing does not exist as far as students are concerned; a deactivated one exists but is closed.
export function getInternship(id) {
  const l = listings.findById(id);
  if (!l || !l.published || l.archivedAt) return null;
  return { id: l.id, title: l.title, category: l.category, durationDays: l.durationDays, description: l.description,
    status: l.active ? l.status : 'closed', deadline: l.deadline, seats: l.seats };
}

// Same rule as the client: an "open" internship closes at the end of its deadline day (India Standard Time).
export function effectiveStatus(item, now = new Date()) {
  if (item.status === 'open' && item.deadline && now > new Date(`${item.deadline}T23:59:59+05:30`)) return 'closed';
  return item.status;
}

// Number of (non-archived) internship listings (admin overview).
export const catalogSize = () => listings.count();
