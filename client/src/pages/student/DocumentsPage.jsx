import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Award, Download, Eye, FileText, FolderOpen, Hash, Loader2, X, TriangleAlert, Briefcase, CalendarDays, CalendarCheck, ShieldCheck, ShieldX } from 'lucide-react';
import { LoadError } from '../../components/dashboard/PageStates';
import { useRemote } from '../../hooks/useApplications';
import { useSessionExpiry } from '../../hooks/useSessionExpiry';
import { useToast } from '../../components/ui/Toast';
import { usePageMeta } from '../../hooks/usePageMeta';
import { listDocuments, fetchDocumentFile } from '../../services/studentService';
import { useAuth } from '../../auth/AuthContext';
import { fmtDate } from '../../lib/format';
import PdfViewer from '../../components/ui/PdfViewer';

const SECTIONS = [
  { type: 'offer_letter', title: 'Offer Letters', icon: FileText, empty: 'Your offer letter will appear here once ELVORA has officially issued it.' },
  { type: 'certificate', title: 'Certificates', icon: Award, empty: 'Your certificate will appear here after you complete your internship and ELVORA issues it.' },
];

const friendly = (err) => {
  if (err?.data?.error?.code === 'DOCUMENT_FILE_MISSING' || err?.data?.error?.code === 'DOCUMENT_REVOKED') return err.message;
  if (err?.status === 404) return 'This document could not be found.';
  if (err?.status === 0) return err.message;
  return 'We couldn’t open this document. Please try again.';
};

function Skeleton() {
  return (
    <div className="stu" aria-busy="true" aria-label="Loading your documents">
      {[0, 1].map((i) => <div key={i} className="card stu__card" aria-hidden="true"><i className="sk sk--title" /><i className="sk sk--line" /><i className="sk sk--line sk--short" /></div>)}
    </div>
  );
}

