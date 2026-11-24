import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ShieldAlert, Upload, XCircle } from 'lucide-react';
import { usePageMeta } from '../../hooks/usePageMeta';
import * as api from '../../services/priorityPaymentAdminService';

// Admin: plan prices and the manual UPI account students pay into. The server checks the permission on every call; hiding a section here is only a convenience.
const blank = { upiId: '', payeeName: '', instructions: '', supportContact: '', verificationHours: 24, manualEnabled: false, submissionsEnabled: true };
const dt = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const Switch = ({ label, hint, checked, onChange }) => <label className="pp-switch"><span>{label}{hint && <small>{hint}</small>}</span><input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>;

export default function AdminPriorityPricingPage() {
  usePageMeta('Prices & UPI');
  const [tab, setTab] = useState('prices');
  const [perms, setPerms] = useState(null); const [pricing, setPricing] = useState(null); const [history, setHistory] = useState(null);
  const [edit, setEdit] = useState({}); const [preview, setPreview] = useState(null); const [cfg, setCfg] = useState(blank); const [cfgMeta, setCfgMeta] = useState(null);
  const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const fail = (e) => setMsg({ error: e.data?.error?.fields ? Object.values(e.data.error.fields).join(' ') : e.message });

  const load = useCallback(async () => {
    try {
      const p = await api.getPermissions(); setPerms(p);
      if (p.includes('pricing.manage')) { const [pr, h] = await Promise.all([api.getPricing(), api.getPricingHistory()]); setPricing(pr); setHistory(h); setEdit(Object.fromEntries(pr.prices.map((x) => [x.durationDays, String(x.amountPaise / 100)]))); }
      if (p.includes('payment.configure')) { const { config } = await api.getConfig(); setCfgMeta(config); setCfg({ ...blank, ...Object.fromEntries(Object.keys(blank).map((k) => [k, config[k] ?? blank[k]])) }); }
      if (!p.includes('pricing.manage') && p.includes('payment.configure')) setTab('upi');
    } catch (e) { fail(e); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const rows = () => Object.entries(edit).map(([d, v]) => ({ durationDays: Number(d), amountRupees: v }));
  const run = async (fn) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };

  if (!perms) return <section className="pp"><p aria-busy="true">{msg?.error ?? 'Loading…'}</p></section>;
  if (!perms.length) return <section className="pp"><h1>Prices &amp; UPI</h1><div className="pv-alert pv-alert--bad" role="alert"><ShieldAlert size={18} aria-hidden="true" /><div><strong>You don’t have permission yet</strong>Ask the site owner to run <code>node scripts/grant-payment-permission.mjs your-admin@email all</code> (or add your e-mail to <code>PAYMENT_ADMIN_EMAILS</code> in <code>.env</code>), then reload.</div></div></section>;
  const canP = perms.includes('pricing.manage') && pricing; const canC = perms.includes('payment.configure') && cfgMeta;
  return (
    <section className="pp">
      <div><h1>Prices &amp; UPI</h1><p className="pp__sub">What students pay, and the account they pay into.</p></div>
      {msg?.error && <div className="pv-alert pv-alert--bad" role="alert"><XCircle size={18} aria-hidden="true" /><div>{msg.error}</div></div>}
      {msg?.ok && <div className="pv-alert pv-alert--ok" role="status"><CheckCircle2 size={18} aria-hidden="true" /><div>{msg.ok}</div></div>}
      {canP && canC && <div className="pp-tabs" role="tablist"><button type="button" role="tab" aria-selected={tab === 'prices'} className={tab === 'prices' ? 'is-on' : ''} onClick={() => setTab('prices')}>Plan prices</button><button type="button" role="tab" aria-selected={tab === 'upi'} className={tab === 'upi' ? 'is-on' : ''} onClick={() => setTab('upi')}>UPI account</button></div>}

      {canP && tab === 'prices' && (<>
        <div className="pp-plans">{pricing.prices.map((p) => (
          <div className="pp-plan" key={p.durationDays}><span className="pp-plan__len">{p.months} month{p.months > 1 ? 's' : ''}</span><span className="pp-plan__now">Now {p.display}</span>
            <label className="pp-money"><span aria-hidden="true">₹</span><input aria-label={`New price for ${p.months} month plan`} inputMode="decimal" value={edit[p.durationDays] ?? ''} onChange={(e) => { setPreview(null); setEdit({ ...edit, [p.durationDays]: e.target.value }); }} /></label></div>))}</div>
        <p className="pp__sub">Prices include GST (to be confirmed). Students who already started an order keep the price they saw.</p>
        {!preview && <button type="button" className="pv-btn pv-btn--primary" style={{ justifySelf: 'start' }} disabled={busy} onClick={() => run(async () => setPreview(await api.previewPricing(rows())))}>Review price changes</button>}
        {preview && (<div className="pv-panel" aria-label="Price change preview">{preview.changes.length === 0 ? <p style={{ margin: 0 }}>Nothing changed. These are already the current prices.</p> : (<>
          <h2>Confirm new prices</h2><ul className="pp-hist" style={{ color: 'var(--text)' }}>{preview.changes.map((c) => <li key={c.durationDays}><b>{c.durationDays / 30} month{c.durationDays > 30 ? 's' : ''}:</b> {c.previousDisplay} → {c.nextDisplay}</li>)}</ul>
          <button type="button" className="pv-btn pv-btn--approve" disabled={busy} onClick={() => run(async () => { await api.savePricing(rows()); setPreview(null); setMsg({ ok: 'New prices saved.' }); await load(); })}>Save new prices</button></>)}
          <button type="button" className="pv-link" onClick={() => setPreview(null)}>Cancel</button></div>)}
        {history && <details className="pv-panel"><summary style={{ cursor: 'pointer', fontWeight: 700 }}>Price history</summary><ul className="pp-hist" style={{ marginTop: 12 }}>{history.versions.map((v) => <li key={v.version}>v{v.version} · {new Date(v.createdAt).toLocaleDateString()} · {v.prices.map((p) => `${p.months}m ${p.display}`).join(' · ')}</li>)}</ul></details>}
      </>)}

      {canC && tab === 'upi' && (<>
        <div className={`pv-alert ${cfgMeta.ready ? 'pv-alert--ok' : 'pv-alert--warn'}`}>{cfgMeta.ready ? <CheckCircle2 size={18} aria-hidden="true" /> : <ShieldAlert size={18} aria-hidden="true" />}<div><strong>{cfgMeta.ready ? 'Students can pay' : 'Not ready: students can’t see payment options yet'}</strong>{cfgMeta.updatedAt ? `Last saved ${dt(cfgMeta.updatedAt)} by ${cfgMeta.updatedByName}.` : 'Fill in the details below and save.'}</div></div>
        <form className="pp-form" onSubmit={(e) => { e.preventDefault(); run(async () => { const destChanged = cfgMeta && (cfg.upiId !== (cfgMeta.upiId ?? '') || cfg.payeeName !== (cfgMeta.payeeName ?? ''));
          if (destChanged && !window.confirm(`Students will pay ${cfg.upiId} (${cfg.payeeName}). Is this the correct ELVORA account?`)) return;
          const r = await api.saveConfig({ ...cfg, verificationHours: Number(cfg.verificationHours) }, Boolean(destChanged)); setCfgMeta(r.config); setMsg({ ok: r.changed.length ? 'Settings saved.' : 'No changes.' }); }); }}>
          <div className="pp-grid">
            <label className="pv-field">UPI ID<input value={cfg.upiId} onChange={(e) => setCfg({ ...cfg, upiId: e.target.value })} autoComplete="off" placeholder="name@bank" /></label>
            <label className="pv-field">Name shown to students<input value={cfg.payeeName} onChange={(e) => setCfg({ ...cfg, payeeName: e.target.value })} /></label>
            <label className="pv-field">Support phone or e-mail<input value={cfg.supportContact} onChange={(e) => setCfg({ ...cfg, supportContact: e.target.value })} /></label>
            <label className="pv-field">Check payments within (hours)<input type="number" min="1" max="168" value={cfg.verificationHours} onChange={(e) => setCfg({ ...cfg, verificationHours: e.target.value })} /></label>
          </div>
          <label className="pv-field">Message shown with the QR code<textarea rows={3} value={cfg.instructions} onChange={(e) => setCfg({ ...cfg, instructions: e.target.value })} placeholder="Example: Pay the exact amount and keep your UTR number." /></label>
          <Switch label="Accept UPI payments" hint="Turn off to hide payment options from students." checked={cfg.manualEnabled} onChange={(v) => setCfg({ ...cfg, manualEnabled: v })} />
          <Switch label="Students can submit their UTR" hint="Turn off to pause new submissions." checked={cfg.submissionsEnabled} onChange={(v) => setCfg({ ...cfg, submissionsEnabled: v })} />
          <button type="submit" className="pv-btn pv-btn--primary pv-btn--lg" disabled={busy}>{busy ? 'Saving…' : 'Save UPI settings'}</button>
        </form>
        <div className="pv-panel"><h2>Official QR image</h2>
          <p className="pp__sub" style={{ margin: 0 }}>{cfgMeta.qrImage?.configured ? `Your own QR image is in use (updated ${dt(cfgMeta.qrImage.updatedAt)}).` : 'No image uploaded. Students get a QR generated from your UPI ID.'} PNG or JPEG, up to 500 KB.</p>
          <div className="pp-qr"><label className="pp-file"><Upload size={18} aria-hidden="true" /> Choose QR image<input type="file" accept="image/png,image/jpeg" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && window.confirm('This changes where students pay. Is this the official ELVORA QR code?')) run(async () => { const r = await api.uploadQr(f); setCfgMeta(r.config); setMsg({ ok: 'QR image updated.' }); }); }} /></label></div></div>
      </>)}
    </section>
  );
}
