import { useCallback, useEffect, useState } from 'react';
import * as api from '../../services/priorityPaymentAdminService';

// Stage 10B Part 2B — manual refunds for ONE verified payment. A refund record is not a refund: REFUNDED needs the real refund reference and a tick that the
// actual bank/UPI account record was checked. The server enforces the permission, the balance and every status rule; this panel only collects input.
const errText = (e) => (e.data?.error?.fields ? Object.values(e.data.error.fields).join(' ') : e.message);
const when = (t) => (t ? new Date(t).toLocaleString() : '—');

export default function RefundPanel({ paymentId }) {
  const [d, setD] = useState(null); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ amountRupees: '', reason: '', destination: '', notes: '' });
  const [fin, setFin] = useState({}); const [rej, setRej] = useState({});
  const load = useCallback(async () => { try { setD(await api.getRefundSummary(paymentId)); } catch (e) { setMsg({ error: errText(e) }); } }, [paymentId]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, ok) => { setBusy(true); setMsg(null); try { await fn(); setMsg({ ok }); await load(); } catch (e) { setMsg({ error: errText(e) }); await load(); } finally { setBusy(false); } };
  if (!d) return <p aria-busy="true">{msg?.error ?? 'Loading refunds…'}</p>;
  const b = d.balance;
  return (
    <section aria-label="Refunds">
      <h3>Refunds</h3>
      <p role="note"><strong>{d.notice}</strong></p>
      {msg?.error && <p role="alert">{msg.error}</p>}{msg?.ok && <p role="status">{msg.ok}</p>}
      <p>Confirmed payment {b.confirmedDisplay} · still refundable <strong>{b.availableDisplay}</strong></p>
      {d.refunds.length > 0 && (
        <table><thead><tr><th>Refund</th><th>Amount</th><th>Status</th><th>Destination</th><th>Details</th><th>Action</th></tr></thead><tbody>
          {d.refunds.map((r) => (<tr key={r.id}><td>{r.id}<br /><small>{when(r.requestedAt)} by {r.requestedByName}</small></td><td>{r.amountDisplay}</td><td><strong>{r.status.replace(/_/g, ' ')}</strong></td><td>{r.destination}</td>
            <td>{r.reason}{r.refundUtr && <><br />Reference <code>{r.refundUtr}</code> ({when(r.completedAt)} by {r.completedByName})</>}{r.rejectionReason && <><br />Declined: {r.rejectionReason}</>}</td>
            <td>
              {r.status === 'REFUND_REQUESTED' && <button type="button" disabled={busy} onClick={() => run(() => api.refundPending(r.id), 'Refund approved for processing. Nothing has been sent yet.')}>Mark pending</button>}
              {r.status === 'REFUND_PENDING' && (<fieldset disabled={busy}><legend>Complete only after checking the actual account record</legend>
                <label>Refund UTR / reference<input value={fin[r.id]?.utr ?? ''} onChange={(e) => setFin({ ...fin, [r.id]: { ...fin[r.id], utr: e.target.value } })} /></label>
                {d.acknowledgements.map((a) => <label key={a.key} style={{ display: 'block' }}><input type="checkbox" checked={Boolean(fin[r.id]?.[a.key])} onChange={(e) => setFin({ ...fin, [r.id]: { ...fin[r.id], [a.key]: e.target.checked } })} /> {a.text}</label>)}
                <button type="button" disabled={!fin[r.id]?.utr || !d.acknowledgements.every((a) => fin[r.id]?.[a.key])} onClick={() => run(() => api.refundComplete(r.id, { refundUtr: fin[r.id].utr, acknowledgements: Object.fromEntries(d.acknowledgements.map((a) => [a.key, true])) }), 'Refund recorded as completed.')}>Mark refunded</button></fieldset>)}
              {['REFUND_REQUESTED', 'REFUND_PENDING'].includes(r.status) && (<><label>Decline reason<input maxLength={300} value={rej[r.id] ?? ''} onChange={(e) => setRej({ ...rej, [r.id]: e.target.value })} /></label>
                <button type="button" disabled={busy || (rej[r.id] ?? '').trim().length < 10} onClick={() => run(() => api.refundReject(r.id, rej[r.id]), 'Refund declined. The student has been notified that nothing was sent.')}>Decline refund</button></>)}
            </td></tr>))}
        </tbody></table>)}
      {d.canRequest && (
        <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api.createRefund(paymentId, form); setForm({ amountRupees: '', reason: '', destination: '', notes: '' }); }, 'Refund request recorded. This does not send money.'); }}>
          <fieldset disabled={busy}><legend>Start a refund request</legend>
            <label>Amount (₹)<input inputMode="decimal" value={form.amountRupees} onChange={(e) => setForm({ ...form, amountRupees: e.target.value })} /></label>
            <label>Reason<input maxLength={300} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
            <label>Refund destination (UPI ID or “original payment account”)<input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} /></label>
            <label>Notes (internal)<input maxLength={500} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
            <button type="submit">Record refund request</button></fieldset></form>)}
    </section>
  );
}
