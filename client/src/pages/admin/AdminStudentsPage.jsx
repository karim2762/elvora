import { useCallback, useEffect, useState } from 'react';
import { Users, Search, TriangleAlert, RefreshCw, Mail, Phone, ClipboardList, Briefcase, FileText, History, ShieldAlert, ShieldCheck } from 'lucide-react';
import Button from '../../components/ui/Button';
import Pagination from '../../components/applications/Pagination';
import StatusBadge from '../../components/applications/StatusBadge';
import InternshipStatusBadge from '../../components/internships/InternshipStatusBadge';
import Modal, { ConfirmDialog } from '../../components/admin/Modal';
import InternshipLifecyclePanel from '../../components/admin/InternshipLifecyclePanel';
import { TextAreaField } from '../../components/forms/Field';
import { useToast } from '../../components/ui/Toast';
import { useAdminList } from '../../hooks/useAdminList';
import { usePageMeta } from '../../hooks/usePageMeta';
import { fmtDate, fmtDateTime, fmtPhone } from '../../lib/format';
import { DEGREES, ACADEMIC_YEARS } from '../../config/student';
import * as api from '../../services/adminManagementService';

const sessionEnded = (e) => e?.status === 401 || e?.status === 403;
const FILTERS = [['All', 'all'], ['Active', 'active'], ['Suspended', 'suspended']];
function AccountBadge({ status, isAdmin }) {
  if (isAdmin) return <span className="status status--indigo"><ShieldCheck size={14} aria-hidden="true" />Admin</span>;
  return status === 'suspended'
    ? <span className="status status--red"><ShieldAlert size={14} aria-hidden="true" />Suspended</span>
    : <span className="status status--teal"><ShieldCheck size={14} aria-hidden="true" />Active</span>;
}
function Fact({ label, children }) { return <div><dt>{label}</dt><dd>{children || '—'}</dd></div>; }

