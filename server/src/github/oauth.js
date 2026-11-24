import { notifyGithub } from './notify.js';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import { HttpError } from '../utils/errors.js';
import { record as audit } from '../db/audit.js';
import * as gh from '../db/github.js';
import { github, GitHubError } from './client.js';
import { isOauthReady } from './config.js';
import { encrypt, decrypt, sha256, randomToken, pkceChallenge } from './crypto.js';

// Stage 09C — student GitHub account connection (GitHub's web-application flow with state + PKCE S256).
// Identity comes ONLY from GitHub's /user answer for the token GitHub issued to this authorization; a typed username proves nothing.
const STATE_TTL_MS = 10 * 60 * 1000;
// github.com/login/oauth/access_token answers form-encoded unless the request asks for JSON explicitly (the shared client's default Accept is the REST API media type).
const JSON_ACCEPT = { Accept: 'application/json' };
const actor = { actorName: 'Student (GitHub)' };
const conflict = (message, code) => new HttpError(409, message, { code });
const setupRequired = () => new HttpError(503, 'GitHub sign-in is not set up yet. Please contact ELVORA support.', { code: 'GITHUB_NOT_CONFIGURED' });

export function beginConnect(student) {
  if (!isOauthReady()) throw setupRequired();
  const existing = gh.findAccount(student.id);
  if (existing && existing.verificationStatus === 'verified') throw conflict('A GitHub account is already connected. Disconnect it first to connect a different one.', 'GITHUB_ALREADY_CONNECTED');
  const state = randomToken(32); const verifier = randomToken(48);
  gh.insertState({ stateHash: sha256(state), studentId: student.id, verifierEnc: encrypt(verifier), expiresAt: Date.now() + STATE_TTL_MS });
  const q = new URLSearchParams({ client_id: config.github.clientId, redirect_uri: config.github.callbackUrl, state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', allow_signup: 'false' });
  return { authorizeUrl: `https://github.com/login/oauth/authorize?${q}`, expiresInSeconds: STATE_TTL_MS / 1000 };
}

// Returns { ok: true, login } or throws an HttpError whose message is safe to show on the settings page.
export async function completeConnect(student, { code, state, error }) {
  if (!isOauthReady()) throw setupRequired();
  if (typeof state !== 'string' || state.length < 20 || state.length > 200) throw new HttpError(400, 'This GitHub sign-in link is not valid. Please start again.', { code: 'GITHUB_STATE_INVALID' });
  const row = gh.consumeState(sha256(state)); // single use, even when the rest fails
  if (!row || row.expiresAt < Date.now() || row.studentId !== student.id) throw new HttpError(400, 'This GitHub sign-in link has expired or does not belong to your session. Please start again.', { code: 'GITHUB_STATE_INVALID' });
  if (error) throw new HttpError(400, error === 'access_denied' ? 'GitHub access was not approved, so nothing was connected.' : 'GitHub did not complete the sign-in. Please try again.', { code: 'GITHUB_AUTH_DENIED' });
  if (typeof code !== 'string' || !code || code.length > 200) throw new HttpError(400, 'GitHub did not send an authorization code. Please try again.', { code: 'GITHUB_CODE_MISSING' });
  const verifier = decrypt(row.verifierEnc);
  if (!verifier) throw new HttpError(400, 'This GitHub sign-in could not be verified. Please start again.', { code: 'GITHUB_STATE_INVALID' });

  const tok = await github({ method: 'POST', base: 'https://github.com', path: '/login/oauth/access_token', headers: JSON_ACCEPT, body: { client_id: config.github.clientId, client_secret: config.github.clientSecret, code, redirect_uri: config.github.callbackUrl, code_verifier: verifier } });
  const t = tok.data ?? {};
  if (t.error || !t.access_token) throw new HttpError(400, 'GitHub did not accept the sign-in (the link may have expired). Please start again.', { code: 'GITHUB_CODE_REJECTED' });
  const me = (await github({ path: '/user', token: t.access_token })).data ?? {};
  if (!Number.isInteger(me.id) || typeof me.login !== 'string' || me.type !== 'User') throw new HttpError(400, 'Only personal GitHub accounts can be connected.', { code: 'GITHUB_ACCOUNT_TYPE' });

  const holder = gh.accountByGithubId(me.id);
  if (holder && holder.studentId !== student.id) throw conflict('This GitHub account is already connected to another ELVORA account.', 'GITHUB_ACCOUNT_IN_USE');
  try {
    // db.transaction is re-entrant; the audit row commits with the connection or not at all.
    db.transaction(() => {
      if (holder) gh.deleteAccount(student.id); // same student reconnecting after a revocation
      gh.saveAccount({ studentId: student.id, githubUserId: me.id, login: me.login, accountType: me.type, accessTokenEnc: encrypt(t.access_token), refreshTokenEnc: t.refresh_token ? encrypt(t.refresh_token) : null, tokenExpiresAt: t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000).toISOString() : null });
      audit({ ...actor, action: 'github.connect', targetType: 'github_account', targetId: student.id, reason: `Connected GitHub user ${me.login}` });
    })();
  } catch (err) {
    if (gh.isConstraint(err)) throw conflict('This GitHub account is already connected to another ELVORA account.', 'GITHUB_ACCOUNT_IN_USE');
    throw err;
  }
  notifyGithub('github_connected', { studentId: student.id, login: me.login, key: `${student.id}:${me.id}:${new Date().toISOString().slice(0, 10)}` });
  return { ok: true, login: me.login };
}

// A usable user token, refreshed when it is about to expire. Returns null (never throws) when the student has none.
export async function getUserToken(studentId) {
  const a = gh.findAccountWithTokens(studentId);
  if (!a || a.verificationStatus !== 'verified') return null;
  const access = decrypt(a.accessTokenEnc);
  const expiring = a.tokenExpiresAt && Date.parse(a.tokenExpiresAt) - Date.now() < 60_000;
  if (access && !expiring) return access;
  const refresh = decrypt(a.refreshTokenEnc);
  if (!refresh) { gh.markRevoked(a.githubUserId); return null; }
  try {
    const r = (await github({ method: 'POST', base: 'https://github.com', path: '/login/oauth/access_token', headers: JSON_ACCEPT, body: { client_id: config.github.clientId, client_secret: config.github.clientSecret, grant_type: 'refresh_token', refresh_token: refresh } })).data ?? {};
    if (r.error || !r.access_token) { gh.markRevoked(a.githubUserId); return null; }
    gh.updateTokens(studentId, { accessTokenEnc: encrypt(r.access_token), refreshTokenEnc: r.refresh_token ? encrypt(r.refresh_token) : null, tokenExpiresAt: r.expires_in ? new Date(Date.now() + Number(r.expires_in) * 1000).toISOString() : null });
    return r.access_token;
  } catch (err) { if (err instanceof GitHubError && err.code === 'GITHUB_AUTH_INVALID') gh.markRevoked(a.githubUserId); return null; }
}

export async function disconnect(student) {
  const a = gh.findAccountWithTokens(student.id);
  if (!a) throw new HttpError(404, 'No GitHub account is connected.', { code: 'GITHUB_NOT_CONNECTED' });
  const token = decrypt(a.accessTokenEnc);
  let revoked = false;
  if (token && isOauthReady()) { // best effort: remove ELVORA's grant on GitHub too; local removal never depends on it
    try { await github({ method: 'DELETE', path: `/applications/${encodeURIComponent(config.github.clientId)}/grant`, token: `Basic ${Buffer.from(`${config.github.clientId}:${config.github.clientSecret}`).toString('base64')}`, body: { access_token: token } }); revoked = true; }
    catch { revoked = false; }
  }
  db.transaction(() => {
    gh.deleteAccount(student.id);
    gh.resetOwnershipForStudent(student.id); // ownership proofs rested on this identity
    audit({ ...actor, action: 'github.disconnect', targetType: 'github_account', targetId: student.id, reason: `Disconnected GitHub user ${a.login}` });
  })();
  return { ok: true, revokedOnGitHub: revoked };
}

export function accountView(studentId) {
  const a = gh.findAccount(studentId);
  if (!a) return { connected: false, status: 'not_connected' };
  return { connected: a.verificationStatus === 'verified', status: a.verificationStatus === 'verified' ? 'connected' : 'authorization_revoked', login: a.login, profileUrl: `https://github.com/${a.login}`, verified: a.verificationStatus === 'verified', verifiedAt: a.verifiedAt, connectedAt: a.connectedAt };
}
