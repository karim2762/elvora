import { HttpError } from '../utils/errors.js';
import { GitHubError } from './client.js';

// Stage 09C — one translation point from internal GitHub failures to answers a student/administrator can read. Nothing from the upstream
// response body, a token, a key or a stack trace is ever copied into the answer.
const MAP = {
  GITHUB_NOT_CONFIGURED: [503, 'GitHub integration is not set up yet. Please contact ELVORA support.'],
  GITHUB_INSTALLATION_MISSING: [503, 'GitHub integration is not fully set up yet (the ELVORA GitHub App is not installed). Please contact ELVORA support.'],
  GITHUB_UNAVAILABLE: [502, 'GitHub is not reachable right now. Please try again in a few minutes.'],
  GITHUB_RATE_LIMITED: [429, 'GitHub is limiting requests right now. Please try again in a few minutes.'],
  GITHUB_AUTH_INVALID: [409, 'Your GitHub authorization is no longer valid. Please reconnect your GitHub account.'],
  GITHUB_FORBIDDEN: [403, 'GitHub did not allow this action.'],
  GITHUB_NOT_FOUND: [404, 'That repository was not found, or ELVORA does not have access to it.'],
  GITHUB_CONFLICT: [409, 'GitHub could not complete the request.'],
  REPOSITORY_EXISTS: [409, 'A repository with this name already exists in the organization and was not created for this task. Please contact ELVORA support.'],
  GITHUB_ERROR: [502, 'GitHub returned an unexpected answer. Please try again later.'],
};
export function asHttp(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof GitHubError) {
    const [status, message] = MAP[err.code] ?? MAP.GITHUB_ERROR;
    return new HttpError(status, message, { code: err.code, details: err.retryAt ? { retryAt: err.retryAt } : undefined });
  }
  console.error('[github] unexpected failure:', err?.name ?? 'Error'); // name only: messages can contain request details
  return new HttpError(500, 'Something went wrong with GitHub integration. Please try again later.', { code: 'GITHUB_INTERNAL' });
}
