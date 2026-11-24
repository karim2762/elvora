import { getTemplate } from '../templates/registry.js';
import { HttpError } from '../../utils/errors.js';
import { renderPdfBuffer } from './pdfRenderer.js';

// Rendering layer. HTML (templates/) is the preview and print layout; the PDF engine (pdfRenderer.js, pdfkit) draws the same
// data object. Both consume only the plain object from data.js, never database rows.
export function renderHtml(data) {
  const t = getTemplate(data.type);
  if (!t) throw new HttpError(400, 'Unknown document type', { code: 'INVALID_TYPE' });
  return t.render(data);
}
export const renderPdf = (data) => renderPdfBuffer(data);
