import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ShieldCheck, ShieldX, ShieldAlert, SearchX, WifiOff, Loader2, FileText, Award, Hash, User, Briefcase, Clock, CalendarDays, Building2, Info } from 'lucide-react';
import { useRemote } from '../hooks/useApplications';
import { usePageMeta } from '../hooks/usePageMeta';
import { verifyDocument } from '../services/publicService';
import { fmtDate } from '../lib/format';
import { formatDuration } from '../lib/duration';
import Button from '../components/ui/Button';

// Public document verification (opened from a QR code or the student's "Verify authenticity" link). No login, read-only, and it only
// ever shows the fields the API returns for the public projection. Colour is never the only signal: every state has an icon and a headline.
const OUTCOMES = {
  valid: { tone: 'ok', Icon: ShieldCheck, title: 'Valid document', text: 'ELVORA issued this document and it has not been revoked.' },
  revoked: { tone: 'bad', Icon: ShieldX, title: 'Revoked — no longer valid', text: 'ELVORA has withdrawn this document. Do not rely on it.' },
  superseded: { tone: 'bad', Icon: ShieldX, title: 'Superseded — replaced by a corrected document', text: 'ELVORA corrected an error and issued a replacement. This earlier document is no longer the current one. Ask the holder for the current certificate and verify its reference.' },
  invalid: { tone: 'warn', Icon: ShieldAlert, title: 'Invalid reference', text: 'This is not a valid ELVORA verification reference. Check that it was scanned or typed correctly.' },
  not_found: { tone: 'warn', Icon: SearchX, title: 'Document not found', text: 'No ELVORA document matches this reference. If you were given this document, treat it as unverified.' },
};
const TYPE_LABEL = { offer_letter: 'Offer Letter', certificate: 'Completion Certificate' };

function Row({ icon: Icon, label, children }) {
  return <div className="vfy__row"><dt><Icon size={14} aria-hidden="true" />{label}</dt><dd>{children}</dd></div>;
}

function Details({ doc }) {
  const TypeIcon = doc.type === 'certificate' ? Award : FileText;
  return (
    <dl className="vfy__facts">
      <Row icon={TypeIcon} label="Document type">{TYPE_LABEL[doc.type] ?? doc.type}</Row>
      <Row icon={Hash} label="Document number"><span className="mono">{doc.documentNumber}</span></Row>
      <Row icon={User} label="Issued to">{doc.studentName}</Row>
      <Row icon={Briefcase} label="Internship">{doc.internshipTitle}</Row>
      {doc.durationDays ? <Row icon={Clock} label="Duration">{formatDuration(doc.durationDays)}</Row> : null}
      <Row icon={CalendarDays} label="Issue date">{fmtDate(doc.issuedAt)}</Row>
      <Row icon={Building2} label="Issued by">{doc.organizationName}</Row>
      <Row icon={doc.valid ? ShieldCheck : ShieldX} label="Current status">
        <span className={`status status--${doc.valid ? 'teal' : 'red'}`}>{doc.valid ? 'Valid' : doc.status === 'Superseded' ? `Superseded${doc.revokedAt ? ` on ${fmtDate(doc.revokedAt)}` : ''}` : `Revoked${doc.revokedAt ? ` on ${fmtDate(doc.revokedAt)}` : ''}`}</span>
      </Row>
    </dl>
  );
}

export default function VerifyPage() {
  usePageMeta('Verify document', 'Check whether an ELVORA offer letter or certificate is genuine.');
  const { reference } = useParams();
  const { status, data, error, reload } = useRemote(() => verifyDocument(reference ?? ''), [reference]);

  // Verification links are for people holding a document, not search results.
  useEffect(() => {
    const m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => m.remove();
  }, []);

  let outcome = null; let body = null;
  if (status === 'loading') {
    body = <p className="vfy__loading" role="status"><Loader2 className="spin-icon" size={22} aria-hidden="true" />Checking this document…</p>;
  } else if (status === 'error') {
    const offline = error?.status === 0, limited = error?.status === 429;
    body = (
      <div className="vfy__state" role="alert">
        <span className="vfy__badge vfy__badge--warn"><WifiOff size={28} aria-hidden="true" /></span>
        <h1 className="vfy__title">We couldn’t check this document</h1>
        <p className="text-muted">{offline ? error.message : limited ? 'Too many checks from this connection. Please wait a few minutes and try again.' : 'Something went wrong on our side. This is not a result about the document itself. Please try again.'}</p>
        <Button onClick={reload}>Try again</Button>
      </div>
    );
  } else {
    outcome = OUTCOMES[data.result] ?? OUTCOMES.not_found;
    const { Icon } = outcome;
    body = (
      <div className={`vfy__result vfy__result--${outcome.tone}`}>
        <div className="vfy__state" role="status" aria-live="polite">
          <span className={`vfy__badge vfy__badge--${outcome.tone}`}><Icon size={30} aria-hidden="true" /></span>
          <h1 className="vfy__title">{outcome.title}</h1>
          <p className="vfy__lead">{outcome.text}</p>
        </div>
        {data.document && <Details doc={data.document} />}
        {data.document && <p className="vfy__note"><Info size={16} aria-hidden="true" />Compare these details with the document you hold. If anything differs, do not rely on the document.</p>}
      </div>
    );
  }

  return (
    <section className="section container container--narrow vfy" aria-label="Document verification">
      <p className="vfy__eyebrow">ELVORA document verification</p>
      <div className="card vfy__card">{body}</div>
      <p className="vfy__foot text-muted">This page only confirms whether ELVORA issued a document with this reference. It shows no contact details or private records.</p>
      <p><Link className="btn btn--secondary btn--sm" to="/">Go to ELVORA</Link></p>
    </section>
  );
}
