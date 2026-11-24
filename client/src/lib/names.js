// Display helpers for the signed-in student's name.
export const firstName = (fullName = '') => fullName.trim().split(/\s+/)[0] || 'there';
export function initials(fullName = '') {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
