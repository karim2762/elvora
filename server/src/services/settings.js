import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { badRequest, HttpError } from '../utils/errors.js';
import * as settings from '../db/settings.js';
import * as audit from '../db/audit.js';
import { getOrganization, missingForIssuance } from '../documents/organization.js';
import { isEmailConfigured } from '../utils/mailer.js';
import { config } from '../config/index.js';

// Stage 07C — platform settings. Only the fields in FIELDS can be written; anything else in the request is rejected, so a request can't
// reach registration claims, secrets, roles or issuance rules. Empty/null removes the override (the environment value applies again).
const ctl = /[\u0000-\u001f\u007f]/g;
const one = (v) => String(v).replace(ctl, ' ').replace(/\s+/g, ' ').trim();
const HEX = /^#[0-9a-f]{6}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const FIELDS = {
  organizationName: (v) => (v.length >= 2 && v.length <= 100 ? null : 'Organization name must be 2 to 100 characters'),
  contactEmail: (v) => (EMAIL.test(v) && v.length <= 254 ? null : 'Enter a valid e-mail address'),
  website: (v) => { try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && v.length <= 200 ? null : 'Website must be an http(s) address up to 200 characters'; } catch { return 'Website must be a full address such as https://example.com'; } },
  address: (v) => (v.length >= 10 && v.length <= 300 ? null : 'Address must be 10 to 300 characters'),
  signatoryName: (v) => (v.length >= 2 && v.length <= 80 ? null : 'Signatory name must be 2 to 80 characters'),
  signatoryTitle: (v) => (v.length >= 2 && v.length <= 80 ? null : 'Signatory title must be 2 to 80 characters'),
  documentFooter: (v) => (v.length <= 200 ? null : 'Footer must be 200 characters or fewer'),
  colorPrimary: (v) => (HEX.test(v) ? null : 'Use a 6-digit hex colour such as #1D4ED8'),
  colorAccent: (v) => (HEX.test(v) ? null : 'Use a 6-digit hex colour such as #0F766E'),
  colorInk: (v) => (HEX.test(v) ? null : 'Use a 6-digit hex colour such as #101827'),
};
const BOOLEANS = ['signatureEnabled', 'emailDocuments'];
export const EDITABLE = [...Object.keys(FIELDS), ...BOOLEANS];

export function parseSettingsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object of settings to change');
  const errors = {}; const patch = {};
  for (const [k, raw] of Object.entries(body)) {
    if (!EDITABLE.includes(k)) { errors[k] = 'This setting cannot be changed here'; continue; }
    if (raw === null || raw === '') { patch[k] = null; continue; }
    if (BOOLEANS.includes(k)) { if (typeof raw === 'boolean') patch[k] = raw; else errors[k] = 'Must be true or false'; continue; }
    if (typeof raw !== 'string') { errors[k] = 'Must be text'; continue; }
    const v = one(raw);
    const problem = FIELDS[k](v);
    if (problem) errors[k] = problem; else patch[k] = k.startsWith('color') ? v.toUpperCase() : v;
  }
  if (!Object.keys(patch).length && !Object.keys(errors).length) errors._ = 'No settings were provided';
  if (Object.keys(errors).length) throw badRequest('Please fix the highlighted fields', errors);
  return patch;
}

const envValue = { organizationName: config.organization.name, contactEmail: config.organization.email, website: config.organization.website, address: config.organization.address,
  signatoryName: config.organization.signatoryName, signatoryTitle: config.organization.signatoryTitle, signatureEnabled: config.organization.signatureEnabled !== false,
  documentFooter: config.organization.footer, colorPrimary: config.organization.colorPrimary, colorAccent: config.organization.colorAccent, colorInk: config.organization.colorInk,
  emailDocuments: config.automation.emailDocuments };

// What the settings screen shows. Never contains a secret: SMTP credentials, keys and the registration number are not included.
export function view() {
  const o = settings.overrides();
  const org = getOrganization();
  const fields = {};
  for (const k of EDITABLE) fields[k] = { value: o[k] ? o[k].value : envValue[k], source: o[k] ? 'settings' : 'environment', updatedAt: o[k]?.updatedAt ?? null };
  const missing = missingForIssuance(org);
  return {
    fields,
    logo: { custom: Boolean(o.logoFile), updatedAt: o.logoFile?.updatedAt ?? null },
    // Registration (MSME/Udyam) is controlled only by the server environment and shown on documents only when verified there.
    registration: { shownOnDocuments: Boolean(org.registration) },
    notifications: { emailDocuments: fields.emailDocuments.value, emailConfigured: isEmailConfigured() },
    issuanceReadiness: { ready: missing.length === 0, missing },
  };
}

export function update(body, admin) {
  const patch = parseSettingsPatch(body);
  const o = settings.overrides();
  const changed = Object.keys(patch).filter((k) => (patch[k] === null ? o[k] !== undefined : JSON.stringify(o[k]?.value) !== JSON.stringify(patch[k])));
  if (!changed.length) return { ...view(), changed: [] };
  db.transaction(() => {
    settings.apply(Object.fromEntries(changed.map((k) => [k, patch[k]])), admin?.id);
    audit.record({ admin, action: 'settings.update', targetType: 'settings', targetId: 'platform', reason: `Changed: ${changed.join(', ')}` }); // setting NAMES only, never values
  })();
  return { ...view(), changed };
}

// ---- logo: PNG/JPEG only (no SVG: it can carry scripts), small, verified by file signature, stored under a random server-chosen name ----
const MAX_LOGO = 512 * 1024;
const kind = (b) => (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png' : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : null);
const fileOf = (name) => path.join(settings.brandingDir(), name);

export function setLogo(buffer, admin) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw badRequest('Send the logo image as the request body (Content-Type: image/png or image/jpeg)');
  if (buffer.length > MAX_LOGO) throw badRequest(`The logo must be ${MAX_LOGO / 1024} KB or smaller`);
  const ext = kind(buffer);
  if (!ext) throw badRequest('The logo must be a PNG or JPEG image');
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.mkdirSync(settings.brandingDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fileOf(name), buffer, { flag: 'wx', mode: 0o600 });
  const previous = settings.get('logoFile');
  try {
    db.transaction(() => { settings.apply({ logoFile: name }, admin?.id); audit.record({ admin, action: 'settings.logo_update', targetType: 'settings', targetId: 'logo', reason: 'Logo replaced' }); })();
  } catch (err) { fs.rmSync(fileOf(name), { force: true }); throw err; }
  if (typeof previous === 'string' && /^[a-f0-9]{32}\.(png|jpg)$/.test(previous)) fs.rmSync(fileOf(previous), { force: true });
  return view();
}
export function removeLogo(admin) {
  const previous = settings.get('logoFile');
  if (!previous) throw new HttpError(409, 'No custom logo is set.', { code: 'NO_CUSTOM_LOGO' });
  db.transaction(() => { settings.apply({ logoFile: null }, admin?.id); audit.record({ admin, action: 'settings.logo_update', targetType: 'settings', targetId: 'logo', reason: 'Custom logo removed' }); })();
  if (/^[a-f0-9]{32}\.(png|jpg)$/.test(previous)) fs.rmSync(fileOf(previous), { force: true });
  return view();
}
