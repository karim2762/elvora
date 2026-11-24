import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { github, GitHubError } from './client.js';
import { isAppReady } from './config.js';

// Stage 09C — GitHub App authentication. The App's private key signs a 9-minute JWT; the JWT is exchanged for a ONE-HOUR installation
// token that is cached in memory only (never stored, never logged) and refreshed 2 minutes before it expires, or immediately when GitHub
// reports it invalid.
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
export function createAppJwt(nowSec = Math.floor(Date.now() / 1000)) {
  if (!isAppReady()) throw new GitHubError('GITHUB_NOT_CONFIGURED', 'GitHub integration is not set up yet.');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: nowSec - 60, exp: nowSec + 540, iss: config.github.appId })}`;
  try { return `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), config.github.privateKey).toString('base64url')}`; }
  catch { throw new GitHubError('GITHUB_NOT_CONFIGURED', 'The GitHub App private key is not valid. Ask an administrator to check the GitHub setup.'); } // never echo the key or the library message
}

let installation = null; // { id, permissions, selection, checkedAt }
let tokenCache = null; // { token, expiresAt }
export const resetAppCache = () => { installation = null; tokenCache = null; };
export const knownInstallationId = () => installation?.id ?? null;
export const invalidateInstallationToken = () => { tokenCache = null; };

export async function getInstallation({ force = false } = {}) {
  if (!isAppReady()) throw new GitHubError('GITHUB_NOT_CONFIGURED', 'GitHub integration is not set up yet.');
  if (installation && !force && Date.now() - installation.checkedAt < 10 * 60_000) return installation;
  let r;
  try { r = await github({ path: `/orgs/${encodeURIComponent(config.github.organization)}/installation`, token: createAppJwt() }); }
  catch (err) {
    if (err.code === 'GITHUB_NOT_FOUND') throw new GitHubError('GITHUB_INSTALLATION_MISSING', 'The ELVORA GitHub App is not installed on the configured organization.');
    if (err.code === 'GITHUB_AUTH_INVALID') throw new GitHubError('GITHUB_NOT_CONFIGURED', 'GitHub did not accept the GitHub App credentials. Ask an administrator to check the GitHub setup.');
    throw err;
  }
  const d = r.data ?? {};
  if (String(d.account?.login ?? '').toLowerCase() !== config.github.organization.toLowerCase() || d.account?.type !== 'Organization') throw new GitHubError('GITHUB_INSTALLATION_MISSING', 'The GitHub App is not installed on the configured organization.');
  if (d.suspended_at) throw new GitHubError('GITHUB_INSTALLATION_MISSING', 'The GitHub App installation is suspended.');
  installation = { id: d.id, permissions: d.permissions ?? {}, selection: d.repository_selection ?? null, checkedAt: Date.now() };
  return installation;
}

export async function getInstallationToken() {
  if (tokenCache && tokenCache.expiresAt - Date.now() > 120_000) return tokenCache.token;
  const inst = await getInstallation();
  let r;
  try { r = await github({ method: 'POST', path: `/app/installations/${inst.id}/access_tokens`, token: createAppJwt(), body: {} }); }
  catch (err) { if (err.code === 'GITHUB_NOT_FOUND') { installation = null; throw new GitHubError('GITHUB_INSTALLATION_MISSING', 'The GitHub App is not installed on the configured organization.'); } throw err; }
  tokenCache = { token: r.data.token, expiresAt: Date.parse(r.data.expires_at) || Date.now() + 3_000_000 };
  return tokenCache.token;
}

// Runs fn(token). If GitHub says the token is no longer valid (expired early, revoked), fetch a fresh one and try ONCE more.
export async function withInstallation(fn) {
  try { return await fn(await getInstallationToken()); }
  catch (err) { if (err.code !== 'GITHUB_AUTH_INVALID') throw err; invalidateInstallationToken(); return fn(await getInstallationToken()); }
}
