// Calendar-date helpers (YYYY-MM-DD strings). "Today" is India time, matching the application deadline rule.
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isValidDate = (v) => {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
export const todayIST = (now = new Date()) => new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
export const addDays = (v, n) => new Date(new Date(`${v}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

// How far back an administrator may place an internship start date.
export const MAX_BACKDATE_DAYS = 90;
export const earliestStartDate = (now = new Date()) => addDays(todayIST(now), -MAX_BACKDATE_DAYS);
// Returns an error message when `start` is further back than the limit, otherwise null.
export const backdateError = (start, now = new Date()) => (start < earliestStartDate(now)
  ? `The start date can’t be more than ${MAX_BACKDATE_DAYS} days in the past (earliest allowed: ${earliestStartDate(now)}).` : null);
