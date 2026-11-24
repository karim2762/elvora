import { useEffect, useRef, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';

// Shows a PDF (a Blob) right inside the page by drawing each page on a canvas. This works in every browser, including phones,
// where a PDF inside an <iframe> is usually replaced by a "Download" button. pdf.js is loaded only when a preview is opened.
export default function PdfViewer({ blob, title = 'Document' }) {
  const box = useRef(null);
  const [state, setState] = useState({ status: 'loading', pages: 0 });

  useEffect(() => {
    let cancelled = false; let pdf = null; const tasks = [];
    const host = box.current;
    (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        if (cancelled) return;
        host.replaceChildren();
        const width = Math.max(280, host.clientWidth - 2);
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const vp = page.getViewport({ scale: scale * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
          canvas.style.width = `${Math.floor(vp.width / ratio)}px`; canvas.style.height = `${Math.floor(vp.height / ratio)}px`;
          canvas.className = 'pdfv__page'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${title}, page ${n} of ${pdf.numPages}`);
          host.appendChild(canvas);
          const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }); tasks.push(task);
          await task.promise;
          if (n === 1) setState({ status: 'ready', pages: pdf.numPages });
        }
        if (!cancelled) setState({ status: 'ready', pages: pdf.numPages });
      } catch (err) { if (!cancelled) setState({ status: 'error', pages: 0 }); }
    })();
    return () => { cancelled = true; tasks.forEach((t) => { try { t.cancel(); } catch { /* already finished */ } }); try { pdf?.destroy(); } catch { /* ignore */ } };
  }, [blob, title]);

  return (
    <div className="pdfv">
      {state.status === 'loading' && <p className="modal__msg" role="status"><Loader2 className="spin-icon" size={20} aria-hidden="true" />Loading preview…</p>}
      {state.status === 'error' && <p className="modal__msg" role="alert"><TriangleAlert size={20} aria-hidden="true" />We couldn’t show a preview here. Please use Download instead.</p>}
      <div ref={box} className="pdfv__pages" hidden={state.status === 'error'} />
    </div>
  );
}
