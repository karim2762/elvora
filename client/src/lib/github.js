// Stage 09B Part 2A — browser-side check of a GitHub repository address, for instant feedback only. It mirrors server/src/utils/github.js,
// and the SERVER repeats every check (the browser is never trusted). It never contacts GitHub, so it cannot say a repository exists.
const OWNER_RE = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const RESERVED = new Set(['about', 'account', 'apps', 'collections', 'contact', 'events', 'explore', 'features', 'issues', 'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'search', 'security', 'settings', 'signup', 'sponsors', 'topics', 'users']);

export function githubRepoError(input, { required = false } = {}) {
  const raw = (input ?? '').trim();
  if (!raw) return required ? 'Enter your GitHub repository link' : '';
  const shape = 'Use the form https://github.com/your-username/your-repository';
  if (raw.length > 300) return 'The link must be 300 characters or fewer';
  let u;
  try { u = new URL(raw); } catch { return shape; }
  if (u.protocol !== 'https:') return 'The link must start with https://';
  if (u.username || u.password) return 'The link must not contain a username or password';
  if (!['github.com', 'www.github.com'].includes(u.hostname.toLowerCase()) || u.port) return 'The link must be on github.com';
  if (u.search || u.hash) return 'Use the repository’s main address, without ? or # parts';
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length > 2) return 'Link to the repository itself, not a folder, file, branch or page inside it';
  if (parts.length !== 2) return shape;
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER_RE.test(parts[0]) || RESERVED.has(parts[0].toLowerCase()) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return shape;
  return '';
}

export function httpsUrlError(input, { required = false, label = 'The link' } = {}) {
  const raw = (input ?? '').trim();
  if (!raw) return required ? `${label} is required` : '';
  if (raw.length > 300) return `${label} must be 300 characters or fewer`;
  let u;
  try { u = new URL(raw); } catch { return `${label} must be a full web address starting with https://`; }
  if (u.protocol !== 'https:') return `${label} must start with https://`;
  if (u.username || u.password) return `${label} must not contain a username or password`;
  if (!u.hostname.includes('.')) return `${label} must be a full web address`;
  return '';
}
