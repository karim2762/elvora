import { useEffect, useState } from 'react';
import { Award, Check, X, RotateCcw, Play, AlertTriangle, Zap, Mail } from 'lucide-react';
import { useToast } from '../../components/ui/Toast';
import { listCertificateApprovals, decideCertificate, getAutomation, runAutomation } from '../../services/adminService';
import { fmtDate, fmtDateTime } from '../../lib/format';

const errText = (err) => (err?.status === 0 ? err.message : Object.values(err?.data?.error?.fields || {})[0] || err?.message || 'Something went wrong. Please try again.');
const tone = { Pending: 'info', Approved: 'ok', Declined: 'bad', Active: 'ok', Completed: 'ok', Suspended: 'warn' };
const Badge = ({ children, kind }) => <span className={`adm-badge adm-badge--${tone[kind] || 'info'}`}>{children}</span>;
const FILTERS = [['Pending', 'Needs decision'], ['Approved', 'Approved'], ['Declined', 'Declined'], ['All', 'All']];

// What will happen next, in plain words, for one row.
function nextStep(i) {
  const d = i.certificateReview.decision, doc = i.certificateDocument;
  if (doc?.status === 'Issued') return `Certificate ${doc.number} issued.`;
  if (doc?.status === 'Revoked') return `Certificate ${doc.number} was withdrawn. Issue a replacement by API if needed.`;
  if (d === 'Approved') return i.status === 'Completed' ? 'Approved. The certificate is being generated automatically.'
    : `Approved. It will be generated automatically when the internship is completed${i.expectedEndDate ? ` (on or after ${fmtDate(i.expectedEndDate)} it completes by itself)` : ''}.`;
  if (d === 'Declined') return 'Declined. No certificate will be generated.';
  return i.status === 'Completed' ? 'Waiting for your decision. No certificate is generated until you approve.' : 'Waiting for your decision. The internship is still in progress.';
}

function Row({ i, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const r = i.certificateReview;
  const locked = i.certificateDocument?.status === 'Issued';
  async function decide(decision, n = '') {
    setBusy(decision);
    try {
      await decideCertificate(i.id, { decision, note: n });
      toast.success(decision === 'Approved' ? 'Approved. The certificate will be generated automatically.' : decision === 'Declined' ? 'Declined. The student has been notified.' : 'Decision cleared.');
      setDeclining(false); setNote(''); onChanged();
    } catch (err) { toast.error(errText(err)); } finally { setBusy(''); }
  }
  return (
    <li className="card adm-item">
      <div className="adm-item__top">
        <div><p className="adm-id mono">{i.id}</p><h3>{i.studentName}</h3></div>
        <div className="adm-badges"><Badge kind={i.status}>{i.status}</Badge><Badge kind={r.decision}>{r.decision === 'Pending' ? 'Not decided' : r.decision}</Badge></div>
      </div>
      <p className="adm-meta">{i.internship.title} · {i.studentEmail}<br />
        {i.startDate ? <>{fmtDate(i.startDate)} → {i.expectedEndDate ? fmtDate(i.expectedEndDate) : '—'}</> : 'No dates yet'}{i.completedAt && <> · completed {fmtDate(i.completedAt)}</>}</p>
      <p className="adm-next"><Award size={15} aria-hidden="true" /> {nextStep(i)}</p>
      {r.decidedAt && <p className="adm-note">{r.decision} by {r.decidedBy || 'Administrator'} on {fmtDateTime(r.decidedAt)}{r.note ? ` — “${r.note}”` : ''}</p>}
      {!locked && !declining && (
        <div className="adm-row">
          {r.decision !== 'Approved' && <button type="button" className="btn btn--primary btn--sm" disabled={Boolean(busy)} onClick={() => decide('Approved')}><Check size={16} aria-hidden="true" />{busy === 'Approved' ? 'Saving…' : 'Approve certificate'}</button>}
          {r.decision !== 'Declined' && <button type="button" className="btn btn--secondary btn--sm" disabled={Boolean(busy)} onClick={() => setDeclining(true)}><X size={16} aria-hidden="true" />Decline</button>}
          {r.decision !== 'Pending' && <button type="button" className="btn btn--secondary btn--sm" disabled={Boolean(busy)} onClick={() => decide('Pending')}><RotateCcw size={16} aria-hidden="true" />Clear decision</button>}
        </div>
      )}
      {!locked && declining && (
        <form className="adm-sub" onSubmit={(e) => { e.preventDefault(); decide('Declined', note.trim()); }}>
          <label>Reason (kept in the record)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} required autoFocus placeholder="e.g. Final project not submitted" /></label>
          <div className="adm-row"><button type="button" className="btn btn--secondary btn--sm" onClick={() => setDeclining(false)}>Back</button>
            <button type="submit" className="btn btn--primary btn--sm" disabled={!note.trim() || Boolean(busy)}>{busy === 'Declined' ? 'Saving…' : 'Confirm decline'}</button></div>
        </form>
      )}
    </li>
  );
}

