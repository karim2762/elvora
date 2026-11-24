import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Plus, Search, TriangleAlert, RefreshCw, ShieldCheck, ShieldAlert, ExternalLink } from 'lucide-react';
import Button from '../../components/ui/Button';
import Pagination from '../../components/applications/Pagination';
import Modal, { ConfirmDialog } from '../../components/admin/Modal';
import { TextAreaField, SelectField } from '../../components/forms/Field';
import { useToast } from '../../components/ui/Toast';
import { useAdminList } from '../../hooks/useAdminList';
import { usePageMeta } from '../../hooks/usePageMeta';
import { fmtDate, fmtDateTime } from '../../lib/format';
import * as api from '../../services/adminManagementService';

const sessionEnded = (e) => e?.status === 401 || e?.status === 403;
const TYPES = [['All', 'All types'], ['offer_letter', 'Offer letters'], ['certificate', 'Certificates']];
const STATUSES = ['All', 'Issued', 'Revoked'];
const typeLabel = (t) => (t === 'certificate' ? 'Certificate' : 'Offer letter');
function DocStatus({ status }) {
  return status === 'Revoked'
    ? <span className="status status--red"><ShieldAlert size={14} aria-hidden="true" />Revoked</span>
    : <span className="status status--teal"><ShieldCheck size={14} aria-hidden="true" />{status}</span>;
}
function Fact({ label, children }) { return <div><dt>{label}</dt><dd>{children || '—'}</dd></div>; }
const INTEGRITY = { match: 'Stored file matches its recorded hash', mismatch: 'Stored file does NOT match its recorded hash', missing: 'Stored file is missing', not_applicable: 'No file yet' };