// PDF preview in an accessible dialog. The file is fetched with the session cookie (server checks ownership) and shown from a
// local blob URL, so no storage address or credential is ever exposed to the page.
function PreviewDialog({ doc, onClose, onDownload }) {
  const [state, setState] = useState({ status: 'loading', blob: null, error: null });
  const closeRef = useRef(null);
  useEffect(() => {
    let alive = true;
    fetchDocumentFile(doc.id).then((blob) => alive && setState({ status: 'ready', blob, error: null }))
      .catch((error) => alive && setState({ status: 'error', blob: null, error }));
    return () => { alive = false; };
  }, [doc.id]);
  // Stage 08A: focus moves into the dialog, Tab stays inside it, Esc closes, and focus returns to the control that opened it.
  // The latest onClose lives in a ref so the effect runs once per open (an inline onClose would otherwise re-run it on every parent render).
  const boxRef = useRef(null); const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const f = [...boxRef.current.querySelectorAll('a[href], button:not(:disabled), iframe, input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !boxRef.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; opener?.focus?.(); };
  }, []);
  return createPortal(
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={boxRef} className="modal__box" role="dialog" aria-modal="true" aria-labelledby="prev-h">
        <header className="modal__head">
          <h2 id="prev-h">{doc.title}</h2>
          <button ref={closeRef} type="button" className="dash-iconbtn" aria-label="Close preview" onClick={onClose}><X size={20} aria-hidden="true" /></button>
        </header>
        <div className="modal__body">
          {state.status === 'loading' && <p className="modal__msg" role="status"><Loader2 className="spin-icon" size={20} aria-hidden="true" />Loading preview…</p>}
          {state.status === 'error' && <p className="modal__msg" role="alert"><TriangleAlert size={20} aria-hidden="true" />{friendly(state.error)}</p>}
          {state.status === 'ready' && <PdfViewer blob={state.blob} title={doc.title} />}
        </div>
        <footer className="modal__foot">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => onDownload(doc)}><Download size={16} aria-hidden="true" />Download</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function DocCard({ doc, busy, onPreview, onDownload }) {
  const Icon = doc.type === 'certificate' ? Award : FileText;
  const revoked = doc.status === 'Revoked';
  const isCert = doc.type === 'certificate';
  return (
    <li className={`card doc${revoked ? ' doc--revoked' : ''}`}>
      <span className={`doc__icon doc__icon--${revoked ? 'red' : isCert ? 'teal' : 'blue'}`}><Icon size={22} aria-hidden="true" /></span>
      <div className="doc__main">
        <h3 className="doc__title">{doc.title}{revoked && <span className="status status--red doc__status"><ShieldX size={14} aria-hidden="true" />Revoked</span>}</h3>
        <dl className="doc__facts">
          <div><dt><Hash size={13} aria-hidden="true" />{isCert ? 'Certificate number' : 'Document number'}</dt><dd className="mono">{doc.documentNumber ?? doc.id}</dd></div>
          <div><dt><Briefcase size={13} aria-hidden="true" />Internship</dt><dd>{doc.internshipTitle}</dd></div>
          {isCert && doc.completionDate && <div><dt><CalendarCheck size={13} aria-hidden="true" />Completion date</dt><dd>{fmtDate(doc.completionDate)}</dd></div>}
          <div><dt><CalendarDays size={13} aria-hidden="true" />Issue date</dt><dd>{fmtDate(doc.issuedAt)}</dd></div>
          {revoked && doc.revokedAt && <div><dt><ShieldX size={13} aria-hidden="true" />Revoked on</dt><dd>{fmtDate(doc.revokedAt)}</dd></div>}
        </dl>
        {revoked && <p className="doc__warn doc__warn--bad" role="status"><ShieldX size={14} aria-hidden="true" />This document has been withdrawn by ELVORA and is no longer valid. It can’t be opened or downloaded. Contact ELVORA if you have questions.</p>}
        {!revoked && !doc.available && <p className="doc__warn" role="status"><TriangleAlert size={14} aria-hidden="true" />The file isn’t available right now. Please contact ELVORA support.</p>}
        {!doc.verificationCode && !revoked && <p className="doc__hint text-muted">Online verification isn’t available for this document.</p>}
      </div>
      <div className="doc__actions">
        <button type="button" className="btn btn--secondary btn--sm" disabled={!doc.available} onClick={() => onPreview(doc)}><Eye size={16} aria-hidden="true" />Preview</button>
        <button type="button" className="btn btn--primary btn--sm" disabled={!doc.available || busy} onClick={() => onDownload(doc)}>
          {busy ? <Loader2 className="spin-icon" size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}Download
        </button>
        {doc.verificationCode && (
          <Link className="btn btn--secondary btn--sm" to={`/verify/${encodeURIComponent(doc.verificationCode)}`} target="_blank" rel="noopener noreferrer" aria-label={`Verify authenticity of ${doc.title} (opens in a new tab)`}>
            <ShieldCheck size={16} aria-hidden="true" />Verify authenticity
          </Link>
        )}
      </div>
    </li>
  );
}

export default function DocumentsPage() {
  usePageMeta('Documents');
  const { status, data, error, reload } = useRemote(listDocuments, []);
  const expired = useSessionExpiry(status, error);
  const toast = useToast();
  const { setUser } = useAuth();
  const [preview, setPreview] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const openerRef = useRef(null);

  const open = (doc, e) => { openerRef.current = e?.currentTarget ?? document.activeElement; setPreview(doc); };
  const close = useCallback(() => { setPreview(null); openerRef.current?.focus?.(); }, []);

  async function download(doc) {
    if (busyId) return;
    setBusyId(doc.id);
    try {
      const blob = await fetchDocumentFile(doc.id, { download: true });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = doc.fileName; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      if (err.status === 401) { setUser(null); return; }
      toast.error(friendly(err));
      reload(); // the file may have gone missing: refresh availability
    } finally { setBusyId(null); }
  }

  if (expired) return null;
  if (status === 'loading') return <Skeleton />;
  if (status === 'error') return <div className="stu"><LoadError title="We couldn’t load your documents" error={error} onRetry={reload} /></div>;

  return (
    <div className="stu">
      <header className="stu__head"><h1>Documents</h1><p className="text-muted">Official documents issued to you by ELVORA. Only you can open them.</p></header>
      {SECTIONS.map(({ type, title, icon: Icon, empty }) => {
        // valid documents first, withdrawn ones after them
        const items = data.filter((d) => d.type === type).sort((a, b) => (a.status === 'Revoked') - (b.status === 'Revoked'));
        const active = items.filter((d) => d.status !== 'Revoked').length;
        return (
          <section key={type} aria-labelledby={`${type}-h`} className="stu__section">
            <h2 id={`${type}-h`} className="stu__h"><Icon size={18} aria-hidden="true" />{title}{active > 0 && <span className="stu__count">{active}</span>}</h2>
            {items.length ? (
              <ul className="doc-list">{items.map((d) => <DocCard key={d.id} doc={d} busy={busyId === d.id} onPreview={(x) => open(x)} onDownload={download} />)}</ul>
            ) : (
              <div className="empty empty--inline" role="status"><span className="empty__icon"><FolderOpen size={24} aria-hidden="true" /></span><h3>No {title.toLowerCase()} yet</h3><p className="text-muted">{empty}</p></div>
            )}
          </section>
        );
      })}
      {preview && <PreviewDialog doc={preview} onClose={close} onDownload={download} />}
    </div>
  );
}
