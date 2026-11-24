import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';

// Secure storage driver. Today: a private folder on local disk (config.documentsDir). The rest of the system only calls
// put / exists / path / remove with an opaque random key, so another backend (object storage, a network drive) can replace
// this file without touching callers. Keys are random, never derived from user input, and never leave the server.
const fileFor = (key) => path.join(config.documentsDir, `${key}.pdf`);
export const newKey = () => crypto.randomBytes(24).toString('hex');
export const exists = (key) => { try { return fs.statSync(fileFor(key)).isFile(); } catch { return false; } };
export const pathFor = (key) => fileFor(key);
export function put(key, buffer) {
  fs.mkdirSync(config.documentsDir, { recursive: true, mode: 0o700 }); // owner-only folder (files are 0600 too)
  fs.writeFileSync(fileFor(key), buffer, { flag: 'wx', mode: 0o600 });
}
export const remove = (key) => fs.rmSync(fileFor(key), { force: true });
