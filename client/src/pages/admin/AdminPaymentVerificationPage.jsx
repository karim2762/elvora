import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BadgeCheck, CheckCircle2, ChevronDown, Clock, FileText, Search, ShieldAlert, XCircle } from 'lucide-react';
import { usePageMeta } from '../../hooks/usePageMeta';
import { env } from '../../config/env';
import * as api from '../../services/priorityPaymentAdminService';
import RefundPanel from '../../components/admin/RefundPanel';

// Admin: UPI Payment Verification. The server still checks the 'payment.review' permission, the five acknowledgements, locking and duplicates on every
// call; this page only shows the work in a simple way and sends the administrator's decision. A student's UTR or screenshot is a claim, never proof.
const TABS = [['pending', 'Waiting'], ['verified', 'Approved'], ['rejected', 'Rejected'], ['refund_pending', 'Refunds'], ['', 'All']];
const when = (t) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const errText = (e) => (e.data?.error?.fields ? Object.values(e.data.error.fields).join(' ') : e.message);
const plan = (days) => `${Math.round(days / 30)}-month plan`;
const ago = (s) => { if (s == null) return ''; const m = Math.floor(s / 60); if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; const h = Math.floor(m / 60); return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)} days ago`; };
const endDate = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }); };
const TAG = { PENDING_VERIFICATION: ['wait', 'Waiting for you'], AWAITING_PAYMENT: ['', 'Student has not paid yet'], VERIFIED: ['ok', 'Approved'], REJECTED: ['bad', 'Rejected'], REFUND_PENDING: ['info', 'Refund pending'], REFUNDED: ['info', 'Refunded'], PARTIALLY_REFUNDED: ['info', 'Partly refunded'], EXPIRED: ['', 'Expired'] };

function Copy({ text }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="pv-copy" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked: the text is still selectable */ } }}>{done ? 'Copied ✓' : 'Copy'}</button>;
}
const Tag = ({ k, label, overdue }) => { const [c, t] = TAG[k] ?? ['', label]; return <span className="pv-tags"><span className={`pv-tag ${c ? `pv-tag--${c}` : ''}`}>{label ?? t}</span>{overdue && <span className="pv-tag pv-tag--bad"><Clock size={12} aria-hidden="true" /> Overdue</span>}</span>; };

function Detail({ id, onChanged, onClose, canRefund }) {
  const [d, setD] = useState(null); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState({}); const [note, setNote] = useState(''); const [rejecting, setRejecting] = useState(false); const [reason, setReason] = useState(''); const [rejectNote, setRejectNote] = useState('');
  const load = useCallback(async () => { try { setD(await api.getPaymentDetail(id)); } catch (e) { setMsg({ error: errText(e) }); } }, [id]);
  useEffect(() => { setD(null); setAck({}); setMsg(null); setRejecting(false); load(); window.scrollTo?.({ top: 0 }); }, [load]);
  if (!d) return <section className="pv"><p aria-busy="true">{msg?.error ?? 'Loading…'}</p></section>;
  const { payment: p, currentSubmission: cs, review } = d;
  const checks = review.acknowledgements; const allAck = checks.every((a) => ack[a.key]);
  const instant = Boolean(d.request?.instant);
  const run = async (fn, ok) => { setBusy(true); setMsg(null); try { const out = await fn(); setMsg({ ok: typeof ok === 'function' ? ok(out) : ok }); await load(); onChanged(); } catch (e) { setMsg({ error: errText(e) }); await load(); } finally { setBusy(false); } };
  const approved = (out) => (out?.certificate?.offerLetterIssued
    ? `Approved ✓ The offer letter was issued and the student can download it now. The certificate will be issued automatically on ${day(out.certificate.certificateOn)}.`
    : out?.certificate?.retry ? 'Approved ✓ The offer letter will be issued in a moment (the system will retry by itself).' : 'Approved ✓ The student has been notified.');
  return (
    <section className="pv" aria-label="Payment review">
      <button type="button" className="pv-btn pv-btn--ghost pv-back" onClick={onClose}><ArrowLeft size={16} aria-hidden="true" /> Back to payments</button>
      {msg?.error && <div className="pv-alert pv-alert--bad" role="alert"><XCircle size={18} aria-hidden="true" /><div>{msg.error}</div></div>}
      {msg?.ok && <div className="pv-alert pv-alert--ok" role="status"><CheckCircle2 size={18} aria-hidden="true" /><div>{msg.ok}</div></div>}

      <div className="pv-hero">
        <div className="pv-hero__row"><div><small>Student</small><b style={{ fontSize: '1.2rem' }}>{d.student.fullName ?? d.student.id}</b></div><Tag k={d.status.key} label={d.status.label} overdue={p.overdue} /></div>
        <div className="pv-hero__row"><div><small>Amount you should have received</small><strong>{p.expectedDisplay}</strong></div><div><small>Plan</small><b>{plan(p.durationDays)}</b></div></div>
        <p>Paid to {p.payeeName} · {p.payeeUpiId}</p>
      </div>

      {d.duplicates.warning && <div className="pv-alert pv-alert--warn" role="alert"><ShieldAlert size={18} aria-hidden="true" /><div><strong>This reference number was seen before</strong>{d.duplicates.confirmedElsewhere ? `It is already approved for payment ${d.duplicates.confirmedPaymentId}. ` : ''}{d.duplicates.others.map((o) => `${o.sameStudent ? 'Same student' : `Another student (${o.studentName})`} · ${o.paymentStatus}`).join(' · ')}. Check your bank record carefully; this alone does not prove fraud.</div></div>}

      {cs && (<div className="pv-panel"><h2>What the student sent</h2>
        <dl className="pv-facts">
          <div className="wide"><dt>UTR / reference</dt><dd><span className="pv-utr"><code>{cs.utr}</code><Copy text={cs.utr} /></span></dd></div>
          <div><dt>Paid on</dt><dd>{cs.paymentDate} · {cs.paymentTime}</dd></div><div><dt>UPI app</dt><dd>{cs.upiApp ?? '—'}</dd></div>
          <div><dt>Submitted</dt><dd>{when(cs.submittedAt)}</dd></div>
          <div><dt>Screenshot</dt><dd>{cs.proofUrl ? <a href={`${env.apiUrl}${cs.proofUrl}`} target="_blank" rel="noreferrer"><FileText size={14} aria-hidden="true" /> Open</a> : 'None'}</dd></div>
          {cs.note && <div className="wide"><dt>Student note</dt><dd>{cs.note}</dd></div>}
          {cs.replacementReason && <div className="wide"><dt>Why corrected</dt><dd>{cs.replacementReason}</dd></div>}
        </dl></div>)}

      {review.blockedReason && <div className="pv-alert pv-alert--bad" role="alert"><XCircle size={18} aria-hidden="true" /><div>{review.blockedReason}</div></div>}

      {review.canConfirm && (<>
        <div className="pv-panel"><h2>1 · Check your bank / UPI record</h2>
          <p className="pv__sub" style={{ margin: 0 }}>Open the real ELVORA receiving account and compare. Tick each line only when it is true.</p>
          <div className="pv-checks">{checks.map((a) => <label key={a.key} className={`pv-check ${ack[a.key] ? 'is-on' : ''}`}><input type="checkbox" checked={Boolean(ack[a.key])} onChange={(e) => setAck({ ...ack, [a.key]: e.target.checked })} /> <span>{a.text}</span></label>)}</div>
          <button type="button" className="pv-link" onClick={() => setAck(Object.fromEntries(checks.map((a) => [a.key, !allAck])))}>{allAck ? 'Untick all' : 'Tick all (I checked everything)'}</button>
          <label className="pv-field">Note (optional)<input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Only visible to admins" /></label>
        </div>
        {instant && <div className="pv-next"><strong>2 · When you approve, this happens automatically</strong>
          <ol><li>The student’s <b>offer letter</b> is issued now and appears in their Documents.</li><li>Their {plan(p.durationDays)} starts today.</li><li>Their <b>certificate</b> is issued on about <b>{endDate(p.durationDays)}</b>, when the plan period is over.</li></ol></div>}
        {rejecting && <div className="pv-panel"><h2>Reject this payment</h2>
          <label className="pv-field">Reason<select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Choose a reason…</option>{review.rejectReasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select></label>
          <label className="pv-field">Note {reason === 'OTHER' ? '(required, 10+ characters)' : '(optional)'}<input maxLength={300} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} /></label>
          <button type="button" className="pv-btn pv-btn--reject pv-btn--block" disabled={!reason || (reason === 'OTHER' && rejectNote.trim().length < 10) || busy} onClick={() => run(() => api.rejectPayment(p.id, review.submissionId, reason, rejectNote), 'Payment rejected. The student can send a corrected reference.')}>Confirm rejection</button></div>}
        <div className="pv-bar">
          <button type="button" className="pv-btn pv-btn--reject" disabled={busy} onClick={() => setRejecting((v) => !v)}><XCircle size={18} aria-hidden="true" /> Reject</button>
          <button type="button" className="pv-btn pv-btn--approve pv-btn--lg" disabled={!allAck || busy} onClick={() => run(() => api.confirmPayment(p.id, review.submissionId, ack, note), approved)}><BadgeCheck size={20} aria-hidden="true" /> {busy ? 'Working…' : allAck ? 'Approve payment' : 'Tick all checks to approve'}</button>
        </div></>)}

      {!review.canConfirm && !review.blockedReason && (
        <div className={`pv-alert ${p.status === 'VERIFIED' ? 'pv-alert--ok' : 'pv-alert--info'}`}><CheckCircle2 size={18} aria-hidden="true" /><div><strong>{d.status.label}</strong>{p.status === 'VERIFIED' ? `Approved ${when(p.verifiedAt)} by ${p.verifiedByName}. ${instant ? (d.request?.status === 'Certificate Issued' ? 'Offer letter and certificate have been issued.' : 'The offer letter was issued; the certificate follows when the plan period ends.') : ''}` : 'Nothing to do on this payment right now.'}</div></div>)}

      {d.previousAttempts.length > 0 && <div className="pv-panel"><h2>Earlier attempts</h2><ul className="pp-hist">{d.previousAttempts.map((s) => <li key={s.id}><code>{s.utr}</code> · {when(s.submittedAt)} · {s.decision ? `${s.decision.decision}${s.decision.reason ? ` (${s.decision.reason})` : ''}` : 'no decision'}</li>)}</ul></div>}
      {canRefund && p.status === 'VERIFIED' && <RefundPanel paymentId={p.id} />}
      <details className="pv-panel"><summary style={{ cursor: 'pointer', fontWeight: 700 }}>History</summary>
        <ol className="pv-steps" style={{ marginTop: 12 }}>{d.events.map((e, i) => <li key={i}><b>{e.event}{e.from || e.to ? ` (${e.from ?? '—'} → ${e.to ?? '—'})` : ''}</b>{when(e.at)} · {e.actor}{e.note ? ` · ${e.note}` : ''}</li>)}</ol></details>
    </section>
  );
}

export default function AdminPaymentVerificationPage() {
  usePageMeta('Payments');
  const [perms, setPerms] = useState(null); const [f, setF] = useState({ status: 'pending', durationDays: '', from: '', to: '', q: '' }); const [filters, setFilters] = useState(false);
  const [data, setData] = useState(null); const [open, setOpen] = useState(null); const [error, setError] = useState(null);
  const load = useCallback(async (x) => { try { setError(null); setData(await api.getQueue(x)); } catch (e) { setError(errText(e)); } }, []);
  useEffect(() => { api.getPermissions().then(setPerms).catch((e) => setError(errText(e))); }, []);
  useEffect(() => { if (!perms?.includes('payment.review')) return undefined; const t = setTimeout(() => load(f), f.q ? 300 : 0); return () => clearTimeout(t); }, [perms, f, load]);
  const counts = data?.counts ?? {}; const rows = useMemo(() => data?.payments ?? [], [data]);
  if (!perms) return <section className="pv"><p aria-busy="true">{error ?? 'Loading…'}</p></section>;
  if (!perms.includes('payment.review')) return <section className="pv"><h1>Payments</h1><div className="pv-alert pv-alert--bad" role="alert"><ShieldAlert size={18} aria-hidden="true" /><div>You do not have permission to verify payments. Ask an authorized administrator.</div></div></section>;
  if (open) return <Detail id={open} canRefund={perms.includes('payment.refund')} onClose={() => setOpen(null)} onChanged={() => load(f)} />;
  const tabCount = (k) => (k === '' ? null : counts[k]);
  return (
    <section className="pv">
      <div><h1>Payments</h1><p className="pv__sub">Check each payment against your bank record, then approve it. Nothing is approved automatically.</p></div>
      {error && <div className="pv-alert pv-alert--bad" role="alert"><XCircle size={18} aria-hidden="true" /><div>{error}</div></div>}
      {counts.overdue > 0 && f.status !== 'overdue' && <div className="pv-alert pv-alert--bad" role="alert"><Clock size={18} aria-hidden="true" /><div><strong>{counts.overdue} payment{counts.overdue > 1 ? 's are' : ' is'} taking longer than {data?.verificationTargetHours ?? 24} hours</strong><button type="button" className="pv-link" onClick={() => setF({ ...f, status: 'overdue' })}>Show them</button></div></div>}
      <div className="pv-pills" role="tablist" aria-label="Payment status">{TABS.map(([k, label]) => <button key={k || 'all'} type="button" role="tab" aria-selected={f.status === k} className={`pv-pill ${f.status === k ? 'is-on' : ''} ${k === 'pending' && counts.pending ? 'pv-pill--hot' : ''}`} onClick={() => setF({ ...f, status: k })}>{label}{tabCount(k) !== undefined && tabCount(k) !== null && <b>{tabCount(k)}</b>}</button>)}</div>
      <div className="pv-tools">
        <label className="pv-search"><Search size={18} aria-hidden="true" /><input aria-label="Search payments" placeholder="Search name, UTR or ID" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
        <button type="button" className="pv-link" onClick={() => setFilters((v) => !v)} aria-expanded={filters}>{filters ? 'Hide filters' : 'More filters'} <ChevronDown size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /></button>
        {filters && <div className="pv-more"><label>Plan<select value={f.durationDays} onChange={(e) => setF({ ...f, durationDays: e.target.value })}><option value="">All plans</option><option value="30">1 month</option><option value="60">2 months</option><option value="90">3 months</option></select></label>
          <label>From<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label><label>To<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label></div>}
      </div>
      {data && (rows.length === 0 ? <div className="pv-empty"><CheckCircle2 size={36} aria-hidden="true" /><strong>{f.status === 'pending' ? 'All caught up' : 'Nothing here'}</strong>{f.status === 'pending' ? 'No payments are waiting for you.' : 'No payments match.'}</div> : (
        <ul className="pv-list">{rows.map((r) => (
          <li key={r.paymentId} className={`pv-card ${r.overdue ? 'pv-card--overdue' : ''}`}>
            <div className="pv-card__top"><span className="pv-avatar" aria-hidden="true">{(r.studentName ?? '?').trim().charAt(0).toUpperCase()}</span>
              <div className="pv-card__who"><h3>{r.studentName}</h3><p>{plan(r.durationDays)} · {r.status === 'PENDING_VERIFICATION' ? `sent ${ago(r.elapsedSeconds)}` : when(r.submittedAt)}</p></div>
              <div className="pv-amount"><strong>{r.expectedDisplay}</strong><span>expected</span></div></div>
            <Tag k={r.statusKey} label={r.statusKey === 'PENDING_VERIFICATION' ? undefined : r.statusLabel} overdue={r.overdue} />
            <dl className="pv-facts">
              <div className="wide"><dt>UTR / reference</dt><dd>{r.utr ? <span className="pv-utr"><code>{r.utr}</code><Copy text={r.utr} /></span> : '—'}{r.duplicateWarning && <span className="pv-tag pv-tag--bad" style={{ marginLeft: 8 }}>⚠ seen before</span>}</dd></div>
              <div><dt>Paid on</dt><dd>{r.paymentDate ? `${r.paymentDate} ${r.paymentTime ?? ''}` : '—'}</dd></div><div><dt>UPI app</dt><dd>{r.upiApp ?? '—'}</dd></div>
            </dl>
            <div className="pv-card__actions">
              <button type="button" className={`pv-btn ${r.status === 'PENDING_VERIFICATION' ? 'pv-btn--approve' : 'pv-btn--ghost'}`} onClick={() => setOpen(r.paymentId)}>{r.status === 'PENDING_VERIFICATION' ? <><BadgeCheck size={18} aria-hidden="true" /> Review &amp; approve</> : 'View details'}</button>
              {r.proofUrl && <a className="pv-btn pv-btn--ghost" href={`${env.apiUrl}${r.proofUrl}`} target="_blank" rel="noreferrer"><FileText size={16} aria-hidden="true" /> Screenshot</a>}
            </div>
          </li>))}</ul>))}
    </section>
  );
}
