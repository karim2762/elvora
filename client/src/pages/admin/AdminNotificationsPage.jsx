import { useState } from 'react';
import { Bell, TriangleAlert, RefreshCw, Plus } from 'lucide-react';
import Button from '../../components/ui/Button';
import Pagination from '../../components/applications/Pagination';
import Modal, { ConfirmDialog } from '../../components/admin/Modal';
import { TextField, TextAreaField, SelectField } from '../../components/forms/Field';
import { useToast } from '../../components/ui/Toast';
import { useAdminList } from '../../hooks/useAdminList';
import { usePageMeta } from '../../hooks/usePageMeta';
import { fmtDateTime } from '../../lib/format';
import * as api from '../../services/adminManagementService';

const sessionEnded = (e) => e?.status === 401 || e?.status === 403;
const CATS = [['general', 'General announcement'], ['important', 'Important platform notice'], ['application', 'Application update'], ['internship', 'Internship update'], ['document', 'Document update']];
const catLabel = (c) => CATS.find(([v]) => v === c)?.[1] ?? c;
const DEGREES = ['B.Tech', 'B.E.', 'BCA', 'MCA', 'B.Sc', 'M.Sc', 'M.Tech', 'M.E.', 'BBA', 'MBA', 'Diploma', 'Other'];
const YEARS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year', 'Graduated'];
const ISTAT = ['Awaiting Start', 'Active', 'Completed', 'Suspended', 'Cancelled'];
const opt = (a) => a.map((v) => ({ value: v, label: v }));
const audienceText = (a) => (a.type === 'all' ? 'All eligible students' : a.type === 'student' ? 'One student' : [a.degree, a.academicYear, a.internshipStatus && `internship ${a.internshipStatus}`].filter(Boolean).join(' · '));

