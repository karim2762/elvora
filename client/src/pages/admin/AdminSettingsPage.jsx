import { useEffect, useRef, useState } from 'react';
import { TriangleAlert, RefreshCw, CheckCircle2 } from 'lucide-react';
import Button from '../../components/ui/Button';
import { TextField, TextAreaField } from '../../components/forms/Field';
import { useToast } from '../../components/ui/Toast';
import { usePageMeta } from '../../hooks/usePageMeta';
import * as api from '../../services/adminManagementService';

const sessionEnded = (e) => e?.status === 401 || e?.status === 403;
const TEXT = [['organizationName', 'Organization name'], ['contactEmail', 'Contact e-mail'], ['website', 'Website'], ['signatoryName', 'Authorized signatory name'], ['signatoryTitle', 'Authorized signatory title'], ['documentFooter', 'Document footer (optional)']];
const COLORS = [['colorPrimary', 'Primary colour'], ['colorAccent', 'Accent colour'], ['colorInk', 'Text colour']];
const pick = (s) => Object.fromEntries([...TEXT, ['address'], ...COLORS].map(([k]) => [k, s.fields[k].value ?? '']));

export default function AdminSettingsPage() {
  usePageMeta('Settings · Admin');
  const toast = useToast();
  const [s, setS] = useState(null); const [error, setError] = useState(null);
  const [v, setV] = useState({}); const [flags, setFlags] = useState({});
  const [errs, setErrs] = useState({}); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const file = useRef(null);
  const apply = (n) => { setS(n); setV(pick(n)); setFlags({ signatureEnabled: n.fields.signatureEnabled.value, emailDocuments: n.fields.emailDocuments.value }); };
  const load = () => { setError(null); api.getSettings().then(apply).catch(setError); };
  useEffect(load, []);
  const set = (k, val) => { setV((x) => ({ ...x, [k]: val })); setErrs((e) => ({ ...e, [k]: undefined })); };
  const fail = (e) => { setMsg(e.message || 'Something went wrong.'); setErrs(e.data?.error?.fields ?? {}); };
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setMsg(''); setErrs({});
    const patch = { ...v, ...flags };
    try { const n = await api.updateSettings(patch); apply(n); toast.success(n.changed.length ? 'Settings saved.' : 'No changes to save.'); } catch (x) { fail(x); } finally { setBusy(false); }
  };
  const logo = async (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type) || f.size > 512 * 1024) { setMsg('The logo must be a PNG or JPEG of 512 KB or less.'); return; }
    setBusy(true); setMsg('');
    try { apply(await api.uploadLogo(f)); toast.success('Logo updated.'); } catch (x) { fail(x); } finally { setBusy(false); }
  };
  const dropLogo = async () => { setBusy(true); setMsg(''); try { apply(await api.removeLogo()); toast.success('Custom logo removed.'); } catch (x) { fail(x); } finally { setBusy(false); } };

  if (error) return (
    <div className="empty" role="alert"><span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span><h3>Couldn’t load settings</h3>
      <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended. Sign in again.' : 'Something went wrong. Please try again.'}</p>
      {sessionEnded(error) ? <Button to="/admin/login">Sign in</Button> : <Button icon={RefreshCw} onClick={load}>Try again</Button>}</div>);
  if (!s) return <div className="card asks" aria-hidden="true">{[0, 1, 2, 3].map((n) => <i key={n} className="sk sk--line" />)}</div>;
  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><h1>Settings</h1><p className="text-muted">Organization details used on documents and notices. Clearing a field returns it to the server’s configured value.</p></div></header>
      <div className={`card ${s.issuanceReadiness.ready ? '' : 'adm-warn'}`} role="status">
        <p><CheckCircle2 size={16} aria-hidden="true" /> {s.issuanceReadiness.ready ? 'Organization details are complete for issuing documents.' : `Missing for issuing documents: ${s.issuanceReadiness.missing.join(', ')}.`}</p>
        <p className="text-muted">These settings change branding and details only. Eligibility checks, approvals and revocation rules for documents can’t be changed here. Registration claims (MSME/Udyam) appear on documents only when verified in the server configuration{s.registration.shownOnDocuments ? ' (currently shown)' : ' (currently not shown)'}.</p>
      </div>
      <form className="card" onSubmit={save} noValidate>
        {TEXT.map(([k, l]) => <TextField key={k} label={l} name={k} value={v[k] ?? ''} onChange={set} error={errs[k]} hint={s.fields[k].source === 'environment' ? 'Using the server default' : undefined} maxLength={200} />)}
        <TextAreaField label="Official address" name="address" rows={3} maxLength={300} value={v.address ?? ''} onChange={set} error={errs.address} />
        {COLORS.map(([k, l]) => <TextField key={k} label={`${l} (hex)`} name={k} value={v[k] ?? ''} onChange={set} error={errs[k]} maxLength={7} placeholder="#1D4ED8" />)}
        <label className="adm-check"><input type="checkbox" checked={!!flags.signatureEnabled} onChange={(e) => setFlags((f) => ({ ...f, signatureEnabled: e.target.checked }))} /> Show digital signature on documents</label>
        <label className="adm-check"><input type="checkbox" checked={!!flags.emailDocuments} onChange={(e) => setFlags((f) => ({ ...f, emailDocuments: e.target.checked }))} /> E-mail documents to students when issued</label>
        <p className="text-muted">{s.notifications.emailConfigured ? 'E-mail delivery is configured on the server.' : 'E-mail delivery is not configured on the server, so documents are only available in the student dashboard.'} E-mail credentials are set in server environment variables and never shown here.</p>
        {msg && <p className="field__error" role="alert">{msg}</p>}
        {errs._ && <p className="field__error" role="alert">{errs._}</p>}
        <Button type="submit" disabled={busy}>Save settings</Button>
      </form>
      <section className="card" aria-labelledby="logo-h">
        <h2 id="logo-h">Organization logo</h2>
        <p className="text-muted">{s.logo.custom ? 'A custom logo is in use on documents.' : 'The default logo is in use.'} PNG or JPEG, up to 512 KB.</p>
        <div className="adm-actions">
          <input ref={file} type="file" accept="image/png,image/jpeg" onChange={logo} hidden />
          <Button variant="secondary" onClick={() => file.current?.click()} disabled={busy}>Upload logo</Button>
          {s.logo.custom && <Button variant="secondary" onClick={dropLogo} disabled={busy}>Use default logo</Button>}
        </div>
      </section>
    </div>
  );
}