function AutomationCard({ tick, onRan }) {
  const toast = useToast();
  const [a, setA] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; getAutomation().then((x) => alive && setA(x)).catch(() => {}); return () => { alive = false; }; }, [tick]);
  async function run() {
    setBusy(true);
    try { const r = await runAutomation(); setA(r.automation); const x = r.result; toast.success(`Done: ${x.offerLettersIssued} offer letter(s), ${x.certificatesIssued} certificate(s), ${x.emailsSent} e-mail(s).`); onRan(); }
    catch (err) { toast.error(errText(err)); } finally { setBusy(false); }
  }
  if (!a) return null;
  return (
    <section className="card adm-auto" aria-label="Automation">
      <div className="adm-item__top">
        <h2><Zap size={18} aria-hidden="true" /> Automation</h2>
        <Badge kind={a.enabled ? 'Approved' : 'Declined'}>{a.enabled ? `On · every ${a.intervalMinutes} min` : 'Off'}</Badge>
      </div>
      <p className="adm-note">Offer letters are created and issued automatically after an application is approved (target {a.offerSlaHours} hours). Certificates are generated only for interns you approve here.</p>
      <ul className="adm-stats">
        <li><b>{a.waiting.offerLetters}</b> offer letter(s) waiting</li>
        <li><b>{a.waiting.certificates}</b> approved certificate(s) waiting</li>
        <li><Mail size={14} aria-hidden="true" /> E-mail {a.emailConfigured ? 'on' : 'off (set SMTP_HOST and MAIL_FROM)'}</li>
        {a.lastRun && <li>Last run {fmtDateTime(a.lastRun.at)}</li>}
      </ul>
      {a.lastRun?.overdueOffers > 0 && <p className="adm-err" role="alert"><AlertTriangle size={15} aria-hidden="true" /> {a.lastRun.overdueOffers} offer letter(s) are later than {a.offerSlaHours} hours.</p>}
      {a.problems.length > 0 && (
        <div role="alert" className="adm-problems"><strong><AlertTriangle size={15} aria-hidden="true" /> Needs attention</strong>
          <ul>{a.problems.map((p) => <li key={p.enrollmentId + p.type}>{p.studentName} · {p.type === 'certificate' ? 'certificate' : 'offer letter'}: {p.error} <span className="text-muted">(tried {p.attempts}×{p.nextAttemptAt ? `, next ${fmtDateTime(p.nextAttemptAt)}` : ''})</span></li>)}</ul></div>
      )}
      <div className="adm-row"><button type="button" className="btn btn--secondary btn--sm" onClick={run} disabled={busy}><Play size={16} aria-hidden="true" />{busy ? 'Running…' : 'Run now'}</button></div>
    </section>
  );
}

export default function CertificateApprovals({ onAuthLost }) {
  const [filter, setFilter] = useState('Pending');
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    listCertificateApprovals().then((data) => alive && setState({ status: 'ready', data, error: null }))
      .catch((error) => { if (!alive) return; if (error.status === 401) onAuthLost(); else setState({ status: 'error', data: null, error }); });
    return () => { alive = false; };
  }, [tick, onAuthLost]);
  const all = state.data ?? [];
  const count = (f) => (f === 'All' ? all.length : all.filter((i) => i.certificateReview.decision === f).length);
  const shown = filter === 'All' ? all : all.filter((i) => i.certificateReview.decision === filter);
  const refresh = () => setTick((t) => t + 1);
  return (
    <section aria-label="Certificate approvals" className="adm-cert">
      <AutomationCard tick={tick} onRan={refresh} />
      <div className="card adm-explain"><strong>How it works</strong>
        <ol><li>An intern finishes (you mark the internship Completed, or it completes itself on the end date once you have approved).</li>
          <li>You decide here: <b>Approve</b> or <b>Decline</b>. Nothing is generated before that.</li>
          <li>After approval the certificate (with the CEO’s digital signature and a QR code) is generated, shown in the student’s Documents and e-mailed.</li></ol></div>
      <div className="afilter" role="group" aria-label="Filter by decision">
        {FILTERS.map(([k, label]) => <button key={k} type="button" className={`chip chip--btn afilter__btn ${filter === k ? 'is-on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}{state.data && <span className="afilter__n">{count(k)}</span>}</button>)}
      </div>
      {state.status === 'error' && <p className="adm-err" role="alert">{errText(state.error)} <button type="button" className="link" onClick={refresh}>Retry</button></p>}
      {state.status === 'loading' && <p className="text-muted" role="status">Loading…</p>}
      {state.data && shown.length === 0 && <p className="card adm-empty">{filter === 'Pending' ? 'No interns are waiting for a decision.' : 'Nothing here.'}</p>}
      {shown.length > 0 && <ul className="adm-list">{shown.map((i) => <Row key={i.id} i={i} onChanged={refresh} />)}</ul>}
    </section>
  );
}
