import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { effectiveOrganizationConfig } from '../db/settings.js';

// One place that decides what the organization looks like on a document.
//  - Nothing is invented: a missing value stays empty and templates render a visible placeholder (e.g. "[Official address]")
//    only in previews, never on an issued document (issuance is blocked while required fields are missing, see readiness()).
//  - A registration line (company / MSME / Udyam / anything else) is exposed ONLY when ORG_REGISTRATION_VERIFIED=true and
//    both a label and a number are set. Otherwise `registration` is null and no template can print it.
const assetsDir = fileURLToPath(new URL('./assets/', import.meta.url));
const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_LOGO_BYTES = 1024 * 1024;

// Logo as a data: URI so any renderer (HTML, headless browser or a PDF library) can embed it with no file or network access.
export function loadLogo(logoPath = effectiveOrganizationConfig().logoPath) {
  const file = logoPath ? path.resolve(serverRoot, logoPath) : path.join(assetsDir, 'logo.svg');
  const mime = MIME[path.extname(file).toLowerCase()];
  try {
    const buf = fs.readFileSync(file);
    if (mime && buf.length <= MAX_LOGO_BYTES) return { dataUri: `data:${mime};base64,${buf.toString('base64')}`, mime, custom: Boolean(logoPath) };
  } catch { /* fall through to the built-in mark */ }
  if (logoPath) return loadLogo('');
  return { dataUri: '', mime: '', custom: false };
}

const color = (v, d) => (HEX.test(v) ? v : d);
const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// Default = environment values overlaid with the administrator's saved settings (Stage 07C). An explicit `raw` argument is used as given.
export function getOrganization(raw = effectiveOrganizationConfig()) {
  const registration = raw.registrationVerified && text(raw.registrationLabel) && text(raw.registrationNumber)
    ? { label: text(raw.registrationLabel), number: text(raw.registrationNumber) } : null;
  const website = text(raw.website);
  return {
    name: text(raw.name) || 'ELVORA',
    legalName: text(raw.legalName),
    address: text(raw.address),
    email: text(raw.email),
    website: /^https?:\/\//i.test(website) ? website : '',
    signatory: { name: text(raw.signatoryName), title: text(raw.signatoryTitle) },
    signature: { enabled: raw.signatureEnabled !== false && Boolean(text(raw.signatoryName)) }, // script-style signature of the signatory (visual; the QR code + hash are what prove authenticity)
    registration,
    footer: text(raw.footer),
    colors: { primary: color(raw.colorPrimary, '#1D4ED8'), accent: color(raw.colorAccent, '#0F766E'), ink: color(raw.colorInk, '#101827') },
    logo: loadLogo(raw.logoPath),
  };
}

// What must be configured before a REAL (not preview) document may be issued.
export function missingForIssuance(org = getOrganization()) {
  const missing = [];
  if (!org.address) missing.push('ORG_ADDRESS');
  if (!org.email) missing.push('ORG_EMAIL');
  if (!org.signatory.name) missing.push('ORG_SIGNATORY_NAME');
  if (!org.signatory.title) missing.push('ORG_SIGNATORY_TITLE');
  return missing;
}
