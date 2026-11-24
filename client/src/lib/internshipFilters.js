import { domainBySlug, activeDurations } from '../config/site';
import { difficultyLevels, internshipTypes, sortOptions, DEFAULT_SORT } from '../config/internships';

const KEYS = ['q', 'category', 'duration', 'difficulty', 'type'];

// URL params -> validated filter object (invalid values are ignored).
export function readFilters(params) {
  const pick = (key, allowed) => { const v = params.get(key) || ''; return allowed.includes(v) ? v : ''; };
  const sort = params.get('sort');
  return {
    q: (params.get('q') || '').slice(0, 80),
    category: domainBySlug(params.get('category')) ? params.get('category') : '',
    duration: pick('duration', activeDurations.map((d) => String(d.days))),
    difficulty: pick('difficulty', difficultyLevels),
    type: pick('type', internshipTypes),
    sort: sortOptions.some((o) => o.value === sort) ? sort : DEFAULT_SORT,
  };
}

// Returns new URLSearchParams with one key changed (empty/default removes it).
export function withFilter(params, key, value) {
  const next = new URLSearchParams(params);
  if (!value || (key === 'sort' && value === DEFAULT_SORT)) next.delete(key); else next.set(key, value);
  return next;
}
export function clearFilters(params) {
  const next = new URLSearchParams(params);
  KEYS.forEach((k) => next.delete(k));
  return next;
}
export const panelFilterCount = (f) => ['category', 'duration', 'difficulty', 'type'].filter((k) => f[k]).length;
export const hasActiveFilters = (f) => KEYS.some((k) => f[k]);

export function effectiveStatus(item, now = new Date()) {
  if (item.status === 'open' && item.deadline) {
    const [y, m, d] = item.deadline.split('-').map(Number);
    if (new Date(y, m - 1, d, 23, 59, 59) < now) return 'closed';
  }
  return item.status;
}

const haystack = (i) => [i.title, domainBySlug(i.category)?.title, i.description, i.difficulty, i.type, ...i.skills, ...i.technologies, ...(i.keywords || [])].join(' ').toLowerCase();

// All filters combine (AND). Every search word must appear somewhere in the searchable text.
export function filterInternships(list, f) {
  const tokens = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((i) =>
    (!f.category || i.category === f.category) &&
    (!f.duration || String(i.durationDays) === f.duration) &&
    (!f.difficulty || i.difficulty === f.difficulty) &&
    (!f.type || i.type === f.type) &&
    (tokens.length === 0 || tokens.every((t) => haystack(i).includes(t))));
}

export function sortInternships(list, sort) {
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const cmp = {
    newest: (a, b) => b.postedAt.localeCompare(a.postedAt) || byTitle(a, b),
    oldest: (a, b) => a.postedAt.localeCompare(b.postedAt) || byTitle(a, b),
    shortest: (a, b) => a.durationDays - b.durationDays || byTitle(a, b),
    longest: (a, b) => b.durationDays - a.durationDays || byTitle(a, b),
    az: byTitle,
  }[sort] || byTitle;
  return [...list].sort(cmp);
}
