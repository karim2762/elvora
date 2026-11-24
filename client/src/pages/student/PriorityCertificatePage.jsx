import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import { usePageMeta } from '../../hooks/usePageMeta';
import { getAccess, redeemInvite, getPortal, getPlans, choosePlan, listMyCorrections } from '../../services/priorityService';
import PaymentSection from '../../components/priority/PaymentSection';
import '../../styles/priority.css';

// Private page: not linked from any public navigation. Every decision shown here (access, eligibility, fee) comes from the server.
const ACCESS_MSG = {
  invitation_required: ['Invitation required', 'This private service is available by invitation only. Open the invitation link you received while signed in.'],
  expired: ['Invitation expired', 'Your access invitation has expired. Please ask ELVORA for a new one.'],
  revoked: ['Invitation revoked', 'Your access invitation has been revoked.'],
};
const PLAN_TEXT = { 1: 'A one-month internship certificate.', 2: 'A two-month internship certificate.', 3: 'A three-month internship certificate.' };
const inr = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const BADGE = { Draft: 'Draft saved', 'Awaiting Payment': 'Awaiting payment', 'Payment Pending': 'Payment under verification', 'Payment Verified': 'Payment verified', 'Certificate Issued': 'Certificate issued' };

function MyCorrections() {
  const [d, setD] = useState(null);
  useEffect(() => { listMyCorrections().then(setD).catch(() => setD(null)); }, []);
  if (!d?.corrections?.length) return null;
  return (<section className="pc__card" aria-label="Your corrections"><h2>Corrections to your documents</h2><p>{d.notice}</p>
    <ul className="pc__list">{d.corrections.map((c) => <li key={c.id}>{c.categoryLabel} — <strong>{c.status}</strong> (free){c.replacementDocumentNumber ? ` · new certificate ${c.replacementDocumentNumber} is in Documents` : ''}</li>)}</ul></section>);
}

