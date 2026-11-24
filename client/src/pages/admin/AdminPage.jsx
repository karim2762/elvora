import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { KeyRound, LogOut, ClipboardList, Briefcase, Megaphone, Award, Search, Loader2, ShieldCheck, FileUp, AlertCircle } from 'lucide-react';
import Logo from '../../components/ui/Logo';
import { useToast } from '../../components/ui/Toast';
import { usePageMeta } from '../../hooks/usePageMeta';
import {
  getAdminKey, setAdminKey, verifyAdminKey, listApplications, setApplicationStatus, listAdminInternships, createInternship,
  setInternshipStatus, setInternshipProgress, sendAnnouncement, uploadDocument,
} from '../../services/adminService';
import { fmtDate } from '../../lib/format';
import CertificateApprovals from './CertificateApprovals';
import { useAuth } from '../../auth/AuthContext';

const APP_STATUSES = ['Submitted', 'Under Review', 'Approved', 'Rejected', 'Cancelled'];
const FILTERS = ['All', ...APP_STATUSES];
// Mirrors the server's allowed moves (services/enrollments.js); the server re-checks every one.
const NEXT = { 'Awaiting Start': ['Active', 'Cancelled'], Active: ['Completed', 'Suspended', 'Cancelled'], Suspended: ['Active', 'Cancelled'], Completed: [], Cancelled: [] };
const actionLabel = (from, to) => (to === 'Active' ? (from === 'Suspended' ? 'Resume' : 'Activate') : to === 'Completed' ? 'Mark completed' : to === 'Suspended' ? 'Suspend' : 'Cancel');
const errText = (err) => (err?.status === 0 ? err.message : Object.values(err?.data?.error?.fields || {})[0] || err?.message || 'Something went wrong. Please try again.');
const tone = (s) => ({ Approved: 'ok', Active: 'ok', Completed: 'ok', Rejected: 'bad', Cancelled: 'bad', Suspended: 'warn' }[s] || 'info');

const Badge = ({ status }) => <span className={`adm-badge adm-badge--${tone(status)}`}>{status}</span>;

function Gate({ onUnlocked }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (busy || !key.trim()) return;
    setBusy(true); setError('');
    try { await verifyAdminKey(key.trim()); setAdminKey(key.trim()); onUnlocked(); }
    catch (err) {
      setError(err.status === 401 ? 'That admin key is not correct.'
        : err.status === 404 ? 'Admin access is switched off on the server. Set ADMIN_API_KEY (32+ characters) in the .env file and restart the server.'
        : err.status === 429 ? 'Too many wrong attempts. Please wait a few minutes and try again.' : errText(err));
    } finally { setBusy(false); }
  }
  return (
    <main className="adm adm--gate">
      <form className="card adm-gate" onSubmit={submit} noValidate>
        <Logo />
        <h1><ShieldCheck size={22} aria-hidden="true" /> Admin console</h1>
        <p className="text-muted">Enter the ELVORA admin key to manage applications, internships and documents.</p>
        {error && <div className="form-alert" role="alert"><AlertCircle size={18} aria-hidden="true" />{error}</div>}
        <label className="adm-label" htmlFor="adminkey">Admin key</label>
        <div className="adm-keyrow"><KeyRound size={18} aria-hidden="true" />
          <input id="adminkey" type="password" autoComplete="off" spellCheck="false" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your ADMIN_API_KEY" />
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy || !key.trim()}>{busy ? <><Loader2 className="spin-icon" size={18} aria-hidden="true" />Checking…</> : 'Open admin console'}</button>
      </form>
    </main>
  );
}

