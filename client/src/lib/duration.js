import { durations } from '../config/site';

// Days -> label. Uses configured labels, falls back to a sensible generic label.
export function formatDuration(days) {
  const hit = durations.find((d) => d.days === days);
  if (hit) return hit.label;
  if (days % 30 === 0) return `${days / 30} Months`;
  if (days % 7 === 0) return `${days / 7} Weeks`;
  return `${days} Days`;
}
