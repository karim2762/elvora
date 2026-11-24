// Helpers that carry the selected internship through login/signup and back to the application.
export const detailPath = (id) => `/internships/${encodeURIComponent(id)}`;
export const applyPath = (id) => `/apply/${encodeURIComponent(id)}`;
export const applicationPath = (id) => `/student/applications/${encodeURIComponent(id)}`;
export const applicationSubmittedPath = (id) => `/applications/${encodeURIComponent(id)}/submitted`;
export const loginLink = (redirect) => `/login?redirect=${encodeURIComponent(redirect)}`;
export const signupLink = (redirect) => `/signup?redirect=${encodeURIComponent(redirect)}`;

// Only allow same-site absolute paths to avoid open redirects.
export function safeRedirect(value, fallback = '/') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : fallback;
}
export function internshipIdFromRedirect(value) {
  const m = /^\/apply\/([^/?#]+)/.exec(safeRedirect(value, ''));
  return m ? decodeURIComponent(m[1]) : null;
}
