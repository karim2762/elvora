// Stage 09B (Part 2A) — pure syntax check of a GitHub repository address. It answers ONE question: "is this text shaped like
// https://github.com/<owner>/<repository>?" It never contacts GitHub, so it proves nothing about whether the repository exists,
// who owns it or what it contains (that verification is Stage 09C; see services/githubIntegration.js).
const OWNER_RE = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// First path segments that are GitHub site pages, not accounts.
const RESERVED_OWNERS = new Set(['about', 'account', 'apps', 'collections', 'contact', 'events', 'explore', 'features', 'issues', 'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'search', 'security', 'settings', 'signup', 'sponsors', 'topics', 'users']);

const clean = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '');

// Returns { value: { url, owner, repo } | null } for empty input, or { error }. The URL is normalised (https, github.com, no
// trailing slash or ".git"), so the same repository always compares equal.
export function parseGitHubRepoUrl(input, label = 'GitHub repository link') {
  const raw = clean(input);
  if (!raw) return { value: null };
  if (raw.length > 300) return { error: `${label} must be 300 characters or fewer` };
  const shape = `${label} must look like https://github.com/your-username/your-repository`;
  let u;
  try { u = new URL(raw); } catch { return { error: shape }; }
  if (u.protocol !== 'https:') return { error: `${label} must start with https://` };
  if (u.username || u.password) return { error: `${label} must not contain a username or password` };
  if (!['github.com', 'www.github.com'].includes(u.hostname.toLowerCase()) || u.port) return { error: `${label} must be on github.com` };
  if (u.search || u.hash) return { error: `${label} must be the repository’s main address, without ? or # parts` };
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return { error: parts.length > 2 ? `${label} must point to the repository itself, not a folder, file, branch or page inside it` : shape };
  const [owner, rawRepo] = parts;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase()) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return { error: shape };
  return { value: { url: `https://github.com/${owner}/${repo}`, owner, repo } };
}
