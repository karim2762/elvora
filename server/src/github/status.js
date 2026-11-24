import { config } from '../config/index.js';
import * as gh from '../db/github.js';
import { setup, publicState, REQUIRED_APP_PERMISSIONS } from './config.js';
import { getInstallation } from './app.js';
import { GitHubError } from './client.js';
import { accountView } from './oauth.js';

// Student view: connection + whether GitHub features are available. No variable names, organisation or permissions.
export const studentStatus = (studentId) => ({ integration: publicState(), account: accountView(studentId) });

// Administrator view: which settings are present (names only, never values) and, with live=true, a real check against GitHub.
export async function adminHealth({ live = false } = {}) {
  const s = setup();
  const out = {
    state: publicState().state, configuration: s,
    settings: { organization: config.github.organization || null, visibility: config.github.visibility, defaultPermission: config.github.defaultPermission, reviewTeam: config.github.reviewTeam || null },
    requiredAppPermissions: REQUIRED_APP_PERMISSIONS, live: null,
  };
  if (live && s.app.ready) {
    try {
      const inst = await getInstallation({ force: true });
      const missing = Object.entries(REQUIRED_APP_PERMISSIONS).filter(([k, v]) => (k !== 'members' || config.github.reviewTeam) && !(inst.permissions[k] === v || (v === 'read' && inst.permissions[k] === 'write'))).map(([k, v]) => `${k}:${v}`);
      out.live = { ok: !missing.length, installationFound: true, repositorySelection: inst.selection, missingPermissions: missing };
    } catch (err) { out.live = { ok: false, installationFound: false, error: err instanceof GitHubError ? err.code : 'GITHUB_ERROR' }; }
  } else if (live) out.live = { ok: false, error: 'GITHUB_NOT_CONFIGURED' };
  out.connectedStudents = gh.countAccounts?.() ?? undefined;
  return out;
}
