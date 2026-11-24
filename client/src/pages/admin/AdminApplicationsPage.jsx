import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardList, Search, TriangleAlert, RefreshCw, Mail, Phone, GraduationCap, History, StickyNote, ExternalLink } from 'lucide-react';
import Button from '../../components/ui/Button';
import Pagination from '../../components/applications/Pagination';
import StatusBadge from '../../components/applications/StatusBadge';
import Modal from '../../components/admin/Modal';
import InternshipLifecyclePanel from '../../components/admin/InternshipLifecyclePanel';
import { TextAreaField } from '../../components/forms/Field';
import { useToast } from '../../components/ui/Toast';
import { useAdminList } from '../../hooks/useAdminList';
import { usePageMeta } from '../../hooks/usePageMeta';
import { fmtDate, fmtDateTime, fmtPhone } from '../../lib/format';
import { formatDuration } from '../../lib/duration';
import { APPLICATION_FILTERS } from '../../config/internshipStatus';
import * as api from '../../services/adminManagementService';

const sessionEnded = (e) => e?.status === 401 || e?.status === 403;

function Fact({ label, children }) { return <div><dt>{label}</dt><dd>{children || '—'}</dd></div>; }

function Details({ id, onClose, onChanged }) {
  const toast = useToast();
  const [app, setApp] = useState(null);
  const [error, setError] = useState(null);
  const [next, setNext] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState({ message: '', note: '' });
  const [reviewNote, setReviewNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);

  const load = useCallback(() => { setError(null); api.getAdminApplication(id).then(setApp).catch(setError); }, [id]);
  useEffect(() => { load(); }, [load]);

  const submitStatus = async () => {
    setBusy(true); setStatusError({ message: '', note: '' });
    try {
      const r = await api.changeApplicationStatus(app.id, next, note.trim());
      setApp(r.application); setNext(''); setNote(''); setConfirming(false); // shown only now that the server has confirmed
      toast.success(r.changed ? `Status changed to ${r.application.status}. The student was notified.` : 'Status was already set. Nothing changed.');
      onChanged();
    } catch (e) {
      setStatusError({ message: e.status === 0 ? e.message : e.message || 'Could not change the status.', note: e.data?.error?.fields?.note ?? '' });
      setConfirming(false);
      if (e.data?.error?.code === 'INVALID_TRANSITION') load(); // somebody else changed it: show the real current state
    } finally { setBusy(false); }
  };
  const submitNote = async (ev) => {
    ev.preventDefault();
    if (!reviewNote.trim()) { setNoteError('Write a note first'); return; }
    setNoteBusy(true); setNoteError('');
    try { const n = await api.addApplicationNote(app.id, reviewNote.trim()); setApp((a) => ({ ...a, notes: [...a.notes, n] })); setReviewNote(''); toast.success('Note added'); }
    catch (e) { setNoteError(e.data?.error?.fields?.note || e.message || 'Could not add the note.'); }
    finally { setNoteBusy(false); }
  };

  return (
    <Modal title={app ? `Application ${app.id}` : 'Application'} onClose={onClose} wide busy={busy || noteBusy}>
      <div className="adm-modal__body">
        {error ? (
          <div className="empty" role="alert"><h3>Couldn’t load this application</h3>
            <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended.' : error.status === 404 ? 'This application no longer exists.' : error.message}</p>
            {!sessionEnded(error) && error.status !== 404 && <Button icon={RefreshCw} onClick={load}>Try again</Button>}</div>
        ) : !app ? <div className="asks" aria-hidden="true">{[0, 1, 2].map((n) => <i key={n} className="sk sk--line" />)}</div> : (
          <>
            <div className="adm-detail__top">
              <div><h3 className="adm-detail__title">{app.internship.title}</h3><p className="text-muted">{app.internship.id} · {formatDuration(app.internship.durationDays)}</p></div>
              <StatusBadge status={app.status} />
            </div>

            <section aria-labelledby="d-stu"><h4 id="d-stu"><GraduationCap size={16} aria-hidden="true" /> Student</h4>
              <dl className="adm-facts">
                <Fact label="Name">{app.student.fullName}</Fact>
                <Fact label="Email"><a className="link" href={`mailto:${app.student.email}`}><Mail size={13} aria-hidden="true" /> {app.student.email}</a></Fact>
                <Fact label="Phone"><Phone size={13} aria-hidden="true" /> {fmtPhone(app.student.phone)}</Fact>
                <Fact label="College">{app.student.college}</Fact>
                <Fact label="Degree / branch">{`${app.responses.degree}, ${app.responses.branch}`}</Fact>
                <Fact label="Year">{app.responses.academicYear}{app.student.graduationYear ? ` · graduates ${app.student.graduationYear}` : ''}</Fact>
                <Fact label="Skills">{app.responses.skills.join(', ')}</Fact>
                <Fact label="Profiles">{[app.student.github && <a key="g" className="link" href={app.student.github} target="_blank" rel="noopener noreferrer">GitHub <ExternalLink size={12} aria-hidden="true" /></a>, app.student.linkedin && <a key="l" className="link" href={app.student.linkedin} target="_blank" rel="noopener noreferrer">LinkedIn <ExternalLink size={12} aria-hidden="true" /></a>].filter(Boolean).reduce((a, b) => (a.length ? [...a, ' · ', b] : [b]), [])}</Fact>
              </dl>
            </section>

            <section aria-labelledby="d-app"><h4 id="d-app"><ClipboardList size={16} aria-hidden="true" /> Application</h4>
              <dl className="adm-facts">
                <Fact label="Application ID"><span className="mono">{app.id}</span></Fact>
                <Fact label="Submitted">{fmtDateTime(app.submittedAt)}</Fact>
                <Fact label="Terms accepted">{app.termsAcceptedAt ? fmtDateTime(app.termsAcceptedAt) : null}</Fact>
                <Fact label="Decision recorded">{app.decidedAt ? fmtDateTime(app.decidedAt) : 'No decision yet'}</Fact>
                <Fact label="Internship record">{app.internshipRecord ? `${app.internshipRecord.id} (${app.internshipRecord.status})` : 'None yet'}</Fact>
              </dl>
              <h5>Motivation statement</h5>
              <blockquote className="adm-quote">{app.responses.motivation}</blockquote>
            </section>

            <section aria-labelledby="d-status"><h4 id="d-status">Change status</h4>
              {app.allowedNext.length === 0 ? (
                <p className="text-muted">{app.internshipRecord ? 'This application has an internship record, so it stays Approved. Manage the internship instead.' : `No further status changes are possible from “${app.status}”.`}</p>
              ) : (
                <div className="adm-statusform">
                  <div className="field"><label className="field__label" htmlFor="d-next">New status</label>
                    <div className="field__control"><select id="d-next" value={next} onChange={(e) => { setNext(e.target.value); setConfirming(false); setStatusError({ message: '', note: '' }); }}>
                      <option value="">Choose…</option>{app.allowedNext.map((s) => <option key={s} value={s}>{s}</option>)}</select></div></div>
                  <TextAreaField label="Reason / note (optional, internal)" name="note" value={note} onChange={(_, v) => setNote(v)} error={statusError.note} maxLength={1000} rows={2} hint="Saved with this status change. Students never see it." />
                  {statusError.message && <p className="field__error" role="alert">{statusError.message}</p>}
                  {confirming ? (
                    <div className="adm-confirm" role="group" aria-label="Confirm status change">
                      <p>Change status from <strong>{app.status}</strong> to <strong>{next}</strong>? The student will be notified.</p>
                      <div className="adm-modal__foot adm-modal__foot--inline">
                        <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
                        <Button onClick={submitStatus} disabled={busy} aria-busy={busy}>{busy ? 'Saving…' : 'Confirm change'}</Button>
                      </div>
                    </div>
                  ) : <Button onClick={() => setConfirming(true)} disabled={!next}>Update status</Button>}
                </div>
              )}
            </section>

            {app.internshipRecord && (
              <section aria-labelledby="d-life"><h4 id="d-life">Internship lifecycle</h4>
                <InternshipLifecyclePanel internshipId={app.internshipRecord.id} onChanged={() => { load(); onChanged(); }} />
              </section>
            )}

            <section aria-labelledby="d-hist"><h4 id="d-hist"><History size={16} aria-hidden="true" /> Status history</h4>
              <ol className="adm-timeline">
                {[...app.history].reverse().map((h) => (
                  <li key={h.id}>
                    <p><StatusBadge status={h.status} /> <span className="text-muted">{h.from ? `from ${h.from}` : 'application created'}</span></p>
                    <p className="adm-timeline__meta">{fmtDateTime(h.changedAt)} · {h.changedBy ? `by ${h.changedBy}` : h.from ? 'recorded before admin tracking' : 'by the student'}</p>
                    {h.note && <p className="adm-timeline__note">“{h.note}”</p>}
                  </li>
                ))}
              </ol>
            </section>

            <section aria-labelledby="d-notes"><h4 id="d-notes"><StickyNote size={16} aria-hidden="true" /> Internal review notes</h4>
              {app.notes.length === 0 ? <p className="text-muted">No notes yet.</p> : (
                <ul className="adm-notes">{app.notes.map((n) => <li key={n.id}><p>{n.note}</p><p className="adm-timeline__meta">{n.adminName} · {fmtDateTime(n.createdAt)}</p></li>)}</ul>
              )}
              <form onSubmit={submitNote} noValidate className="adm-noteform">
                <TextAreaField label="Add a note" name="reviewNote" value={reviewNote} onChange={(_, v) => { setReviewNote(v); setNoteError(''); }} error={noteError} maxLength={1000} rows={2} hint="Visible to administrators only. Notes can’t be edited or removed." />
                <button type="submit" className="btn btn--secondary" disabled={noteBusy} aria-busy={noteBusy}>{noteBusy ? 'Adding…' : 'Add note'}</button>
              </form>
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

export default function AdminApplicationsPage() {
  usePageMeta('Applications · Admin');
  const [params, setParams] = useSearchParams();
  const initial = APPLICATION_FILTERS.includes(params.get('status')) ? params.get('status') : 'All';
  const [status, setStatus] = useState(initial);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);

  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const pick = (s) => { setStatus(s); setPage(1); setParams(s === 'All' ? {} : { status: s }, { replace: true }); };
  const { loading, error, data, reload } = useAdminList(api.listAdminApplications, { status, q, page, pageSize: 10 });
  const rows = data?.applications ?? [];
  const filtered = q || status !== 'All';

  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><h1>Applications</h1><p className="text-muted">Review, filter and decide on student applications.</p></div></header>
      <div className="adm-tools card">
        <div className="adm-searchbox"><Search size={16} aria-hidden="true" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by student, email, application ID or internship" aria-label="Search applications" maxLength={80} /></div>
      </div>
      <div className="adm-chips" role="group" aria-label="Filter by status">
        {APPLICATION_FILTERS.map((s) => (
          <button key={s} type="button" className={`adm-chip ${status === s ? 'is-on' : ''}`} aria-pressed={status === s} onClick={() => pick(s)}>{s}{data?.counts && <span className="adm-chip__n">{data.counts[s] ?? 0}</span>}</button>
        ))}
      </div>

      {error && !data ? (
        <div className="empty" role="alert">
          <span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span>
          <h3>Couldn’t load applications</h3>
          <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended. Sign in again.' : error.status === 0 ? error.message : 'Something went wrong. Please try again.'}</p>
          {sessionEnded(error) ? <Button to="/admin/login">Sign in</Button> : <Button icon={RefreshCw} onClick={reload}>Try again</Button>}
        </div>
      ) : loading && !data ? (
        <div className="card asks" aria-hidden="true">{[0, 1, 2, 3].map((n) => <i key={n} className="sk sk--line" />)}</div>
      ) : rows.length === 0 ? (
        <div className="empty" role="status">
          <span className="empty__icon"><ClipboardList size={28} aria-hidden="true" /></span>
          <h3>{filtered ? 'No applications match' : 'No applications yet'}</h3>
          <p className="text-muted">{filtered ? 'Try a different search or status.' : 'Applications will appear here when students apply.'}</p>
        </div>
      ) : (
        <div className={loading ? 'adm-loading' : ''} aria-busy={loading}>
          <div className="atable card">
            <table>
              <caption className="sr-only">Student applications</caption>
              <thead><tr><th scope="col">Application ID</th><th scope="col">Student</th><th scope="col">Internship</th><th scope="col">Applied</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.id}</td>
                    <td><span className="atable__title">{a.responses.fullName}</span><span className="atable__cat">{a.responses.email}</span></td>
                    <td>{a.internship.title}</td>
                    <td>{fmtDate(a.submittedAt)}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td className="atable__act"><button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpenId(a.id)} aria-label={`View details of application ${a.id}`}>View Details</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="acards">
            {rows.map((a) => (
              <li key={a.id} className="acards__item card">
                <div className="acards__top"><div><p className="acards__cat">{a.responses.fullName}</p><h2 className="acards__title">{a.internship.title}</h2></div><StatusBadge status={a.status} /></div>
                <dl className="acards__facts">
                  <div><dt>Application ID</dt><dd className="mono">{a.id}</dd></div><div><dt>Email</dt><dd>{a.responses.email}</dd></div><div><dt>Applied</dt><dd>{fmtDate(a.submittedAt)}</dd></div>
                </dl>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setOpenId(a.id)} aria-label={`View details of application ${a.id}`}>View Details</button>
              </li>
            ))}
          </ul>
          <Pagination {...data.pagination} onChange={setPage} />
        </div>
      )}
      {openId && <Details id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
