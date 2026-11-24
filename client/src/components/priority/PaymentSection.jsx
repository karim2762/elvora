import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Copy, FileCheck2, Smartphone } from 'lucide-react';
import { listRequests, getPaymentInfo, createPaymentOrder, listPayments, getPayment, submitPayment, resubmitPayment, uploadProof } from '../../services/priorityService';

// Student payment area inside the private Priority portal. Everything shown (amount, payee, QR, UPI link, status) comes from the server.
// Nothing here says a payment was received: it only reports what the student submitted and what the server says about its status.
const APPS = ['Google Pay', 'PhonePe', 'Paytm', 'BHIM', 'Amazon Pay', 'WhatsApp', 'Bank app', 'Other'];

export function Timeline({ steps }) {
  return (<ol className="sp-tl" aria-label="Payment status timeline">{steps.map((s) => (
    <li key={s.key} className={s.state === 'done' ? 'done' : s.state === 'current' ? 'current' : s.state === 'failed' ? 'failed' : ''}><b>{s.label}</b>
      <small>{[s.at && new Date(s.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), s.deadline && `we aim to verify by ${new Date(s.deadline).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`, s.note].filter(Boolean).join(' · ')}</small></li>))}</ol>);
}

export default function PaymentSection({ applicationId }) {
  const [state, setState] = useState({ loading: true });
  const [form, setForm] = useState({ utr: '', paymentDate: new Date().toISOString().slice(0, 10), paymentTime: '', upiApp: '', note: '' });
  const [reason, setReason] = useState(''); const [file, setFile] = useState(null); const [review, setReview] = useState(false); const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [info, reqs, pays] = await Promise.all([getPaymentInfo(), listRequests(), listPayments()]);
      const request = reqs.find((r) => r.applicationId === applicationId && !['Rejected', 'Cancelled', 'Refunded'].includes(r.status)) ?? null;
      const mine = pays.filter((p) => p.applicationId === applicationId);
      const live = mine.find((p) => ['AWAITING_PAYMENT', 'PENDING_VERIFICATION', 'REJECTED', 'VERIFIED', 'REFUND_PENDING'].includes(p.status));
      setState({ info, request, payments: mine, detail: live ? await getPayment(live.id) : null });
    } catch (e) { setState({ error: e.message }); }
  }, [applicationId]);
  useEffect(() => { setState({ loading: true }); setReview(false); setOk(false); setErr(null); load(); }, [load]);

  // A paid plan waits for an administrator to verify the payment, then the certificate is issued. Re-check quietly so the student sees it without reloading.
  const watching = Boolean(state.request?.instant) && (state.request?.status === 'Payment Verified' || state.detail?.payment?.status === 'PENDING_VERIFICATION');
  useEffect(() => { if (!watching) return undefined; const t = setInterval(load, 20000); return () => clearInterval(t); }, [watching, load]);

  if (state.loading) return null;
  if (state.error) return <section className="pc__card"><p role="alert" className="pc__msg">{state.error}</p></section>;
  const { info, request, detail } = state;
  const pay = detail?.payment;
  if (!request && !pay) return null;
  const run = async (fn) => { setBusy(true); setErr(null); try { await fn(); await load(); } catch (e) { setErr(e.data?.error?.fields ? Object.values(e.data.error.fields).join(' ') : e.message); } finally { setBusy(false); } };
  const submit = () => run(async () => {
    let proofId; if (file) proofId = (await uploadProof(pay.id, file)).proofId;
    await submitPayment(pay.id, { ...form, upiApp: form.upiApp || undefined, note: form.note || undefined, proofId, amountPaise: pay.amountPaise, confirmed: true }); setOk(true); setReview(false);
  });
  const resubmit = () => run(async () => {
    let proofId; if (file) proofId = (await uploadProof(pay.id, file)).proofId;
    await resubmitPayment(pay.id, { ...form, reason, upiApp: form.upiApp || undefined, note: form.note || undefined, proofId, amountPaise: pay.amountPaise, confirmed: true }); setOk(true); setReview(false); setReason('');
  });
  const copy = async () => { try { await navigator.clipboard.writeText(detail.pay.upiId); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setErr('Copy failed. Select the UPI ID and copy it manually.'); } };

  if (request?.status === 'Certificate Issued') return (
    <section className="pc__card sp" aria-label="Certificate issued"><div className="sp-ok" role="status"><strong><FileCheck2 size={18} aria-hidden="true" style={{ verticalAlign: '-3px' }} /> Your certificate is ready</strong>Your plan is complete. Open Documents to view or download your offer letter and certificate.<Link className="sp-btn sp-btn--primary" to="/student/documents">Open Documents</Link></div></section>);
  const issuing = request?.instant && request.status === 'Payment Verified';

  return (
    <section className="pc__card sp" aria-label="Priority payment"><h2>Payment</h2>
      {issuing && <div className="sp-ok" role="status"><strong><CheckCircle2 size={18} aria-hidden="true" style={{ verticalAlign: '-3px' }} /> Payment approved</strong>Your plan has started and your offer letter is in Documents. Your completion certificate will be issued automatically when your plan period ends.<span><Link className="sp-btn sp-btn--primary" to="/student/documents">Open Documents</Link> <button type="button" className="sp-btn sp-btn--ghost" onClick={load}>Refresh</button></span></div>}
      {!pay && !info.ready && <div className="sp-note" role="status"><strong>Payment is not available right now.</strong> {info.message}</div>}
      {!pay && info.ready && request?.status === 'Draft' && (<>
        <div className="sp-amount"><div><small>Plan fee</small><strong>{request.amountDisplay}</strong></div><small>Paid by UPI · checked by ELVORA</small></div>
        <button type="button" className="sp-btn sp-btn--primary" disabled={busy} onClick={() => run(() => createPaymentOrder(request.id))}>{busy ? 'Please wait…' : 'Continue to payment'}</button></>)}

      {pay?.status === 'AWAITING_PAYMENT' && detail.pay && (<>
        <div className="sp-amount"><div><small>{pay.months}-month plan · pay exactly</small><strong>{pay.amountDisplay}</strong></div><small>Step 1 of 2: pay by UPI</small></div>
        <div className="sp-pay">
          <div className="sp-qr"><img src={detail.pay.qrDataUrl} alt={`UPI QR code for ${pay.amountDisplay} to ${detail.pay.payeeName}`} width="220" height="220" /></div>
          <div><small>Paying to</small><br /><strong>{detail.pay.payeeName}</strong></div>
          <div className="sp-upi"><code>{detail.pay.upiId}</code><button type="button" className="sp-btn sp-btn--ghost" onClick={copy}><Copy size={16} aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}</button></div>
          <a className="sp-btn sp-btn--primary" href={detail.pay.upiIntent}><Smartphone size={18} aria-hidden="true" /> Open in UPI app</a>
        </div>
        <p className="sp-note" role="note"><strong>Before you pay:</strong> the name in your UPI app must read “{detail.pay.payeeName}”. Don’t pay a different name or amount.</p>
        <ol className="sp-steps">{detail.pay.info.steps.map((st) => <li key={st}>{st}</li>)}</ol>
        <p className="sp-steps" style={{ margin: 0 }}>{detail.pay.info.instructions} Need help? {detail.pay.info.supportContact}. We usually verify within {detail.pay.info.verificationHours} hours.</p>
        {detail.pay.info.submissionsOpen === false && <p role="status" className="sp-note">{detail.pay.info.submissionsMessage}</p>}
        {detail.pay.info.submissionsOpen !== false && !review && (<form className="sp-form" onSubmit={(e) => { e.preventDefault(); setReview(true); }}><h3>Step 2 of 2: tell us you paid</h3>
          <label>UTR / transaction number<input required minLength={8} maxLength={40} inputMode="text" placeholder="12-digit number from your UPI app" value={form.utr} onChange={(e) => setForm({ ...form, utr: e.target.value })} autoComplete="off" /></label>
          <label>Amount paid<input value={pay.amountDisplay} readOnly aria-readonly="true" /></label>
          <div className="sp-two"><label>Date<input type="date" required value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} /></label>
            <label>Time (about)<input type="time" required value={form.paymentTime} onChange={(e) => setForm({ ...form, paymentTime: e.target.value })} /></label></div>
          <label>UPI app (optional)<select value={form.upiApp} onChange={(e) => setForm({ ...form, upiApp: e.target.value })}><option value="">Choose…</option>{APPS.map((a) => <option key={a}>{a}</option>)}</select></label>
          <label>Screenshot (optional)<input type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <label>Note (optional)<textarea maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          <button type="submit" className="sp-btn sp-btn--primary">Review &amp; submit</button></form>)}
        {review && (<div className="sp-form" role="group" aria-label="Confirm payment details"><h3>Please check your details</h3>
          <p style={{ margin: 0 }}>UTR: <strong>{form.utr.replace(/\s+/g, '').toUpperCase()}</strong><br />Amount: <strong>{pay.amountDisplay}</strong><br />Paid: {form.paymentDate} {form.paymentTime}{form.upiApp ? ` · ${form.upiApp}` : ''}{file ? ` · ${file.name}` : ''}</p>
          <p className="sp-note">You can’t edit this after submitting. Submitting is not the same as approval: ELVORA checks it against its bank record first.</p>
          <button type="button" className="sp-btn sp-btn--primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit'}</button> <button type="button" className="sp-btn sp-btn--ghost" disabled={busy} onClick={() => setReview(false)}>Back</button></div>)}
      </>)}

      {pay?.status === 'REJECTED' && (<div className="sp-bad" role="group" aria-label="Payment not accepted"><h3>Payment not accepted</h3>
        <p style={{ margin: 0 }}>Reason: <strong>{pay.rejection?.reason}</strong>{pay.rejection?.note ? ` — ${pay.rejection.note}` : ''}. Your earlier submission stays on record.</p>
        {pay.canResubmit ? (<form className="sp-form" onSubmit={(e) => { e.preventDefault(); resubmit(); }}><h3 style={{ color: 'var(--text)' }}>Send a corrected reference ({pay.revisionsLeft} left)</h3>
          <label>What was wrong?<textarea required minLength={10} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label>UTR / transaction number<input required minLength={8} maxLength={40} value={form.utr} onChange={(e) => setForm({ ...form, utr: e.target.value })} autoComplete="off" /></label>
          <div className="sp-two"><label>Date<input type="date" required value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} /></label>
            <label>Time (about)<input type="time" required value={form.paymentTime} onChange={(e) => setForm({ ...form, paymentTime: e.target.value })} /></label></div>
          <label>UPI app (optional)<select value={form.upiApp} onChange={(e) => setForm({ ...form, upiApp: e.target.value })}><option value="">Choose…</option>{APPS.map((a) => <option key={a}>{a}</option>)}</select></label>
          <label>New screenshot (optional)<input type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <button type="submit" className="sp-btn sp-btn--primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit correction'}</button></form>) : <p style={{ margin: 0 }}>No more corrections are allowed. Please contact support.</p>}</div>)}
      {pay && pay.status !== 'AWAITING_PAYMENT' && <p className="sp-steps" style={{ margin: 0 }}>Payment {pay.internalReference ?? pay.id} · {pay.amountDisplay} · <strong>{pay.status.replace(/_/g, ' ').toLowerCase()}</strong></p>}
      {(ok || pay?.status === 'PENDING_VERIFICATION') && <div className="sp-ok" role="status"><strong>Payment details received</strong>{pay?.message ?? 'ELVORA’s team will check the transaction, normally within 24 hours. When it is approved, your offer letter is issued right away.'}</div>}
      {pay && <Timeline steps={pay.timeline} />}
      {err && <p role="alert" className="sp-bad">{err}</p>}
    </section>
  );
}