function SetupForm({ application, onDone, onCancel }) {
  const toast = useToast();
  const [v, setV] = useState({ assignedProject: '', learningObjectives: '', instructions: '', startDate: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await createInternship(application.id, {
        assignedProject: v.assignedProject, instructions: v.instructions, startDate: v.startDate || undefined,
        learningObjectives: v.learningObjectives.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      toast.success('Internship set up. The student has been notified.'); onDone();
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }
  return (
    <form className="adm-sub" onSubmit={submit}>
      <h4>Set up internship</h4>
      {error && <p className="adm-err" role="alert">{error}</p>}
      <label>Assigned project<input value={v.assignedProject} onChange={set('assignedProject')} maxLength={200} placeholder="e.g. CLI task manager" /></label>
      <label>Learning objectives (one per line)<textarea rows={3} value={v.learningObjectives} onChange={set('learningObjectives')} /></label>
      <label>Instructions<textarea rows={3} value={v.instructions} onChange={set('instructions')} maxLength={3000} /></label>
      <label>Start date (optional)<input type="date" value={v.startDate} onChange={set('startDate')} /></label>
      <div className="adm-row"><button type="button" className="btn btn--secondary btn--sm" onClick={onCancel} disabled={busy}>Cancel</button><button type="submit" className="btn btn--primary btn--sm" disabled={busy}>{busy ? 'Saving…' : 'Create internship'}</button></div>
    </form>
  );
}

function ApplicationRow({ a, onChanged }) {
  const toast = useToast();
  const [status, setStatus] = useState(a.status);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  useEffect(() => setStatus(a.status), [a.status]);
  async function save() {
    setBusy(true);
    try { await setApplicationStatus(a.id, status); toast.success(`Status changed to ${status}. The student has been notified.`); onChanged(); }
    catch (err) { toast.error(errText(err)); setStatus(a.status); } finally { setBusy(false); }
  }
  return (
    <li className="card adm-item">
      <div className="adm-item__top"><div><p className="adm-id mono">{a.id}</p><h3>{a.internship.title}</h3></div><Badge status={a.status} /></div>
      <p className="adm-meta"><strong>{a.responses.fullName}</strong> · {a.responses.email}<br />{a.responses.college} · applied {fmtDate(a.submittedAt)}</p>
      <details className="adm-more"><summary>Motivation and skills</summary><p>{a.responses.motivation}</p><p className="text-muted">Skills: {a.responses.skills.join(', ') || '—'}</p></details>
      <div className="adm-row">
        <select aria-label={`Status for ${a.id}`} value={status} onChange={(e) => setStatus(e.target.value)} disabled={busy || Boolean(a.internshipRecord)}>
          {APP_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <button type="button" className="btn btn--primary btn--sm" onClick={save} disabled={busy || status === a.status}>{busy ? 'Saving…' : 'Save status'}</button>
        {a.status === 'Approved' && !a.internshipRecord && !setup && <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSetup(true)}>Set up internship</button>}
      </div>
      {a.internshipRecord && <p className="adm-note">Internship {a.internshipRecord.id} is {a.internshipRecord.status}. Manage it in the Internships tab.</p>}
      {setup && <SetupForm application={a} onCancel={() => setSetup(false)} onDone={() => { setSetup(false); onChanged(); }} />}
    </li>
  );
}

function ApplicationsPanel({ onAuthLost, initialFilter = 'All' }) {
  const [filter, setFilter] = useState(FILTERS.includes(initialFilter) ? initialFilter : 'All');
  const [q, setQ] = useState(''); const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, status: 'loading' }));
    listApplications({ status: filter, q: applied, page }).then((data) => alive && setState({ status: 'ready', data, error: null }))
      .catch((error) => { if (!alive) return; if (error.status === 401) onAuthLost(); else setState({ status: 'error', data: null, error }); });
    return () => { alive = false; };
  }, [filter, applied, page, tick, onAuthLost]);
  const d = state.data;
  return (
    <section aria-label="Applications">
      <form className="adm-search" onSubmit={(e) => { e.preventDefault(); setPage(1); setApplied(q.trim()); }} role="search">
        <Search size={18} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ID, name, email or internship" aria-label="Search applications" />
        <button type="submit" className="btn btn--secondary btn--sm">Search</button>
      </form>
      <div className="afilter" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => <button key={f} type="button" className={`chip chip--btn afilter__btn ${filter === f ? 'is-on' : ''}`} aria-pressed={filter === f} onClick={() => { setFilter(f); setPage(1); }}>{f}{d && <span className="afilter__n">{d.counts[f]}</span>}</button>)}
      </div>
      {state.status === 'error' && <p className="adm-err" role="alert">{errText(state.error)} <button type="button" className="link" onClick={() => setTick((t) => t + 1)}>Retry</button></p>}
      {state.status === 'loading' && !d && <p className="text-muted" role="status">Loading…</p>}
      {d && d.applications.length === 0 && <p className="card adm-empty">No applications match.</p>}
      {d && d.applications.length > 0 && (
        <ul className="adm-list">{d.applications.map((a) => <ApplicationRow key={a.id} a={a} onChanged={() => setTick((t) => t + 1)} />)}</ul>
      )}
      {d && d.pagination.totalPages > 1 && (
        <nav className="adm-pager" aria-label="Pages">
          <button type="button" className="btn btn--secondary btn--sm" disabled={d.pagination.page <= 1} onClick={() => setPage(d.pagination.page - 1)}>Previous</button>
          <span>Page {d.pagination.page} of {d.pagination.totalPages}</span>
          <button type="button" className="btn btn--secondary btn--sm" disabled={d.pagination.page >= d.pagination.totalPages} onClick={() => setPage(d.pagination.page + 1)}>Next</button>
        </nav>
      )}
    </section>
  );
}