function Compose({ onClose, onSent }) {
  const toast = useToast();
  const [v, setV] = useState({ title: '', message: '', category: 'general', aud: 'all', degree: '', academicYear: '', internshipStatus: '' });
  const [errs, setErrs] = useState({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [pv, setPv] = useState(null); // { count, body } once the server has counted recipients
  const set = (k, val) => { setV((s) => ({ ...s, [k]: val })); setErrs((e) => ({ ...e, [k]: undefined })); setPv(null); };
  const body = () => ({ title: v.title, message: v.message, category: v.category,
    audience: v.aud === 'all' ? { type: 'all' } : { type: 'group', ...(v.degree && { degree: v.degree }), ...(v.academicYear && { academicYear: v.academicYear }), ...(v.internshipStatus && { internshipStatus: v.internshipStatus }) } });
  const fail = (e) => { setMsg(e.message || 'Something went wrong.'); setErrs(e.data?.error?.fields ?? {}); };
  const review = async () => {
    setBusy(true); setMsg(''); setErrs({});
    try { const r = await api.previewAnnouncement(body()); setPv({ count: r.recipientCount, body: body() }); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const send = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api.sendAnnouncement({ ...pv.body, confirm: true, confirmRecipientCount: pv.count });
      toast.success(`Delivered to ${r.delivered} student notification inbox${r.delivered === 1 ? '' : 'es'}.`); // the server's read-back count, not an assumption
      onSent(); onClose();
    } catch (e) { fail(e); setPv(null); } finally { setBusy(false); }
  };
  return (<>
    <Modal title="New announcement" onClose={onClose} busy={busy}>
      <div className="adm-modal__body">
        <TextField label="Title" name="title" value={v.title} onChange={set} error={errs.title} maxLength={120} />
        <TextAreaField label="Message" name="message" rows={5} maxLength={1000} value={v.message} onChange={set} error={errs.message} />
        <SelectField label="Type" name="category" value={v.category} onChange={set} error={errs.category} options={CATS.map(([value, label]) => ({ value, label }))} />
        <SelectField label="Send to" name="aud" value={v.aud} onChange={set} options={[{ value: 'all', label: 'All eligible students' }, { value: 'group', label: 'A selected group' }]} />
        {v.aud === 'group' && (<>
          <SelectField label="Degree" name="degree" value={v.degree} onChange={set} options={opt(DEGREES)} placeholder="Any degree" />
          <SelectField label="Academic year" name="academicYear" value={v.academicYear} onChange={set} options={opt(YEARS)} placeholder="Any year" />
          <SelectField label="Internship status" name="internshipStatus" value={v.internshipStatus} onChange={set} options={opt(ISTAT)} placeholder="Any" />
          {errs.audience && <p className="field__error" role="alert">{errs.audience}</p>}
        </>)}
        <p className="text-muted">Announcements go to student notification inboxes in the dashboard. They are not e-mailed. Suspended students and administrators are excluded.</p>
        {msg && <p className="field__error" role="alert">{msg}</p>}
        <div className="adm-actions"><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={review} disabled={busy}>Review and send…</Button></div>
      </div>
    </Modal>
    {pv && (
      <ConfirmDialog title="Send announcement?" confirmLabel={`Send to ${pv.count} student${pv.count === 1 ? '' : 's'}`} busy={busy} error={msg} onConfirm={send} onClose={() => setPv(null)}>
        <p><strong>{pv.body.title}</strong></p>
        <p>This will be delivered to <strong>{pv.count}</strong> eligible student{pv.count === 1 ? '' : 's'} ({audienceText(pv.body.audience)}). It can be withdrawn later but can’t be unsent from inboxes already opened.</p>
        {pv.count === 0 && <p className="field__error">No eligible students match, so nothing will be sent.</p>}
      </ConfirmDialog>)}
  </>);
}

function Withdraw({ a, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const go = async () => {
    if (reason.trim().length < 5) { setErr('A reason of at least 5 characters is required'); return; }
    setBusy(true); setMsg('');
    try { await api.withdrawAnnouncement(a.id, reason.trim()); toast.success('Announcement withdrawn.'); onDone(); onClose(); }
    catch (e) { setMsg(e.message || 'Could not withdraw.'); setErr(e.data?.error?.fields?.reason ?? ''); } finally { setBusy(false); }
  };
  return (
    <ConfirmDialog title="Withdraw announcement" confirmLabel="Withdraw" danger busy={busy} error={msg} onConfirm={go} onClose={onClose}>
      <p>“{a.title}” will be withdrawn. The record is kept.</p>
      <TextAreaField label="Reason (required)" name="reason" rows={3} maxLength={300} value={reason} onChange={(_, x) => { setReason(x); setErr(''); }} error={err} />
    </ConfirmDialog>);
}

export default function AdminNotificationsPage() {
  usePageMeta('Notifications · Admin');
  const [status, setStatus] = useState('All');
  const [page, setPage] = useState(1);
  const [compose, setCompose] = useState(false);
  const [wd, setWd] = useState(null);
  const { loading, error, data, reload } = useAdminList(api.listAnnouncements, { status, page, pageSize: 10 });
  const rows = data?.announcements ?? [];
  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><h1>Notifications</h1><p className="text-muted">Announcements sent to student inboxes. Application, internship and document notifications are sent automatically when those events happen.</p></div>
        <Button icon={Plus} onClick={() => setCompose(true)}>New announcement</Button></header>
      <div className="adm-chips" role="group" aria-label="Filter by status">
        {['All', 'Sent', 'Withdrawn'].map((s) => <button key={s} type="button" className={`adm-chip ${status === s ? 'is-on' : ''}`} aria-pressed={status === s} onClick={() => { setStatus(s); setPage(1); }}>{s}</button>)}
      </div>
      {error && !data ? (
        <div className="empty" role="alert"><span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span><h3>Couldn’t load announcements</h3>
          <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended. Sign in again.' : 'Something went wrong. Please try again.'}</p>
          {sessionEnded(error) ? <Button to="/admin/login">Sign in</Button> : <Button icon={RefreshCw} onClick={reload}>Try again</Button>}</div>
      ) : loading && !data ? (
        <div className="card asks" aria-hidden="true">{[0, 1, 2].map((n) => <i key={n} className="sk sk--line" />)}</div>
      ) : rows.length === 0 ? (
        <div className="empty" role="status"><span className="empty__icon"><Bell size={28} aria-hidden="true" /></span><h3>No announcements</h3><p className="text-muted">Create one to notify students.</p></div>
      ) : (
        <div className={loading ? 'adm-loading' : ''} aria-busy={loading}>
          <ul className="acards" style={{ display: 'grid' }}>{rows.map((a) => (
            <li key={a.id} className="acards__item card">
              <div className="acards__top"><div><p className="acards__cat mono">{a.id} · {catLabel(a.category)}</p><h2 className="acards__title">{a.title}</h2></div>
                <span className={`status ${a.status === 'Withdrawn' ? 'status--red' : 'status--teal'}`}>{a.status}</span></div>
              <p>{a.message}</p>
              <dl className="acards__facts">
                <div><dt>Audience</dt><dd>{audienceText(a.audience)}</dd></div>
                <div><dt>Delivered (in-app)</dt><dd>{a.delivery.delivered} of {a.recipientCount} · {a.delivery.read} read</dd></div>
                <div><dt>Sent</dt><dd>{a.sentAt ? fmtDateTime(a.sentAt) : '—'} by {a.createdBy}</dd></div>
                {a.status === 'Withdrawn' && <div><dt>Withdrawn</dt><dd>{fmtDateTime(a.withdrawnAt)} by {a.withdrawnBy} — {a.withdrawReason}</dd></div>}
              </dl>
              {a.status === 'Sent' && <button type="button" className="btn btn--secondary btn--sm" onClick={() => setWd(a)}>Withdraw…</button>}
            </li>))}</ul>
          <Pagination {...data.pagination} onChange={setPage} />
        </div>)}
      {compose && <Compose onClose={() => setCompose(false)} onSent={reload} />}
      {wd && <Withdraw a={wd} onClose={() => setWd(null)} onDone={reload} />}
    </div>
  );
}
