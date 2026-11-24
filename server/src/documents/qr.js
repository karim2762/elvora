import QRCode from 'qrcode';

// QR codes are generated in-process (pure JS, no network, no image files). The matrix feeds both the HTML templates (SVG)
// and the PDF renderer (vector squares), so the code in a preview and in the issued PDF is identical.
// Error correction M tolerates small print defects; the quiet zone is 2 modules (the printed panel adds white space around it).
export const QUIET = 2;
export function qrMatrix(text) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  return { size: n, dark: (r, c) => Boolean(modules.get(r, c)) };
}
export function qrSvg(text) {
  const { size, dark } = qrMatrix(text);
  const cells = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (dark(r, c)) cells.push(`M${c + QUIET} ${r + QUIET}h1v1h-1z`);
  const total = size + QUIET * 2;
  return `<svg viewBox="0 0 ${total} ${total}" role="img" aria-label="Verification QR code" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${cells.join('')}" fill="#000"/></svg>`;
}