function DocumentDetails({ id, onClose, onChanged }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [history, setHistory] = useState(null);
  const [check, setCheck] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(false);
  const [reason, setReason] = useState('');
  const [fieldErr, setFieldErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    api.getDocumentHistory(id).then((r) => { setD(r.document); setHistory(r); }).catch(setError);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const verify = async () => { setCheck({ loading: true }); try { setCheck(await api.verifyAdminDocument(id)); } catch (e) { setCheck({ error: e.message || 'Could not verify.' }); } };
  const revoke = async () => {
    if (reason.trim().length < 3) { setFieldErr('A reason of at least 3 characters is required'); return; }
    setBusy(true); setMsg(''); setFieldErr('');
    try {
      await api.revokeAdminDocument(id, reason.trim());
      setDialog(false); setReason(''); toast.success('Document revoked. The public verification page now shows it as revoked.'); // shown only after the server confirmed
      load(); onChanged();
    } catch (e) { setMsg(e.message || 'Could not revoke the document.'); setFieldErr(e.data?.error?.fields?.reason ?? ''); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={d ? `${typeLabel(d.type)} · ${d.id}` : 'Document'} onClose={onClose} wide>
      <div className="adm-modal__body">
        {error ? <p className="field__error" role="alert">{sessionEnded(error) ? 'Your administrator session has ended. Sign in again.' : 'Could not load this document.'}</p>
          : !d ? <i className="sk sk--line" aria-hidden="true" /> : (<>
            <p><DocStatus status={d.status} /></p>
            <dl className="acards__facts">
              <Fact label="Student">{d.studentName}</Fact><Fact label="Internship">{d.internshipTitle}</Fact>
              <Fact label="Document number">{d.documentNumber}</Fact><Fact label="Verification reference"><span className="mono">{d.verificationCode}</span></Fact>
              <Fact label="Issued">{d.issuedAt && fmtDateTime(d.issuedAt)}</Fact><Fact label="Issued by">{d.issuedBy}</Fact>
              {d.status === 'Revoked' && <><Fact label="Revoked">{fmtDateTime(d.revokedAt)}</Fact><Fact label="Revoked by">{d.revokedBy}</Fact><Fact label="Reason">{d.revokedReason}</Fact></>}
            </dl>
            <div className="adm-actions">
              {d.fileAvailable && <a className="btn btn--secondary btn--sm" href={api.documentFileUrl(d.id)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" /> Preview PDF</a>}
              <Button variant="secondary" size="sm" onClick={verify}>Verify status</Button>
              {d.status === 'Issued' && <Button size="sm" className="btn--danger" onClick={() => setDialog(true)}>Revoke…</Button>}
            </div>
            {check && (check.loading ? <p className="text-muted">Checking…</p> : check.error ? <p className="field__error" role="alert">{check.error}</p> : (
              <div className="card" role="status">
                <p><strong>Public page shows:</strong> {check.publicVerification ? check.publicVerification.result : 'not found (draft)'}</p>
                <p className={check.integrity.state === 'match' ? '' : 'field__error'}>{INTEGRITY[check.integrity.state]}</p>
              </div>))}
            <h3>Issuance history</h3>
            {history && (history.events.length ? <ul>{history.events.map((e, i) => <li key={i}>{fmtDateTime(e.at)} — <strong>{e.event}</strong>{e.actor ? ` by ${e.actor}` : ''}{e.detail && e.event === 'revoked' ? ` (${e.detail})` : ''}</li>)}</ul> : <p className="text-muted">No events recorded.</p>)}
            {history?.sameInternship.length > 1 && <p className="text-muted">{history.sameInternship.length} documents exist for this internship (including revoked ones, which are kept).</p>}
          </>)}
      </div>
      {dialog && (
        <ConfirmDialog title="Revoke document" confirmLabel="Revoke document" danger busy={busy} error={msg} onConfirm={revoke} onClose={() => setDialog(false)}>
          <p>The document stays in the records but is shown as <strong>revoked</strong> to the student and on the public verification page. This can’t be undone.</p>
          <TextAreaField label="Reason (required)" name="reason" rows={3} maxLength={300} value={reason} onChange={(_, v) => { setReason(v); setFieldErr(''); }} error={fieldErr} />
        </ConfirmDialog>
      )}
    </Modal>
  );
}


function IssueDialog({ onClose, onIssued }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [v, setV] = useState({ type: 'offer_letter', internshipId: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listInternshipsForIssue().then(setList).catch((e) => { setList([]); setMsg(e.message || 'Could not load internships.'); }); }, []);
  const set = (k, x) => { setV((s) => (k === 'type' ? { type: x, internshipId: '' } : { ...s, [k]: x })); setMsg(''); };
  const eligible = (list ?? []).filter((e) => e.applicationStatus === 'Approved' && (v.type === 'certificate' ? e.status === 'Completed' : e.status !== 'Cancelled'));
  const go = async () => {
    if (!v.internshipId) { setMsg('Choose an internship.'); return; }
    setBusy(true); setMsg('');
    try {
      if (v.type === 'certificate') { // issuing a certificate by hand is the administrator's approval; a previously declined one stays refused by the server
        const chosen = (list ?? []).find((e) => e.id === v.internshipId);
        if (chosen?.certificateReview?.decision !== 'Approved') await api.approveCertificate(v.internshipId);
      }
      const d = await api.issueAdminDocument(v.type, v.internshipId); toast.success(`${typeLabel(d.type)} ${d.id} issued.`); onIssued(); onClose(); } // only after the server created it
    catch (e) { setMsg(e.message || 'Could not issue the document.'); } finally { setBusy(false); }
  };
  return (
    <ConfirmDialog title="Issue document" confirmLabel="Issue document" busy={busy} error={msg} onConfirm={go} onClose={onClose}>
      <SelectField label="Document type" name="type" value={v.type} onChange={set} options={[{ value: 'offer_letter', label: 'Offer letter' }, { value: 'certificate', label: 'Completion certificate' }]} />
      <SelectField label="Internship" name="internshipId" value={v.internshipId} onChange={set} placeholder={list ? 'Select an internship' : 'Loading…'}
        options={eligible.map((e) => ({ value: e.id, label: `${e.studentName} · ${e.internship.title} · ${e.status}` }))}
        hint={list && eligible.length === 0 ? (v.type === 'certificate' ? 'No completed internships are waiting for a certificate. Mark an internship Completed first.' : 'No approved internships are waiting for an offer letter.') : undefined} />
      {/incomplete/i.test(msg) && <p><Link to="/admin/settings" onClick={onClose}>Go to Settings to fill these in →</Link></p>}
      <p className="text-muted">The server checks eligibility (approved application for offer letters; verified completed and approved internship for certificates) and refuses duplicates.</p>
    </ConfirmDialog>
  );
}

export default function AdminDocumentsPage() {
  usePageMeta('Documents · Admin');
  const [type, setType] = useState('All');
  const [status, setStatus] = useState('All');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  const [issuing, setIssuing] = useState(false);
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const { loading, error, data, reload } = useAdminList(api.listAdminDocuments, { type, status, q, page, pageSize: 10 });
  const rows = data?.documents ?? [];
  const filtered = Boolean(q) || type !== 'All' || status !== 'All';

  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><h1>Documents</h1><p className="text-muted">Issued offer letters and completion certificates. Documents are issued from each internship; revoked ones stay on record.</p></div><Button icon={Plus} onClick={() => setIssuing(true)}>Issue document</Button></header>
      <div className="adm-tools card">
        <div className="adm-searchbox"><Search size={16} aria-hidden="true" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by student, internship, document ID, number or reference" aria-label="Search documents" maxLength={80} /></div>
        <select className="adm-select" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label="Filter by document type">{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </div>
      <div className="adm-chips" role="group" aria-label="Filter by status">
        {STATUSES.map((s) => <button key={s} type="button" className={`adm-chip ${status === s ? 'is-on' : ''}`} aria-pressed={status === s} onClick={() => { setStatus(s); setPage(1); }}>{s}{data?.counts && s !== 'All' && <span className="adm-chip__n">{data.counts[s] ?? 0}</span>}</button>)}
      </div>

      {error && !data ? (
        <div className="empty" role="alert"><span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span>
          <h3>Couldn’t load documents</h3>
          <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended. Sign in again.' : 'Something went wrong. Please try again.'}</p>
          {sessionEnded(error) ? <Button to="/admin/login">Sign in</Button> : <Button icon={RefreshCw} onClick={reload}>Try again</Button>}</div>
      ) : loading && !data ? (
        <div className="card asks" aria-hidden="true">{[0, 1, 2, 3].map((n) => <i key={n} className="sk sk--line" />)}</div>
      ) : rows.length === 0 ? (
        <div className="empty" role="status"><span className="empty__icon"><FileText size={28} aria-hidden="true" /></span>
          <h3>{filtered ? 'No documents match' : 'No documents issued yet'}</h3>
          <p className="text-muted">{filtered ? 'Try a different search or filter.' : 'Offer letters and certificates appear here once they are issued.'}</p></div>
      ) : (
        <div className={loading ? 'adm-loading' : ''} aria-busy={loading}>
          <div className="atable card">
            <table>
              <caption className="sr-only">Documents</caption>
              <thead><tr><th scope="col">Document</th><th scope="col">Student</th><th scope="col">Internship</th><th scope="col">Issued</th><th scope="col">Status</th><th scope="col">Verification reference</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{rows.map((d) => (
                <tr key={d.id}>
                  <td><span className="atable__title">{typeLabel(d.type)}</span><span className="atable__cat mono">{d.id}</span></td>
                  <td>{d.studentName}</td><td>{d.internshipTitle}</td><td>{d.issuedAt ? fmtDate(d.issuedAt) : '—'}</td>
                  <td><DocStatus status={d.status} /></td><td className="mono">{d.verificationCode}</td>
                  <td className="atable__act"><button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpenId(d.id)} aria-label={`Open ${typeLabel(d.type)} ${d.id}`}>Open</button></td>
                </tr>))}</tbody>
            </table>
          </div>
          <ul className="acards">{rows.map((d) => (
            <li key={d.id} className="acards__item card">
              <div className="acards__top"><div><p className="acards__cat mono">{d.id}</p><h2 className="acards__title">{typeLabel(d.type)}</h2></div><DocStatus status={d.status} /></div>
              <dl className="acards__facts"><Fact label="Student">{d.studentName}</Fact><Fact label="Internship">{d.internshipTitle}</Fact><Fact label="Issued">{d.issuedAt ? fmtDate(d.issuedAt) : ''}</Fact><Fact label="Reference"><span className="mono">{d.verificationCode}</span></Fact></dl>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpenId(d.id)}>Open</button>
            </li>))}</ul>
          <Pagination {...data.pagination} onChange={setPage} />
        </div>
      )}
      {issuing && <IssueDialog onClose={() => setIssuing(false)} onIssued={reload} />}
      {openId && <DocumentDetails id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
