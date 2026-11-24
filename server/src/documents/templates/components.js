import { NUMBER_PLACEHOLDER } from '../numbering.js';
import { signatureSvgInner } from '../signatureArt.js';

// Reusable template components. Each takes plain data and returns an HTML string. Every dynamic value goes through esc();
// there is no other way to put text into a template. Both templates compose these, so branding and spacing stay identical.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Value or a visible placeholder. Placeholders are allowed ONLY in previews; issued documents are blocked while data is missing.
export const orPh = (value, label, preview) => (value ? esc(value) : preview ? `<span class="ph">[${esc(label)}]</span>` : '');

// Shrinks a font size as text gets longer so a long name or title wraps on at most ~2 lines instead of overflowing.
export function fitPt(text, { base, min, free }) {
  const n = String(text ?? '').length;
  return n <= free ? base : Math.max(min, Math.round(base * Math.sqrt(free / n) * 10) / 10);
}

export function header(org, preview) {
  const lines = [org.legalName && org.legalName !== org.name ? esc(org.legalName) : '', orPh(org.address, 'Official address', preview),
    orPh(org.email, 'Contact email', preview), esc(org.website)].filter(Boolean);
  const reg = org.registration ? `<br>${esc(org.registration.label)}: ${esc(org.registration.number)}` : '';
  return `<div class="brandbar"></div><div class="hdr" style="margin-top:12px">
    ${org.logo.dataUri ? `<img src="${esc(org.logo.dataUri)}" alt="${esc(org.name)} logo">` : ''}
    <div class="name">${esc(org.name)}</div>
    <div class="meta">${lines.join('<br>')}${reg}</div></div>`;
}

export const numberRow = (doc) => `<div class="docno"><span>Elvora ID: <b>${esc(doc.number)}</b></span><span>Date of issue: <b>${esc(doc.issueDate)}</b></span></div>`;

// rows: [[label, value], ...]; empty values are skipped.
export const detailGrid = (rows) => `<dl class="grid">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;

export const section = (title, inner, cls = '') => `<div class="sec ${cls}"><h2>${esc(title)}</h2>${inner}</div>`;
export const bulletList = (items, tag = 'ul') => `<${tag}>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</${tag}>`;

export function signature(org, preview) {
  const name = org.signatory.name;
  const mark = org.signature?.enabled && name
    ? `<svg class="sigart" viewBox="0 0 240 64" aria-label="Digital signature of ${esc(name)}" role="img">${signatureSvgInner(name)}</svg>` : '';
  return `<div class="sigbox"><div class="line">${mark}</div>
    <div class="who">${orPh(name, 'Authorized signatory name', preview)}</div>
    <div class="role">${orPh(org.signatory.title, 'Designation', preview)}</div>
    <div class="role">For ${esc(org.name)}</div>${org.signature?.enabled && name ? '<div class="role dsig">Digitally signed</div>' : ''}</div>`;
}

// QR slot: draws data.document.qrSvg when 06B supplies one, otherwise a dashed placeholder box.
export function verificationPanel(doc) {
  const qr = doc.qrSvg || `<svg viewBox="0 0 100 100" role="img" aria-label="QR code placeholder"><rect x="2" y="2" width="96" height="96" fill="none" stroke="#94A3B8" stroke-width="2" stroke-dasharray="6 5"/><text x="50" y="47" text-anchor="middle" font-size="16" font-family="Arial" fill="#64748B">QR</text><text x="50" y="66" text-anchor="middle" font-size="9" font-family="Arial" fill="#64748B">placeholder</text></svg>`;
  // The same details the PDF prints. Previews have no real address yet, so the line says where it will appear.
  const url = doc.verificationUrl ? esc(doc.verificationUrl) : `[verification page address]/verify/${esc(doc.verificationCode)}`;
  return `<div class="verify"><div class="qr">${qr}</div><div><b>Verify this document</b><span class="vhint">Scan the QR code, or open the address below, to confirm this document is genuine.</span><span class="vurl">${url}</span>Elvora ID: <code>${esc(doc.number)}</code></div></div>`;
}

export const footer = (org) => `<div class="foot">${esc(org.footer || `This document was issued by ${org.name}.`)}</div>`;

export const watermark = (preview) => (preview ? `<div class="wm"><span>${preview === 'sample' ? 'SAMPLE PREVIEW' : 'DRAFT — NOT ISSUED'}</span></div>` : '');
export { NUMBER_PLACEHOLDER };

export function page({ title, lang = 'en', css, body }) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`;
}