function InternshipRow({ i, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [startDate, setStartDate] = useState('');
  const [doc, setDoc] = useState({ type: 'offer_letter', file: null });
  const [fileKey, setFileKey] = useState(0);
  async function move(to) {
    setBusy(to);
    try { await setInternshipStatus(i.id, { status: to, startDate: to === 'Active' && i.status === 'Awaiting Start' && startDate ? startDate : undefined, ...(to === 'Completed' ? { confirmReviewed: true } : {}) }); toast.success(`Internship is now ${to}.`); onChanged(); }
    catch (err) { toast.error(errText(err)); } finally { setBusy(''); }
  }
  async function upload(e) {
    e.preventDefault();
    if (!doc.file) { toast.error('Choose a PDF file first.'); return; }
    setBusy('doc');
    try { await uploadDocument(i.id, { type: doc.type, file: doc.file }); toast.success('Document issued. The student has been notified.'); setDoc({ type: doc.type, file: null }); setFileKey((k) => k + 1); onChanged(); }
    catch (err) { toast.error(errText(err)); } finally { setBusy(''); }
  }
  const [pct, setPct] = useState(String(i.progressPercent ?? 0));
  async function saveProgress(e) {
    e.preventDefault(); const n = Number(pct);
    if (!Number.isInteger(n) || n < 0 || n > 100) { toast.error('Enter a whole number from 0 to 100.'); return; }
    setBusy('progress');
    try { await setInternshipProgress(i.id, n); toast.success(`Progress set to ${n}%.`); onChanged(); }
    catch (err) { toast.error(errText(err)); } finally { setBusy(''); }
  }
  const moves = NEXT[i.status] ?? [];
  const canIssue = i.documents.length < 2 && i.applicationStatus === 'Approved' && i.status !== 'Cancelled';
  return (
    <li className="card adm-item">
      <div className="adm-item__top"><div><p className="adm-id mono">{i.id}</p><h3>{i.internship.title}</h3></div><Badge status={i.status} /></div>
      <p className="adm-meta"><strong>{i.studentName}</strong> · {i.studentEmail}<br />Application {i.applicationId}{i.startDate && <> · {fmtDate(i.startDate)} → {i.expectedEndDate ? fmtDate(i.expectedEndDate) : '—'}</>}</p>
      {i.assignedProject && <p className="adm-meta">Project: {i.assignedProject}</p>}
      {i.status === 'Active' && (
        <form className="adm-row" onSubmit={saveProgress}>
          <label className="adm-inline">Progress (%)<input type="number" min="0" max="100" step="1" inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value)} /></label>
          <button type="submit" className="btn btn--secondary btn--sm" disabled={Boolean(busy)}>{busy === 'progress' ? 'Saving…' : 'Save progress'}</button>
        </form>
      )}
      {moves.length > 0 && (
        <div className="adm-row">
          {i.status === 'Awaiting Start' && <label className="adm-inline">Start date<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>}
          {moves.map((to) => <button key={to} type="button" className={`btn btn--sm ${to === 'Cancelled' ? 'btn--secondary' : 'btn--primary'}`} disabled={Boolean(busy)}
            onClick={() => { const ask = to === 'Cancelled' ? 'Cancel this internship? This cannot be undone.' : to === 'Completed' ? 'Mark this internship completed? Progress must already be 100%.' : null; if (!ask || window.confirm(ask)) move(to); }}>{busy === to ? 'Saving…' : actionLabel(i.status, to)}</button>)}
        </div>
      )}
      <p className="adm-note">Issued documents: {i.documents.length ? i.documents.map((t) => (t === 'certificate' ? 'Certificate' : 'Offer letter')).join(', ') : 'none yet'}</p>
      {canIssue && (
        <form className="adm-row adm-upload" onSubmit={upload}>
          <select aria-label="Document type" value={doc.type} onChange={(e) => setDoc((s) => ({ ...s, type: e.target.value }))}>
            {!i.documents.includes('offer_letter') && <option value="offer_letter">Offer letter</option>}
            {!i.documents.includes('certificate') && i.status === 'Completed' && <option value="certificate">Certificate (completed)</option>}
          </select>
          <input key={fileKey} type="file" accept="application/pdf" aria-label="PDF file" onChange={(e) => setDoc((s) => ({ ...s, file: e.target.files?.[0] ?? null }))} />
          <button type="submit" className="btn btn--secondary btn--sm" disabled={Boolean(busy)}><FileUp size={16} aria-hidden="true" />{busy === 'doc' ? 'Uploading…' : 'Issue PDF'}</button>
        </form>
      )}
    </li>
  );
}

