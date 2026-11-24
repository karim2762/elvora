import fs from 'node:fs';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { HttpError } from '../../utils/errors.js';
import { qrMatrix, QUIET } from '../qr.js';
import { signatureShapes } from '../signatureArt.js';

// PDF engine (Stage 06B). pdfkit is pure JavaScript: no browser, no native binary, so it runs the same on Linux, Windows,
// macOS, Termux or any host. It draws the SAME plain data object the HTML templates use (data.js), with the same layout
// design, colours and wording, so the PDF and the preview cannot disagree about content.
//
//  * Fonts (Noto Sans / Noto Serif, SIL OFL) are embedded from npm packages, so output never depends on system fonts.
//    They cover Latin text only. Text with other characters is REFUSED (UNSUPPORTED_CHARACTERS) instead of printing
//    empty boxes on an official document.
//  * Text is measured before it is drawn. Long names/titles shrink to a floor size and wrap; if text still cannot fit the
//    certificate's single page the render is REFUSED (TEXT_TOO_LONG) rather than clipped.
//  * Output is deterministic apart from the stamps: info dates use the issue date, not the render time.
const require = createRequire(import.meta.url);
const fontFile = (pkg, name) => fs.readFileSync(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-${name}-normal.woff`));
let fontCache = null;
const fonts = () => (fontCache ??= {
  Sans: fontFile('noto-sans', '400'), SansB: fontFile('noto-sans', '700'),
  Serif: fontFile('noto-serif', '400'), SerifB: fontFile('noto-serif', '700'),
});

const MM = 72 / 25.4;
const MUTED = '#475569', LINE = '#CBD5E1', SOFT = '#F1F5F9';
const unprocessable = (message, code, details) => new HttpError(422, message, { code, details });

// ---- text safety ---------------------------------------------------------------------------------------------------
function collectText(d) {
  const o = d.organization;
  return [o.name, o.legalName, o.address, o.email, o.website, o.signatory.name, o.signatory.title, o.registration?.label, o.registration?.number, o.footer,
    d.title, d.student.fullName, d.student.email, d.internship.title, d.internship.category, d.internship.duration,
    d.dates.start, d.dates.expectedEnd, d.dates.completion, d.document.number, d.document.issueDate, d.document.verificationCode,
    d.offer?.project, ...(d.offer?.objectives ?? []), ...(d.offer?.terms ?? [])].filter(Boolean);
}
function assertSupported(doc, d) {
  const bad = new Set();
  for (const name of ['Sans', 'SansB', 'Serif', 'SerifB']) {
    doc.font(name);
    const f = doc._font.font;
    for (const s of collectText(d)) for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp > 0x20 && !f.hasGlyphForCodePoint(cp)) bad.add(ch);
    }
  }
  if (bad.size) throw unprocessable(`Some characters can’t be printed on the document (${[...bad].slice(0, 8).join(' ')}). Use the standard Latin spelling.`, 'UNSUPPORTED_CHARACTERS', { characters: [...bad].slice(0, 20) });
}

// ---- drawing helpers -----------------------------------------------------------------------------------------------
function logo(doc, org, x, y, size) {
  const { dataUri, mime } = org.logo;
  if (!dataUri) return false;
  const buf = Buffer.from(dataUri.split(',')[1], 'base64');
  try {
    if (mime === 'image/svg+xml') SVGtoPDF(doc, buf.toString('utf8'), x, y, { width: size, height: size, preserveAspectRatio: 'xMidYMid meet', assumePt: true });
    else doc.image(buf, x, y, { fit: [size, size], align: 'center', valign: 'center' });
    return true;
  } catch { return false; } // an unreadable custom logo must not block an official document; the name is still printed
}
function qr(doc, url, x, y, size) {
  const { size: n, dark } = qrMatrix(url);
  const cell = size / (n + QUIET * 2);
  doc.save().rect(x, y, size, size).fill('#FFFFFF');
  doc.fillColor('#000000');
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) doc.rect(x + (c + QUIET) * cell, y + (r + QUIET) * cell, cell + 0.15, cell + 0.15).fill();
  doc.restore();
}
const text = (doc, s, x, y, { font = 'Sans', size = 10, color = '#101827', width, align = 'left', spacing = 0, lineGap = 0 } = {}) => {
  doc.font(font).fontSize(size).fillColor(color);
  doc.text(s, x, y, { width, align, characterSpacing: spacing, lineGap });
  return doc.y;
};
const heightOf = (doc, s, { font = 'Sans', size = 10, width, lineGap = 0 }) => { doc.font(font).fontSize(size); return doc.heightOfString(s, { width, lineGap }); };

// Largest size (≤ base, ≥ min) at which the text fits within maxLines.
function fitSize(doc, s, { font, base, min, width, maxLines, lineRatio = 1.25 }) {
  for (let size = base; size >= min; size -= 0.5) {
    if (heightOf(doc, s, { font, size, width }) <= size * lineRatio * maxLines + 0.5) return size;
  }
  return min;
}

function orgLines(org) {
  return [org.legalName && org.legalName !== org.name ? org.legalName : '', org.address, org.email, org.website,
    org.registration ? `${org.registration.label}: ${org.registration.number}` : ''].filter(Boolean);
}

// QR + everything a person needs to verify by hand: instruction, the full address, the document number and the reference.
// Returns the bottom edge of the panel so callers can lay out below it. The address is also a clickable link in PDF viewers.
function verifyPanel(doc, d, x, y, qrSize, panelW) {
  qr(doc, d.document.verificationUrl, x, y, qrSize);
  doc.roundedRect(x, y, qrSize, qrSize, 2).lineWidth(0.5).stroke('#94A3B8');
  const tx = x + qrSize + 10, tw = panelW - qrSize - 10;
  const intro = `Scan the QR code, or open the address below, to confirm that ${d.organization.name} issued this document.`;
  const parts = [
    { s: 'Verify this document', font: 'SansB', size: 9, color: '#101827', after: 2 },
    { s: intro, size: 7.5, color: MUTED, after: 3 },
    { s: d.document.verificationUrl, font: 'SansB', size: 7.5, color: '#101827', after: 3, link: d.document.verificationUrl },
    { s: `Elvora ID  ${d.document.number}`, font: 'SansB', size: 8, color: '#101827', after: 0 },
  ];
  const heights = parts.map((p) => heightOf(doc, p.s, { font: p.font ?? 'Sans', size: p.size, width: tw }) + p.after);
  const block = heights.reduce((a, b) => a + b, 0);
  let ty = y + Math.max(0, (qrSize - block) / 2);
  parts.forEach((p, k) => {
    doc.font(p.font ?? 'Sans').fontSize(p.size).fillColor(p.color);
    doc.text(p.s, tx, ty, { width: tw, ...(p.link ? { link: p.link } : {}) });
    ty += heights[k];
  });
  return Math.max(y + qrSize, y + Math.max(0, (qrSize - block) / 2) + block);
}

// Digital signature: drawn as vector shapes (see signatureArt.js): the signatory's name in a tall spiky script, crossed by a long
// thin strike-through line and a tall tapered slash, in black ink, sitting on the signing line. The full name is printed in plain
// type under the line. It is a visual signature; authenticity is proven by the QR verification + stored SHA-256.
function drawSignature(doc, name, x, lineY, width, height) {
  const { box, shapes } = signatureShapes(name);
  if (!shapes.length) return;
  const k = Math.min(width / box.w, (height * 1.1) / box.h);
  doc.save().translate(x, lineY - box.h * k + 2 * k).scale(k);
  for (const s of shapes) {
    doc.path(s.d);
    if (s.fill) doc.fillColor(s.fill).fill();
    else doc.lineWidth(s.width).lineCap('round').lineJoin('round').strokeColor(s.stroke).stroke();
  }
  doc.restore();
}

function signatureBlock(doc, d, x, y, lineW, lineH) {
  const o = d.organization;
  if (o.signature?.enabled) drawSignature(doc, o.signatory.name, x, y + lineH, lineW, lineH * 0.92);
  doc.moveTo(x, y + lineH).lineTo(x + lineW, y + lineH).lineWidth(0.8).stroke('#101827');
  let ty = text(doc, o.signatory.name, x, y + lineH + 8, { font: 'SansB', size: 10.5, width: lineW + 40 });
  ty = text(doc, o.signatory.title, x, ty, { size: 9, color: MUTED, width: lineW + 40 });
  ty = text(doc, `For ${o.name}`, x, ty, { size: 9, color: MUTED, width: lineW + 40 });
  return o.signature?.enabled ? text(doc, `Digitally signed · ${d.document.issueDate}`, x, ty + 1, { size: 7, color: MUTED, width: lineW + 40 }) : ty;
}

// ---- offer letter (A4 portrait) ------------------------------------------------------------------------------------
function drawOffer(doc, d) {
  const o = d.organization, c = o.colors;
  const M = 16 * MM, L = M, W = doc.page.width - 2 * M, BOTTOM = doc.page.height - 18 * MM;
  const band = () => { const g = doc.linearGradient(L, 0, L + W, 0); g.stop(0, c.primary).stop(1, c.accent); doc.rect(L, 14 * MM, W, 3.5).fill(g); };
  const newPage = () => { doc.addPage(); band(); doc.y = 14 * MM + 20; };
  const need = (h) => { if (doc.y + h > BOTTOM) newPage(); };

  band();
  // header: logo + name left, organization lines right
  const top = 14 * MM + 16;
  const hasLogo = logo(doc, o, L, top, 40);
  const nameX = L + (hasLogo ? 50 : 0);
  text(doc, o.name, nameX, top + 8, { font: 'SansB', size: 19, color: c.primary, spacing: 1.2, width: 220 });
  const lines = orgLines(o);
  const metaW = 190, metaX = L + W - metaW;
  const metaH = lines.length ? heightOf(doc, lines.join('\n'), { size: 8, width: metaW, lineGap: 1.5 }) : 0;
  if (lines.length) text(doc, lines.join('\n'), metaX, top + Math.max(0, (40 - metaH) / 2), { size: 8, color: MUTED, width: metaW, align: 'right', lineGap: 1.5 });
  doc.y = top + Math.max(40, metaH) + 10;
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.6).stroke(LINE);
  doc.y += 10;

  const rowY = doc.y;
  text(doc, 'Elvora ID: ', L, rowY, { size: 9, color: MUTED, width: W / 2 });
  const wNo = doc.widthOfString('Elvora ID: ');
  text(doc, d.document.number, L + wNo, rowY, { font: 'SansB', size: 9, width: W / 2 - wNo });
  text(doc, `Date of issue: ${d.document.issueDate}`, L + W / 2, rowY, { font: 'SansB', size: 9, width: W / 2, align: 'right' });
  doc.y = rowY + 22;

  text(doc, 'INTERNSHIP', L, doc.y, { font: 'SansB', size: 8, color: c.accent, spacing: 1.4, width: W });
  text(doc, d.title, L, doc.y + 2, { font: 'SansB', size: 21, width: W });
  doc.y += 12;
  text(doc, `Dear ${d.student.fullName},`, L, doc.y, { font: 'SansB', size: 10.5, width: W });
  doc.y += 6;
  text(doc, `We are pleased to offer you an internship with ${o.name} as described below. This offer follows the approval of your application.`, L, doc.y, { size: 10.5, width: W, lineGap: 2 });
  doc.y += 14;

  const heading = (s) => { need(40); text(doc, s, L, doc.y, { font: 'SansB', size: 11, color: c.primary, width: W }); doc.y += 5; };

  // offer details table
  heading('Offer details');
  const rows = [['Intern', d.student.fullName], ['Email', d.student.email], ['Internship', d.internship.title], ['Category', d.internship.category],
    ['Duration', d.internship.duration], ['Start date', d.dates.start], ['Expected completion', d.dates.expectedEnd], ['Assigned project', d.offer.project]].filter(([, v]) => v);
  const LABEL = 120, PAD = 8;
  rows.forEach(([k, v], i) => {
    const h = Math.max(heightOf(doc, k, { font: 'SansB', size: 9, width: LABEL - 2 * PAD }), heightOf(doc, v, { size: 10, width: W - LABEL - 2 * PAD })) + 12;
    need(h);
    const y = doc.y;
    doc.rect(L, y, LABEL, h).fill(SOFT);
    doc.rect(L, y, W, h).lineWidth(0.5).stroke(LINE);
    doc.moveTo(L + LABEL, y).lineTo(L + LABEL, y + h).lineWidth(0.5).stroke(LINE);
    text(doc, k, L + PAD, y + 6, { font: 'SansB', size: 9, color: MUTED, width: LABEL - 2 * PAD });
    text(doc, v, L + LABEL + PAD, y + 6, { size: 10, width: W - LABEL - 2 * PAD });
    doc.y = y + h;
    if (i === rows.length - 1) doc.y += 14;
  });

  const list = (items, numbered, size) => items.forEach((it, i) => {
    const w = W - 18;
    const h = heightOf(doc, it, { size, width: w, lineGap: 1.5 }) + 4;
    need(h);
    const y = doc.y;
    text(doc, numbered ? `${i + 1}.` : '•', L, y, { size, width: 16 });
    text(doc, it, L + 18, y, { size, width: w, lineGap: 1.5 });
    doc.y = y + h;
  });
  if (d.offer.objectives.length) { heading('Responsibilities and learning objectives'); list(d.offer.objectives, false, 10); doc.y += 10; }
  heading('Terms and conditions'); list(d.offer.terms, true, 9.5);

  // signature + verification kept together, never split across pages
  need(135);
  doc.y += 16;
  const y0 = doc.y;
  const endSig = signatureBlock(doc, d, L, y0, 190, 46);
  const endVerify = verifyPanel(doc, d, L + W - 300, y0 - 4, 76, 300);
  doc.y = Math.max(endSig, endVerify) + 14;
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).stroke(LINE);
  text(doc, o.footer || `This document was issued by ${o.name}.`, L, doc.y + 6, { size: 8, color: MUTED, width: W, align: 'center' });
}

// ---- certificate (A4 landscape, exactly one page) ------------------------------------------------------------------
function drawCertificate(doc, d) {
  const o = d.organization, c = o.colors;
  const PW = doc.page.width, PH = doc.page.height;
  doc.rect(26, 26, PW - 52, PH - 52).lineWidth(4.5).stroke(c.primary);
  doc.rect(33, 33, PW - 66, PH - 66).lineWidth(0.9).stroke(c.accent);
  const X = 62, W = PW - 2 * X;
  const FOOT_TOP = PH - 33 - 124; // fixed footer zone: signature, QR, footer line

  // header (logo + name centred), one line of organization details
  const nameW = (doc.font('SansB').fontSize(18), doc.widthOfString(o.name) + o.name.length * 1.2);
  const has = Boolean(o.logo.dataUri);
  const total = (has ? 34 : 0) + nameW;
  let hx = (PW - total) / 2;
  if (has) { logo(doc, o, hx, 50, 28); hx += 34; }
  text(doc, o.name, hx, 54, { font: 'SansB', size: 18, color: c.primary, spacing: 1.2, width: nameW + 10 });
  const meta = orgLines(o).join('  ·  ');
  let y = 86;
  if (meta) y = text(doc, meta, X, y, { size: 7.5, color: MUTED, width: W, align: 'center' }) + 4;
  else y += 4;

  y = text(doc, 'CERTIFICATE OF COMPLETION', X, y + 10, { font: 'SerifB', size: 27, color: c.primary, spacing: 2, width: W, align: 'center' }) + 8;
  y = text(doc, 'This is to certify that', X, y, { size: 10.5, color: MUTED, width: W, align: 'center' }) + 4;

  const nameBox = W - 80;
  const ns = fitSize(doc, d.student.fullName, { font: 'SerifB', base: 30, min: 17, width: nameBox, maxLines: 2 });
  y = text(doc, d.student.fullName, X + 40, y, { font: 'SerifB', size: ns, width: nameBox, align: 'center' }) + 5;
  doc.moveTo(X + 60, y).lineTo(X + W - 60, y).lineWidth(0.8).stroke(c.accent);
  y += 10;

  y = text(doc, 'has successfully completed the internship', X, y, { size: 11, width: W, align: 'center' }) + 4;
  const ts = fitSize(doc, d.internship.title, { font: 'SansB', base: 15, min: 10.5, width: W - 100, maxLines: 3 });
  y = text(doc, d.internship.title, X + 50, y, { font: 'SansB', size: ts, color: c.primary, width: W - 100, align: 'center' }) + 4;
  const tail = `${d.internship.category ? `in ${d.internship.category} ` : ''}with ${o.name}${d.internship.duration ? `, a programme of ${d.internship.duration}` : ''}.`;
  y = text(doc, tail, X + 30, y, { size: 11, width: W - 60, align: 'center' }) + 12;

  // facts row
  const facts = [['Start date', d.dates.start], ['Completion date', d.dates.completion], ['Issue date', d.document.issueDate], ['Elvora ID', d.document.number]];
  const cw = W / facts.length;
  facts.forEach(([k, v], i) => {
    text(doc, k, X + i * cw, y, { size: 8.5, color: MUTED, width: cw, align: 'center' });
    text(doc, v, X + i * cw, y + 12, { font: 'SansB', size: 10.5, width: cw, align: 'center' });
  });
  y += 34;
  if (y > FOOT_TOP - 4) throw unprocessable('The student name or internship title is too long to fit on one certificate page.', 'TEXT_TOO_LONG');

  // footer zone
  const fy = FOOT_TOP + 4;
  const endSig = signatureBlock(doc, d, X, fy - 4, 190, 34);
  const endVerify = verifyPanel(doc, d, PW - X - 330, fy - 2, 72, 330);
  if (endVerify > PH - 33 - 24) throw unprocessable('The verification address is too long to fit on the certificate.', 'TEXT_TOO_LONG');
  text(doc, o.footer || `This document was issued by ${o.name}.`, X, PH - 33 - 20, { size: 7.5, color: MUTED, width: W, align: 'center' });
  if (endSig > PH - 33 - 24) throw unprocessable('Signatory details are too long to fit on the certificate.', 'TEXT_TOO_LONG');
}

// ---- entry point ---------------------------------------------------------------------------------------------------
export async function renderPdfBuffer(d) {
  if (d.preview) throw new HttpError(500, 'Previews are HTML only; a PDF is produced only for real documents.', { code: 'PREVIEW_NOT_PRINTABLE' });
  if (!d.document.verificationUrl) throw new HttpError(500, 'A PDF needs a verification reference.', { code: 'MISSING_VERIFICATION' });
  const certificate = d.type === 'certificate';
  const issued = new Date(d.document.issuedAt); // the PDF's own date is the issue date, so re-rendering gives the same stamp
  const doc = new PDFDocument({
    size: 'A4', layout: certificate ? 'landscape' : 'portrait', margin: 0, compress: true, autoFirstPage: true,
    info: { Title: `${d.title} — ${d.student.fullName}`, Author: d.organization.name, Creator: `${d.organization.name} document system`, Producer: 'ELVORA (pdfkit)', Subject: d.document.number, CreationDate: issued },
  });
  let pages = 1;
  doc.on('pageAdded', () => { pages += 1; });
  const chunks = [];
  doc.on('data', (b) => chunks.push(b));
  const done = new Promise((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); });
  try {
    const f = fonts();
    for (const [k, v] of Object.entries(f)) doc.registerFont(k, v);
    assertSupported(doc, d);
    (certificate ? drawCertificate : drawOffer)(doc, d);
    if (certificate && pages !== 1) throw unprocessable('The certificate does not fit on one page.', 'TEXT_TOO_LONG');
  } catch (err) { doc.end(); await done.catch(() => {}); throw err; }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
