import { config } from '../config/index.js';

// Stage 09C — the ONLY place that talks to api.github.com. Responsibilities: timeouts, retries of temporary failures, rate-limit
// detection, and turning every failure into a GitHubError whose message is safe to show. Response bodies, tokens and keys are never
// copied into an error message or a log line.
export class GitHubError extends Error {
  constructor(code, message, { status = null, data = null, retryAt = null } = {}) { super(message); this.code = code; this.status = status; this.data = data; this.retryAt = retryAt; }
}
let fetchImpl = (...a) => globalThis.fetch(...a);
export const setFetch = (fn) => { fetchImpl = fn ?? ((...a) => globalThis.fetch(...a)); }; // tests inject a mock; production never calls this
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const setSleep = (fn) => { sleep = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms))); };

const MAX_ATTEMPTS = 3;
export async function github({ method = 'GET', path, token, body, headers = {}, base = config.github.apiUrl }) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method, signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ELVORA-Internship-Platform', ...(token ? { Authorization: `${token.startsWith('Basic ') ? '' : 'Bearer '}${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      last = new GitHubError('GITHUB_UNAVAILABLE', 'GitHub could not be reached. Please try again in a few minutes.');
      if (attempt < MAX_ATTEMPTS) { await sleep(250 * attempt); continue; }
      throw last;
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.ok) return { status: res.status, data, headers: res.headers };
    if (res.status >= 500) {
      last = new GitHubError('GITHUB_UNAVAILABLE', 'GitHub is having problems right now. Please try again in a few minutes.', { status: res.status });
      if (attempt < MAX_ATTEMPTS) { await sleep(250 * attempt); continue; }
      throw last;
    }
    const remaining = res.headers.get('x-ratelimit-remaining'); const reset = Number(res.headers.get('x-ratelimit-reset')); const retryAfter = Number(res.headers.get('retry-after'));
    if (res.status === 429 || (res.status === 403 && (remaining === '0' || Number.isFinite(retryAfter) && retryAfter > 0 || /rate limit|abuse/i.test(String(data?.message ?? ''))))) {
      const retryAt = Number.isFinite(retryAfter) && retryAfter > 0 ? new Date(Date.now() + retryAfter * 1000).toISOString() : Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
      throw new GitHubError('GITHUB_RATE_LIMITED', 'GitHub is limiting requests right now. Please try again in a few minutes.', { status: res.status, retryAt });
    }
    if (res.status === 401) throw new GitHubError('GITHUB_AUTH_INVALID', 'GitHub did not accept the saved authorization.', { status: 401 });
    if (res.status === 403) throw new GitHubError('GITHUB_FORBIDDEN', 'GitHub denied access to this resource.', { status: 403, data });
    if (res.status === 404) throw new GitHubError('GITHUB_NOT_FOUND', 'GitHub could not find this resource, or access to it is not allowed.', { status: 404 });
    if (res.status === 409 || res.status === 422) throw new GitHubError('GITHUB_CONFLICT', 'GitHub rejected the request.', { status: res.status, data });
    throw new GitHubError('GITHUB_ERROR', 'GitHub returned an unexpected answer.', { status: res.status });
  }
  throw last;
}