function InternshipsPanel({ onAuthLost }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    listAdminInternships().then((data) => alive && setState({ status: 'ready', data, error: null }))
      .catch((error) => { if (!alive) return; if (error.status === 401) onAuthLost(); else setState({ status: 'error', data: null, error }); });
    return () => { alive = false; };
  }, [tick, onAuthLost]);
  if (state.status === 'error') return <p className="adm-err" role="alert">{errText(state.error)} <button type="button" className="link" onClick={() => setTick((t) => t + 1)}>Retry</button></p>;
  if (!state.data) return <p className="text-muted" role="status">Loading…</p>;
  if (state.data.length === 0) return <p className="card adm-empty">No internships yet. Approve an application, then use “Set up internship” in the Applications tab.</p>;
  return <ul className="adm-list" aria-label="Internships">{state.data.map((i) => <InternshipRow key={i.id} i={i} onChanged={() => setTick((t) => t + 1)} />)}</ul>;
}

function AnnouncePanel() {
  const toast = useToast();
  const [v, setV] = useState({ title: '', message: '', studentId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try { const r = await sendAnnouncement({ title: v.title, message: v.message, studentId: v.studentId.trim() || undefined }); toast.success(`Announcement sent to ${r.delivered} student${r.delivered === 1 ? '' : 's'}.`); setV({ title: '', message: '', studentId: '' }); }
    catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }
  return (
    <form className="card adm-form" onSubmit={submit}>
      <h2>Send an announcement</h2>
      <p className="text-muted">It appears in every student’s Notifications. Leave the student ID empty to reach everyone.</p>
      {error && <p className="adm-err" role="alert">{error}</p>}
      <label>Title<input value={v.title} maxLength={120} onChange={(e) => setV({ ...v, title: e.target.value })} required /></label>
      <label>Message<textarea rows={4} maxLength={1000} value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} required /></label>
      <label>Student ID (optional)<input value={v.studentId} onChange={(e) => setV({ ...v, studentId: e.target.value })} placeholder="Only one student" spellCheck="false" /></label>
      <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Send announcement'}</button>
    </form>
  );
}

const TABS = [['applications', 'Applications', ClipboardList], ['internships', 'Internships', Briefcase], ['certificates', 'Certificates', Award], ['announce', 'Announce', Megaphone]];

export default function AdminPage() {
  usePageMeta('Admin console');
  const { isAdmin } = useAuth(); // a signed-in administrator (Stage 07A) needs no key; the shared key still works as before
  const [params] = useSearchParams();
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const wanted = params.get('tab');
  const [tab, setTab] = useState(TABS.some(([k]) => k === wanted) ? wanted : 'applications');
  const lock = useCallback(() => { setAdminKey(''); setUnlocked(false); }, []);

  // Asks the server (admin session cookie or stored key) before showing anything.
  useEffect(() => {
    verifyAdminKey(getAdminKey()).then(() => setUnlocked(true)).catch(() => setAdminKey('')).finally(() => setChecking(false));
  }, [isAdmin]);

  if (checking) return <main className="adm adm--gate"><p className="text-muted" role="status">Checking access…</p></main>;
  if (!unlocked) return <Navigate to="/admin/login" replace />; // administrators sign in with e-mail and password; the shared key is no longer typed in here
  return (
    <div className="adm">
      <header className="adm-head">
        <Logo />
        <span className="adm-head__title"><ShieldCheck size={16} aria-hidden="true" /> Admin</span>
        {isAdmin
          ? <Link className="btn btn--secondary btn--sm" to="/admin/dashboard">Dashboard</Link>
          : <button type="button" className="btn btn--secondary btn--sm" onClick={lock}><LogOut size={16} aria-hidden="true" />Lock</button>}
      </header>
      <nav className="adm-tabs" aria-label="Admin sections">
        {TABS.map(([k, label, Icon]) => <button key={k} type="button" className={tab === k ? 'is-on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}><Icon size={16} aria-hidden="true" />{label}</button>)}
      </nav>
      <main className="adm-main">
        {tab === 'applications' && <ApplicationsPanel onAuthLost={lock} initialFilter={params.get('status') ?? 'All'} />}
        {tab === 'internships' && <InternshipsPanel onAuthLost={lock} />}
        {tab === 'certificates' && <CertificateApprovals onAuthLost={lock} />}
        {tab === 'announce' && <AnnouncePanel />}
      </main>
    </div>
  );
}
