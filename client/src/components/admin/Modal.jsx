import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import Button from '../ui/Button';

// Accessible dialog: role="dialog" + aria-modal, Esc closes, focus moves in and returns to the opener, background scroll is locked.
export default function Modal({ title, onClose, children, wide = false, busy = false, labelledBy = 'adm-modal-h' }) {
  const ref = useRef(null);
  // Latest handlers live in refs so the focus/scroll-lock effect below runs once per open, not on every parent render
  // (callers often pass an inline onClose, which would otherwise re-focus the first field and lose the opener on each keystroke).
  const closeRef = useRef(onClose); const busyRef = useRef(busy);
  closeRef.current = onClose; busyRef.current = busy;
  useEffect(() => {
    const opener = document.activeElement;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector('input, select, textarea, button:not(.adm-modal__x)')?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !busyRef.current) closeRef.current();
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...ref.current.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
        if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; opener?.focus?.(); };
  }, []);
  // Rendered straight into <body>: inside the page, an animated/transformed ancestor would trap a fixed overlay within the content area
  // (clipped footer, double borders, header showing through). In <body> it always covers the whole screen.
  return createPortal(
    <div className="adm-modal" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={ref} className={`adm-modal__box card ${wide ? 'adm-modal__box--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <header className="adm-modal__head">
          <h2 id={labelledBy}>{title}</h2>
          <button type="button" className="adm-modal__x" aria-label="Close dialog" onClick={onClose} disabled={busy}><X size={18} aria-hidden="true" /></button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ title, children, confirmLabel, danger = false, busy = false, error = '', onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={onClose} busy={busy} labelledBy="adm-confirm-h">
      <div className="adm-modal__body">
        {children}
        {error && <p className="field__error" role="alert">{error}</p>}
      </div>
      <footer className="adm-modal__foot">
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button className={danger ? 'btn--danger' : ''} onClick={onConfirm} disabled={busy} aria-busy={busy}>{busy ? 'Working…' : confirmLabel}</Button>
      </footer>
    </Modal>
  );
}
