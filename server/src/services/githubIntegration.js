// Stage 09B (Part 2A) — the ONLY seam between submissions and GitHub. Today ELVORA stores a repository address the student typed
// and checks its SHAPE; it does not talk to GitHub. Stage 09C replaces `manualProvider` with a real provider by calling
// setProvider(). Nothing in 2A reports a repository as verified, and no screen shows a verification indicator.
//
// Provider contract (all methods async; each returns a plain object; none may throw for "not verified"):
//   verifyOwnership({ owner, repo, student })  -> { verified: boolean, reason?: string }
//   inspectRepository({ owner, repo })         -> { commitCount?: number, hasReadme?: boolean, ... }   (read-only)
//   createRepository({ name, student })        -> { url }       (ELVORA organisation namespace, subject to 09C authorisation)
import { parseGitHubRepoUrl } from '../utils/github.js';

const NOT_AVAILABLE = { verified: false, reason: 'GitHub integration is not available until Stage 09C.' };
export const manualProvider = Object.freeze({
  name: 'manual', capabilities: Object.freeze({ verifyOwnership: false, inspectRepository: false, createRepository: false }),
  verifyOwnership: async () => NOT_AVAILABLE,
  inspectRepository: async () => ({}),
  createRepository: async () => { throw new Error('Repository creation is not available until Stage 09C.'); },
});

let provider = manualProvider;
export const getProvider = () => provider;
export function setProvider(next) { provider = next ?? manualProvider; }
// The one place submission code asks "what repository is this?". Syntax only.
export const describeRepository = (url) => parseGitHubRepoUrl(url).value ?? null;
