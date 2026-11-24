import { assertSupportedNode } from './runtime.js';

// Check the Node version BEFORE loading anything that imports node:sqlite: on an older Node that import would fail with a confusing
// "unknown builtin module" error, so the app is loaded dynamically after the check passes.
assertSupportedNode();

const { default: app } = await import('./app.js');
const { config } = await import('./config/index.js');
const { startAutomation } = await import('./automation/worker.js');
const { mailConfigWarnings } = await import('./utils/mailer.js');
const { seedTaskLibrary } = await import('./services/taskLibrarySeed.js');

// Stage 09B: make sure the built-in task library exists (adds only what is missing; never overwrites an administrator's edits).
try { const r = seedTaskLibrary(); if (r.inserted) console.log(`[tasks] task library: ${r.inserted} template(s) added`); } catch (err) { console.error('[tasks] task library seeding failed:', err.message); }

const server = app.listen(config.port, () => {
  console.log(`ELVORA API listening on :${config.port}`);
  for (const w of mailConfigWarnings()) console.warn(`[mail] ${w}`);
  startAutomation(); // offer letters, certificates (after admin approval) and document e-mails run in the background
});

// Graceful shutdown (hosting platforms send SIGTERM on every deploy/restart): stop accepting requests, flush the SQLite WAL, then exit.
const { db } = await import('./db/index.js');
const shutdown = (signal) => {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(() => { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ } process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
