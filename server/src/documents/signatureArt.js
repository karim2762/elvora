// Shared artwork for the digital signature, used by the PDF renderer and the HTML preview so they match.
//
// Style: a modern, fast, high-contrast pen signature in black ink. The signatory's name is set in a tall, narrow, spiky script
// (Mrs Saint Delafield, SIL OFL), then crossed by the long thin strike-through line that rises left to right, with a tall
// tapered upstroke slashing through the name and a looping entry stroke on the left. The full name is always printed in plain
// type under the signing line.
//
// The name is converted to vector outlines here, so the preview and the PDF draw identical shapes and neither depends on
// the viewer having the font installed. Everything is returned in one 240 x 64 box (see SIG_BOX).
import { createRequire } from 'node:module';
import * as fontkit from 'fontkit';

export const SIGN_INK = '#0B0B10';
export const SIG_BOX = { w: 240, h: 64 };

const require = createRequire(import.meta.url);
let font = null;
const loadFont = () => (font ??= fontkit.openSync(require.resolve('@fontsource/mrs-saint-delafield/files/mrs-saint-delafield-latin-400-normal.woff')));

const r = (n) => Math.round(n * 100) / 100;

// Outline of `label` laid out on a baseline, scaled so it is `maxW` wide at most and `maxH` tall at most (ascender to baseline).
function nameOutline(label, x, baseline, maxW, maxH) {
  const f = loadFont();
  const run = f.layout(label);
  const total = run.positions.reduce((a, p) => a + p.xAdvance, 0) || 1;
  const scale = Math.min(maxW / total, maxH / (f.ascent || f.unitsPerEm * 0.8), 0.09);
  let pen = 0; const parts = [];
  run.glyphs.forEach((g, i) => {
    const p = run.positions[i];
    const t = g.path.transform(scale, 0, 0, -scale, x + (pen + p.xOffset) * scale, baseline - p.yOffset * scale);
    parts.push(t.toSVG());
    pen += p.xAdvance;
  });
  return { d: parts.join(' '), width: total * scale, scale };
}

// Returns { box, shapes } where each shape is { d, fill } or { d, stroke, width }. Drawn in this order.
export function signatureShapes(name) {
  const label = String(name ?? '').trim();
  if (!label) return { box: SIG_BOX, shapes: [] };
  const { w: W } = SIG_BOX;
  const x0 = 26, base = 46;
  const nm = nameOutline(label, x0, base, 168, 44);
  const end = x0 + nm.width;
  const slashX = x0 + nm.width * 0.19;       // the tall upstroke rises through the first letters
  const strikeEnd = Math.min(W - 2, end + 44);
  const shapes = [
    { d: nm.d, fill: SIGN_INK },
    // entry loop: a big pen loop that sweeps in from the left and runs into the first letter
    { d: `M${r(x0 + 3)} ${base - 14} C${r(x0 - 14)} ${base - 34},${r(x0 - 26)} ${base - 6},${r(x0 - 12)} ${base + 2} C${r(x0 + 2)} ${base + 8},${r(x0 + 22)} ${base - 2},${r(x0 + 30)} ${base - 10}`, stroke: SIGN_INK, width: 1.5 },
    // tall tapered upstroke (thick at the foot, hair-thin at the tip) leaning right
    { d: `M${r(slashX)} 62 L${r(slashX + 1.7)} 62 L${r(slashX + 27.6)} 1 L${r(slashX + 27)} 0.6 Z`, fill: SIGN_INK },
    // long thin strike-through line, rising left to right, running past both ends of the name
    { d: `M3 ${base + 2} L${r(strikeEnd)} ${base - 17}`, stroke: SIGN_INK, width: 0.9 },
    // second, shorter hair-line under it
    { d: `M${r(x0 + nm.width * 0.46)} ${base + 3} L${r(end + 22)} ${base - 5}`, stroke: SIGN_INK, width: 0.8 },
  ];
  return { box: SIG_BOX, shapes };
}

// Inline SVG markup for the HTML preview.
export function signatureSvgInner(name) {
  return signatureShapes(name).shapes.map((s) => (s.fill
    ? `<path d="${s.d}" fill="${s.fill}"/>`
    : `<path d="${s.d}" fill="none" stroke="${s.stroke}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`)).join('');
}