function StudentDetails({ id, onClose, onChanged }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(false);
  const [reason, setReason] = useState('');
  const [fieldErr, setFieldErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { setError(null); api.getAdminStudent(id).then(setD).catch(setError); }, [id]);
  useEffect(() => { load(); }, [load]);

  const suspended = d?.student.accountStatus === 'suspended';
  const submit = async () => {
    if (!suspended && reason.trim().length < 5) { setFieldErr('Give a reason (at least 5 characters)'); return; }
    setBusy(true); setMsg(''); setFieldErr('');
    try {
      const r = await api.setStudentStatus(id, suspended ? 'active' : 'suspended', reason.trim());
      setD(r); setDialog(false); setReason('');
      toast.success(suspended ? 'Account reactivated.' : 'Account suspended. The student has been signed out.'); // only after the server confirmed
      onChanged();
    } catch (e) { setMsg(e.message || 'Could not change the account status.'); setFieldErr(e.data?.error?.fields?.reason ?? ''); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={d ? d.student.fullName : 'Student'} onClose={onClose} wide busy={busy}>
      <div className="adm-modal__body">
        {error ? (
          <div className="empty" role="alert"><h3>Couldn’t load this student</h3>
            <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended.' : error.status === 404 ? 'This student no longer exists.' : error.message}</p>
            {!sessionEnded(error) && error.status !== 404 && <Button icon={RefreshCw} onClick={load}>Try again</Button>}</div>
        ) : !d ? <div className="asks" aria-hidden="true">{[0, 1, 2].map((n) => <i key={n} className="sk sk--line" />)}</div> : (
          <>
            <div className="adm-detail__top">
              <div><h3 className="adm-detail__title">{d.student.fullName}</h3><p className="text-muted mono">{d.student.id}</p></div>
              <AccountBadge status={d.student.accountStatus} isAdmin={d.student.isAdmin} />
            </div>
            <section aria-labelledby="s-prof"><h4 id="s-prof"><Users size={16} aria-hidden="true" /> Profile</h4>
              <dl className="adm-facts">
                <Fact label="Email"><a className="link" href={`mailto:${d.student.email}`}><Mail size={13} aria-hidden="true" /> {d.student.email}</a></Fact>
                <Fact label="Mobile"><Phone size={13} aria-hidden="true" /> {fmtPhone(d.student.phone)}</Fact>
                <Fact label="College">{d.student.college}</Fact>
                <Fact label="Degree / branch">{`${d.student.degree}, ${d.student.branch}`}</Fact>
                <Fact label="Academic year">{d.student.academicYear}{d.student.graduationYear ? ` · graduates ${d.student.graduationYear}` : ''}</Fact>
                <Fact label="Registered">{fmtDate(d.student.registeredAt)}</Fact>
                <Fact label="Skills">{d.student.skills.join(', ')}</Fact>
              </dl>
            </section>

            <section aria-labelledby="s-acct"><h4 id="s-acct"><ShieldCheck size={16} aria-hidden="true" /> <AccountBadge status={d.student.accountStatus} isAdmin={d.student.isAdmin} /></h4>
              {d.student.isAdmin ? <p className="text-muted"><ShieldCheck size={15} aria-hidden="true" /> Administrator accounts can’t be suspended here.</p> : (
                <div className="adm-iconrow">
                  <button type="button" className={`adm-ib ${suspended ? 'adm-ib--go' : 'adm-ib--bad'}`} title={suspended ? 'Reactivate account' : 'Suspend account'} aria-label={suspended ? 'Reactivate account' : 'Suspend account'}
                    onClick={() => { setDialog(true); setMsg(''); setFieldErr(''); }}>{suspended ? <ShieldCheck size={20} aria-hidden="true" /> : <ShieldAlert size={20} aria-hidden="true" />}</button>
                </div>)}
            </section>

            <section aria-labelledby="s-apps"><h4 id="s-apps"><ClipboardList size={16} aria-hidden="true" /> Applications ({d.applications.length})</h4>
              {d.applications.length === 0 ? <p className="text-muted">No applications yet.</p> : (
                <ul className="adm-mini">{d.applications.map((a) => (
                  <li key={a.id}><div><strong>{a.internshipTitle}</strong><p className="adm-timeline__meta"><span className="mono">{a.id}</span> · applied {fmtDate(a.submittedAt)}</p></div><StatusBadge status={a.status} /></li>
                ))}</ul>
              )}
            </section>

            <section aria-labelledby="s-int"><h4 id="s-int"><Briefcase size={16} aria-hidden="true" /> Internship history ({d.internships.length})</h4>
              {d.internships.length === 0 ? <p className="text-muted">No internship records yet.</p> : (
                <ul className="adm-mini">{d.internships.map((n) => (
                  <li key={n.id} className="adm-mini__block">
                    <div className="adm-mini__row"><div><strong>{n.title}</strong><p className="adm-timeline__meta"><span className="mono">{n.id}</span> · {n.startDate ? `started ${fmtDate(n.startDate)}` : 'start date not set'}{n.completedAt ? ` · completed ${fmtDate(n.completedAt)}` : ''}{n.progressPercent !== null ? ` · ${n.progressPercent}%` : ''}</p></div><InternshipStatusBadge status={n.status} /></div>
                    <InternshipLifecyclePanel internshipId={n.id} onChanged={load} />
                  </li>
                ))}</ul>
              )}
            </section>

            <section aria-labelledby="s-docs"><h4 id="s-docs"><FileText size={16} aria-hidden="true" /> Issued documents ({d.documents.length})</h4>
              {d.documents.length === 0 ? <p className="text-muted">No documents issued yet.</p> : (
                <ul className="adm-mini">{d.documents.map((x) => (
                  <li key={x.id}><div><strong>{x.title}</strong><p className="adm-timeline__meta">{x.number ? <span className="mono">{x.number}</span> : 'Draft'}{x.issuedAt ? ` · issued ${fmtDate(x.issuedAt)}` : ''}</p></div><span className={`status status--${x.status === 'Issued' ? 'teal' : x.status === 'Revoked' ? 'red' : 'slate'}`}>{x.status}</span></li>
                ))}</ul>
              )}
            </section>

            <section aria-labelledby="s-hist"><h4 id="s-hist"><History size={16} aria-hidden="true" /> Account status history</h4>
              {d.accountHistory.length === 0 ? <p className="text-muted">No account status changes.</p> : (
                <ol className="adm-timeline">{[...d.accountHistory].reverse().map((h) => (
                  <li key={h.id}><p><strong>{h.from}</strong> → <strong>{h.to}</strong></p><p className="adm-timeline__meta">{fmtDateTime(h.changedAt)} · by {h.changedBy}</p>{h.reason && <p className="adm-timeline__note">“{h.reason}”</p>}</li>
                ))}</ol>
              )}
            </section>
          </>
        )}
      </div>
      {dialog && (
        <ConfirmDialog title={suspended ? 'Reactivate account' : 'Suspend account'} confirmLabel={suspended ? 'Reactivate' : 'Suspend account'} danger={!suspended} busy={busy} error={msg} onConfirm={submit} onClose={() => setDialog(false)}>
          <p>{suspended ? `Reactivate ${d.student.fullName}? They can sign in again.` : `Suspend ${d.student.fullName}? They are signed out immediately and cannot sign in.`}</p>
          <TextAreaField label={suspended ? 'Note (optional)' : 'Reason'} name="reason" rows={3} maxLength={500} value={reason} onChange={(_, v) => { setReason(v); setFieldErr(''); }} error={fieldErr} hint="Saved in the account history." />
        </ConfirmDialog>
      )}
    </Modal>
  );
}

export default function AdminStudentsPage() {
  usePageMeta('Students · Admin');
  const [status, setStatus] = useState('all');
  const [degree, setDegree] = useState('All');
  const [year, setYear] = useState('All');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const { loading, error, data, reload } = useAdminList(api.listAdminStudents, { status: status === 'all' ? '' : status, degree, academicYear: year, q, page, pageSize: 10 });
  const rows = data?.students ?? [];
  const filtered = Boolean(q) || status !== 'all' || degree !== 'All' || year !== 'All';

  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><h1>Students</h1><p className="text-muted">Student accounts, applications, internships and documents.</p></div></header>
      <div className="adm-tools card">
        <div className="adm-searchbox"><Search size={16} aria-hidden="true" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, email, student ID or college" aria-label="Search students" maxLength={80} /></div>
        <select className="adm-select" value={degree} onChange={(e) => { setDegree(e.target.value); setPage(1); }} aria-label="Filter by degree"><option value="All">All degrees</option>{DEGREES.map((x) => <option key={x}>{x}</option>)}</select>
        <select className="adm-select" value={year} onChange={(e) => { setYear(e.target.value); setPage(1); }} aria-label="Filter by academic year"><option value="All">All years</option>{ACADEMIC_YEARS.map((x) => <option key={x}>{x}</option>)}</select>
      </div>
      <div className="adm-chips" role="group" aria-label="Filter by account status">
        {FILTERS.map(([label, key]) => (
          <button key={key} type="button" className={`adm-chip ${status === key ? 'is-on' : ''}`} aria-pressed={status === key} onClick={() => { setStatus(key); setPage(1); }}>{label}{data?.counts && <span className="adm-chip__n">{data.counts[key] ?? 0}</span>}</button>
        ))}
      </div>

      {error && !data ? (
        <div className="empty" role="alert"><span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span>
          <h3>Couldn’t load students</h3>
          <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended. Sign in again.' : error.status === 0 ? error.message : 'Something went wrong. Please try again.'}</p>
          {sessionEnded(error) ? <Button to="/admin/login">Sign in</Button> : <Button icon={RefreshCw} onClick={reload}>Try again</Button>}</div>
      ) : loading && !data ? (
        <div className="card asks" aria-hidden="true">{[0, 1, 2, 3].map((n) => <i key={n} className="sk sk--line" />)}</div>
      ) : rows.length === 0 ? (
        <div className="empty" role="status"><span className="empty__icon"><Users size={28} aria-hidden="true" /></span>
          <h3>{filtered ? 'No students match' : 'No students yet'}</h3>
          <p className="text-muted">{filtered ? 'Try a different search or filter.' : 'Students appear here after they register.'}</p></div>
      ) : (
        <div className={loading ? 'adm-loading' : ''} aria-busy={loading}>
          <div className="atable card">
            <table>
              <caption className="sr-only">Students</caption>
              <thead><tr><th scope="col">Student</th><th scope="col">College</th><th scope="col">Degree / branch</th><th scope="col">Year</th><th scope="col">Registered</th><th scope="col">Account</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{rows.map((s) => (
                <tr key={s.id}>
                  <td><span className="atable__title">{s.fullName}</span><span className="atable__cat">{s.email}</span><span className="atable__cat mono">{s.id}</span></td>
                  <td>{s.college}</td><td>{s.degree}, {s.branch}</td><td>{s.academicYear}</td><td>{fmtDate(s.registeredAt)}</td>
                  <td><AccountBadge status={s.accountStatus} isAdmin={s.isAdmin} /></td>
                  <td className="atable__act"><button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpenId(s.id)} aria-label={`View profile of ${s.fullName}`}>View profile</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <ul className="acards">{rows.map((s) => (
            <li key={s.id} className="acards__item card">
              <div className="acards__top"><div><p className="acards__cat">{s.email}</p><h2 className="acards__title">{s.fullName}</h2></div><AccountBadge status={s.accountStatus} isAdmin={s.isAdmin} /></div>
              <dl className="acards__facts"><div><dt>College</dt><dd>{s.college}</dd></div><div><dt>Degree</dt><dd>{s.degree}, {s.branch}</dd></div><div><dt>Year</dt><dd>{s.academicYear}</dd></div><div><dt>Registered</dt><dd>{fmtDate(s.registeredAt)}</dd></div></dl>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpenId(s.id)} aria-label={`View profile of ${s.fullName}`}>View profile</button>
            </li>
          ))}</ul>
          <Pagination {...data.pagination} onChange={setPage} />
        </div>
      )}
      {openId && <StudentDetails id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
