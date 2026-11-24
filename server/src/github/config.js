import { config } from '../config/index.js';

// Stage 09C — what is configured, in three independent groups, so a half-configured server degrades feature by feature instead of
// failing. Only booleans and the NAMES of missing variables leave this file; values are never returned.
export const REQUIRED_APP_PERMISSIONS = Object.freeze({
  administration: 'write', // create repositories in the organisation
  contents: 'write', // write the starter files; read files and commits for inspection
  metadata: 'read', // mandatory for every GitHub App
  members: 'write', // only when GITHUB_REVIEW_TEAM is used (add repositories to the review team)
});
const g = () => config.github;
export function setup() {
  const c = g();
  const oauthMissing = [!c.clientId && 'GITHUB_CLIENT_ID', !c.clientSecret && 'GITHUB_CLIENT_SECRET', !c.callbackUrl && 'GITHUB_CALLBACK_URL'].filter(Boolean);
  const appMissing = [!c.appId && 'GITHUB_APP_ID', !c.privateKey && 'GITHUB_APP_PRIVATE_KEY', !c.organization && 'GITHUB_ORGANIZATION'].filter(Boolean);
  const webhookMissing = c.webhookSecret ? [] : ['GITHUB_WEBHOOK_SECRET'];
  return {
    oauth: { ready: !oauthMissing.length, missing: oauthMissing },
    app: { ready: !appMissing.length, missing: appMissing },
    webhook: { ready: !webhookMissing.length, missing: webhookMissing },
  };
}
export const isOauthReady = () => setup().oauth.ready;
export const isAppReady = () => setup().app.ready;
// What a student may be told: no variable names, no organisation, nothing that helps an attacker.
export function publicState() {
  const s = setup();
  return { state: s.oauth.ready || s.app.ready ? (s.oauth.ready && s.app.ready ? 'ready' : 'partial') : 'setup_required', canConnectAccount: s.oauth.ready, canCreateRepositories: s.app.ready };
}
