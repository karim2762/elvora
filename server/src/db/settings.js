import { db } from './index.js';
import path from 'node:path';
import { config } from '../config/index.js';

// Uploaded logos live next to (not inside) the documents folder, under a random file name chosen by the server.
export const brandingDir = () => path.join(path.dirname(config.documentsDir), 'branding');
const SAFE_LOGO = /^[a-f0-9]{32}\.(png|jpg)$/;

// Stage 07C — administrator overrides of NON-SECRET platform values. Anything not overridden falls back to the environment value
// (config.organization / config.automation), so a fresh install behaves exactly as before. Secrets (SMTP, keys) never live here.
export const FIELD_TO_ORG = {
  organizationName: 'name', contactEmail: 'email', website: 'website', address: 'address',
  signatoryName: 'signatoryName', signatoryTitle: 'signatoryTitle', signatureEnabled: 'signatureEnabled',
  documentFooter: 'footer', colorPrimary: 'colorPrimary', colorAccent: 'colorAccent', colorInk: 'colorInk',
};
const parse = (v) => { try { return JSON.parse(v); } catch { return undefined; } };

export function overrides() {
  const out = {};
  for (const r of db.prepare('SELECT key, value, updated_at, updated_by FROM platform_settings').all()) {
    const v = parse(r.value);
    if (v !== undefined) out[r.key] = { value: v, updatedAt: r.updated_at, updatedBy: r.updated_by };
  }
  return out;
}
export const get = (key) => { const r = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key); return r ? parse(r.value) : undefined; };

// Applies a validated patch atomically. A null value removes the override (the environment value applies again).
export function apply(patch, updatedBy) {
  const now = new Date().toISOString();
  return db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) db.prepare('DELETE FROM platform_settings WHERE key = ?').run(key);
      else db.prepare('INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
        .run(key, JSON.stringify(value), now, updatedBy ?? null);
    }
  })();
}

// The organization values documents are built from: environment defaults overlaid with administrator overrides.
// Registration (MSME/Udyam) fields are NOT overridable here, so an unverified claim can't be switched on through settings.
export function effectiveOrganizationConfig() {
  const o = overrides();
  const merged = { ...config.organization };
  for (const [field, orgKey] of Object.entries(FIELD_TO_ORG)) if (o[field] !== undefined) merged[orgKey] = o[field].value;
  // The CEO is Gowtham. Deployments that still carry the former signatory (in .env or in saved settings) are corrected here,
  // so no document is ever signed with the old name.
  if (/^kish?ore\b/i.test(String(merged.signatoryName ?? '').trim())) merged.signatoryName = 'Gowtham';
  const logo = o.logoFile?.value;
  if (typeof logo === 'string' && SAFE_LOGO.test(logo)) merged.logoPath = path.join(brandingDir(), logo);
  return merged;
}
