// Consistent, non-destructive SQLite backup (works while the API is running). Usage:
//   node server/scripts/backup-db.mjs [outputDir]
// Reads DATABASE_URL (default file:./data/elevora.db, relative to /server). Never overwrites an existing file, never deletes anything.
// It copies ONLY the database. Back up DOCUMENTS_DIR and PAYMENT_PROOF_DIR separately (see docs/DEPLOYMENT.md).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.DATABASE_URL || 'file:./data/elevora.db';
if (/:memory:/.test(url)) { console.error('DATABASE_URL is an in-memory database: nothing to back up.'); process.exit(1); }
const src = path.resolve(serverRoot, url.replace(/^(file|sqlite):(\/\/)?/, ''));
const outDir = path.resolve(process.argv[2] || path.join(serverRoot, 'backups'));
if (!fs.existsSync(src)) { console.error('Database file not found.'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, `elvora-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
if (fs.existsSync(dest)) { console.error('Backup file already exists; refusing to overwrite.'); process.exit(1); }

const db = new DatabaseSync(src, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} finally { db.close(); }
const check = new DatabaseSync(dest, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
check.close();
if (!ok) { console.error('Backup written but FAILED the integrity check. Do not rely on it.'); process.exit(2); }
fs.chmodSync(dest, 0o600);
console.log(`Backup OK (integrity verified): ${dest}`);
