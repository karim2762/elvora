// Stage 08A — minimum runtime check. The database layer uses the built-in `node:sqlite` module, which exists only from Node 22.5 and is
// available WITHOUT the --experimental-sqlite flag from Node 22.13 (22.x line) / 23.4. package.json "engines" says the same: >=22.13.0.
export const MIN_NODE = [22, 13, 0];

export function nodeVersionProblem(version = process.versions.node) {
  const have = String(version).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const bad = `ELVORA needs Node.js 22.13 or newer (22.x), or 23.4 or newer (it uses the built-in node:sqlite module). You are running ${version}. Install a current Node 22 LTS (or newer) from https://nodejs.org and run \`npm install\` again.`;
  if (have[0] === 23 && (have[1] ?? 0) < 4) return bad; // node:sqlite needs --experimental-sqlite on 23.0 - 23.3
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) > MIN_NODE[i]) return null;
    if ((have[i] ?? 0) < MIN_NODE[i]) return `ELVORA needs Node.js ${MIN_NODE.join('.')} or newer (it uses the built-in node:sqlite module). You are running ${version}. Install a current Node 22 LTS (or newer) from https://nodejs.org and run \`npm install\` again.`;
  }
  return null;
}

export function assertSupportedNode() {
  const problem = nodeVersionProblem();
  if (problem) { console.error(`[runtime] ${problem}`); process.exit(1); }
}