export default function PriorityCertificatePage() {
  usePageMeta('Internship Certificate');
  const [phase, setPhase] = useState({ status: 'loading' });
  const [data, setData] = useState(null);
  const [plans, setPlans] = useState([]);
  const [selected, setSelected] = useState(null); // months
  const [confirm, setConfirm] = useState({ personal: false, academic: false });
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { // keep the page out of search indexes
    const m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex, nofollow'; document.head.appendChild(m);
    return () => m.remove();
  }, []);

  const load = useCallback(async () => {
    setPhase({ status: 'loading' });
    try {
      // Invitation links carry the token in the URL fragment (never sent to servers or referrers); it is removed from the address bar immediately.
      const m = /(?:^|[#&])invite=([\w-]+)/.exec(window.location.hash);
      let access;
      if (m) { window.history.replaceState(null, '', window.location.pathname); access = await redeemInvite(m[1]); } else access = await getAccess();
      if (!access.granted) { setPhase({ status: 'denied', state: access.state }); return; }
      const [portal, p] = await Promise.all([getPortal(), getPlans()]);
      setData(portal); setPlans(p.plans); setPhase({ status: 'ready' });
    } catch (err) {
      const code = err?.data?.error?.code;
      if (err?.status === 403 && /^PRIORITY_/.test(code || '')) setPhase({ status: 'denied', state: code === 'PRIORITY_EXPIRED' ? 'expired' : code === 'PRIORITY_REVOKED' ? 'revoked' : code === 'PRIORITY_INVITATION_REQUIRED' ? 'invitation_required' : 'invalid', message: err.message });
      else if (err?.status === 401) setPhase({ status: 'denied', state: 'unauthorized' });
      else setPhase({ status: 'error', message: err?.message });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pick = (pl) => {
    setSelected(pl.months); setError(null); setConfirm({ personal: false, academic: false });
    setRequest(pl.request ? { id: pl.request.id, applicationId: pl.request.applicationId, status: pl.request.status } : null); // a plan already started goes straight back to its payment
  };
  const start = async () => {
    setBusy(true); setError(null);
    try { const r = await choosePlan(selected, confirm.personal, confirm.academic); setRequest(r.request); setPlans((list) => list.map((x) => (x.months === selected ? { ...x, request: { id: r.request.id, status: r.request.status, applicationId: r.request.applicationId } } : x))); }
    catch (err) { setError(err?.message); } finally { setBusy(false); }
  };

  if (phase.status === 'loading') return <div className="pc" aria-busy="true"><div className="pc__card"><Loader2 className="spin" aria-hidden="true" /> Loading…</div></div>;
  if (phase.status === 'denied') {
    const [t, msg] = ACCESS_MSG[phase.state] ?? (phase.state === 'unauthorized' ? ['Please sign in', 'Sign in to your ELVORA account to continue.'] : ['Access unavailable', phase.message || 'This invitation could not be used with this account.']);
    return <div className="pc"><div className="pc__card" role="alert"><h2>{t}</h2><p>{msg}</p><Link className="btn btn--secondary" to="/student/dashboard">Back to dashboard</Link></div><MyCorrections /></div>;
  }
  if (phase.status === 'error') return <div className="pc"><div className="pc__card" role="alert"><h2>Something went wrong</h2><p>{phase.message || 'We couldn’t load this page.'}</p><button type="button" className="btn btn--primary" onClick={load}>Try again</button></div></div>;

  const id = data.identity;
  const sel = plans.find((p) => p.months === selected);
  return (
    <main className="pc">
      <header className="pc__hero"><h1><ShieldCheck size={28} aria-hidden="true" /> ELVORA Internship Certificate</h1><p>Choose a 1, 2 or 3 month plan and pay. Your offer letter arrives as soon as your payment is approved, and your certificate follows when your plan period is completed.</p></header>

      <section className="pc__card" aria-label="How it works"><h2>How it works</h2>
        <ol className="pc__list"><li>Choose 1, 2 or 3 months.</li><li>Pay the plan fee by UPI and submit your transaction reference.</li><li>ELVORA verifies your payment (usually within 24 hours).</li><li>ELVORA sets your start and end dates and your project. You don’t choose them.</li><li>Your <b>offer letter</b> is issued under <Link to="/student/documents">Documents</Link> once your dates are set, and your plan starts.</li><li>When the plan period ends, your <b>completion certificate</b> is issued there too.</li></ol></section>

      <section className="pc__card" aria-label="Your details"><h2>Your details</h2>
        <p>{id.fullName} · {id.email}<br />{id.degree}, {id.branch} · {id.college} · {id.academicYear}, {id.graduationYear}</p>
        <p className="pc__notice">Your certificate is printed with the name above. Please check it before you pay.</p></section>

      <section className="pc__card" aria-label="Choose a plan"><h2>Choose your plan</h2>
        <p className="pc__hint">Select one plan to continue.</p>
        {plans.length === 0 ? <p className="pc__msg">Plans are not available right now. Please try again later.</p> : (
          <div style={{ display: 'grid', gap: 12 }}>{plans.map((pl) => (
            <button type="button" key={pl.months} className="pc__opt" aria-pressed={selected === pl.months} onClick={() => pick(pl)} disabled={pl.request?.status === 'Certificate Issued'}>
              <strong>{pl.months} {pl.months === 1 ? 'month' : 'months'}</strong><span className="pc__opt-price">{inr(pl.amountPaise)}</span><span>{PLAN_TEXT[pl.months]}</span>
              {pl.request && <span className={`pc__badge ${pl.request.status === 'Certificate Issued' ? 'pc__badge--ok' : 'pc__badge--wait'}`}>{BADGE[pl.request.status] ?? pl.request.status}</span>}
            </button>))}
          </div>)}
        <p className="pc__notice">Fees are fixed by ELVORA and cannot be changed. Choose the plan that matches the internship length you want on your certificate.</p>
      </section>

      {sel && !request && (
        <section className="pc__card" aria-label="Confirm your plan"><h2>{sel.months}-month plan · {inr(sel.amountPaise)}</h2>
          <label className="pc__row"><input type="checkbox" checked={confirm.personal} onChange={(e) => setConfirm({ ...confirm, personal: e.target.checked })} /> My name and contact details above are correct.</label>
          <label className="pc__row"><input type="checkbox" checked={confirm.academic} onChange={(e) => setConfirm({ ...confirm, academic: e.target.checked })} /> My academic details above are correct.</label>
          <p><button type="button" className="btn btn--primary" disabled={busy || !confirm.personal || !confirm.academic} onClick={start}>{busy ? 'Please wait…' : 'Continue to payment'}</button></p>
          {error && <p role="alert" className="pc__msg">{error}</p>}
        </section>)}
      {sel && request && <PaymentSection key={request.id} applicationId={request.applicationId} />}
      <MyCorrections />
    </main>
  );
}
