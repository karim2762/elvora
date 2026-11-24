import { useState } from 'react';
import Button from '../../components/ui/Button';
import Pagination from '../../components/applications/Pagination';
import { useAdminList } from '../../hooks/useAdminList';
import { usePageMeta } from '../../hooks/usePageMeta';
import { fmtDateTime } from '../../lib/format';
import * as api from '../../services/priorityAdminService';

const FREE = 'Administrative corrections caused by ELVORA errors are processed free of charge.';
const msg = (e) => e?.message || 'Something went wrong. Please try again.';
const Err = ({ e }) => (e ? <p role="alert" className="text-muted">{msg(e)}</p> : null);

function RequestDetail({ id, onChanged }) {
  const { data, error, reload } = useAdminList(api.getRequest, id);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [reason, setReason] = useState(''); const [note, setNote] = useState('');
  const run = async (fn) => { setBusy(true); setErr(null); try { await fn(); await reload(); onChanged(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  if (error) return <Err e={error} />;
  if (!data) return <div className="card"><i className="sk sk--line" /></div>;
  const { request: r, student: s, application: a, actual, eligibility: el, completionEvidence: ce } = data;
  return (
    <section className="card" aria-label={`Request ${r.id}`} style={{ padding: 16, display: 'grid', gap: 12 }}>
      <h2>{r.id} · <span className="status status--teal">{r.status}</span> <span className="text-muted">({r.paymentState === 'paid' ? 'paid' : 'unpaid — payment opens in a later release'})</span></h2>
      <p>{s.fullName} · {s.degree}, {s.branch} · {s.college} ({s.academicYear}, {s.graduationYear})<br />Application <span className="mono">{a.applicationId}</span> · {a.internshipTitle} · {a.durationDays} days</p>
      <p>Actual dates: {actual?.startDate ?? '—'} → {actual?.completedAt?.slice(0, 10) ?? '—'} · internship {actual?.status ?? 'no record'} · certificate approval {actual?.certificateDecision ?? '—'}</p>
      <div><strong>Eligibility (computed now by the server): {el.eligible ? 'Eligible' : el.state.replace(/_/g, ' ')}</strong>
        <ul>{el.checks.map((c) => <li key={c.key}>{c.passed ? '✓' : '✗'} {c.label}{c.reason ? ` — ${c.reason}` : ''}</li>)}</ul></div>
      {ce && <p>Tasks: {ce.taskProgress.requiredApproved}/{ce.taskProgress.requiredTotal} required approved · project submissions awaiting evaluation: {ce.projectSubmissionsAwaitingEvaluation}</p>}
      <div><strong>Documents</strong><ul>{data.documents.length ? data.documents.map((d) => <li key={d.id}><span className="mono">{d.documentNumber ?? d.id}</span> · {d.status}{d.replacedBy ? ` · superseded by ${d.replacedBy}` : ''}{d.replaces ? ` · replaces ${d.replaces}` : ''}</li>) : <li>None</li>}</ul></div>
      <div><strong>History</strong><ul>{data.history.map((h, i) => <li key={i}>{fmtDateTime(h.at)} · {h.from ?? '—'} → {h.to}{h.note ? ` · ${h.note}` : ''}</li>)}</ul></div>
      <div><strong>Internal notes</strong><ul>{data.notes.map((n) => <li key={n.id}>{n.adminName}: {n.note}</li>)}</ul>
        <input className="adm-select" aria-label="Internal note" placeholder="Add an internal note (never shown to students)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button disabled={busy || note.trim().length < 3} onClick={() => run(async () => { await api.addNote(r.id, note); setNote(''); })}>Add note</Button></div>
      {data.allowedTransitions.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label>Reason / approval evidence (rejection, correction, cancellation and approval require it; the reason is shown to the student for rejections and requests for information)
            <textarea className="adm-select" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button disabled={busy} onClick={() => run(() => api.reviewRequest(r.id))}>Run eligibility review</Button>
            {data.allowedTransitions.map((t) => <Button key={t.to} disabled={busy} onClick={() => run(() => api.setStatus(r.id, { to: t.to, reason, note: reason }))}>{t.to}</Button>)}
            {data.canIssue && <Button disabled={busy} onClick={() => run(() => api.issueRequest(r.id))}>Issue certificate</Button>}
          </div>
        </div>)}
      <Err e={err} />
      <p className="text-muted">{data.notice}</p>
    </section>);
}

function RequestsTab() {
  const [f, setF] = useState({ student: '', applicationId: '', requestId: '', status: 'All', durationDays: 'All', from: '', to: '' }); const [page, setPage] = useState(1); const [open, setOpen] = useState(null);
  const set = (k, v) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const { data, error, loading, reload } = useAdminList(api.listRequests, { ...f, page, pageSize: 25 });
  return (<>
    <div className="adm-tools card">
      {['student', 'applicationId', 'requestId'].map((k) => <input key={k} className="adm-select" aria-label={k} placeholder={{ student: 'Student name', applicationId: 'Application ID', requestId: 'Request ID' }[k]} value={f[k]} onChange={(e) => set(k, e.target.value)} />)}
      <select className="adm-select" aria-label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}><option value="All">All statuses</option>{(data?.filters.statuses ?? []).map((s) => <option key={s}>{s}</option>)}</select>
      <select className="adm-select" aria-label="Duration" value={f.durationDays} onChange={(e) => set('durationDays', e.target.value)}><option value="All">Any duration</option>{[30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
      <label className="adm-datefield">From <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></label>
      <label className="adm-datefield">To <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></label>
    </div>
    <Err e={error} />
    {data && (data.requests.length === 0 ? <p className="text-muted" role="status">No requests match.</p> : (
      <div className={loading ? 'adm-loading' : ''}><div className="atable card"><table><caption className="sr-only">Priority certificate requests</caption>
        <thead><tr><th>Request</th><th>Student</th><th>Application</th><th>Days</th><th>Status</th><th>Payment</th><th>Updated</th><th /></tr></thead>
        <tbody>{data.requests.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td>{r.studentName}</td><td className="mono">{r.applicationId}</td><td>{r.durationDays}</td><td>{r.status}</td><td>{r.paymentState}</td><td>{fmtDateTime(r.updatedAt)}</td><td><Button onClick={() => setOpen(r.id)}>Open</Button></td></tr>)}</tbody></table></div>
        <Pagination {...data.pagination} onChange={setPage} /></div>))}
    {open && <RequestDetail key={open} id={open} onChanged={reload} />}
  </>);
}

const FIELDS = { student_name: [['fullName', 'Corrected full name']], internship_dates: [['startDate', 'Corrected start date (YYYY-MM-DD)'], ['completedAt', 'Corrected completion date (YYYY-MM-DD)']],
  academic_info: [['college', 'College'], ['degree', 'Degree'], ['branch', 'Branch'], ['academicYear', 'Academic year'], ['graduationYear', 'Graduation year']] };

function NewCorrection({ categories, onDone }) {
  const [studentId, setStudentId] = useState(''); const [certs, setCerts] = useState(null); const [form, setForm] = useState({ documentId: '', category: 'student_name', reason: '', evidence: '', confirm: false, corrected: {} });
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const lookup = async () => { setErr(null); try { setCerts(await api.studentCertificates(studentId.trim())); } catch (e) { setErr(e); setCerts(null); } };
  const submit = async () => { setBusy(true); setErr(null); try { await api.createCorrection({ studentId: certs.student.id, ...form }); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const doc = certs?.documents.find((d) => d.id === form.documentId);
  return (
    <section className="card" style={{ padding: 16, display: 'grid', gap: 10 }} aria-label="New free correction">
      <h2>New free correction</h2><p role="note"><strong>{FREE}</strong> No payment options are shown for corrections.</p>
      <div><input className="adm-select" aria-label="Student ID" placeholder="Student ID" value={studentId} onChange={(e) => setStudentId(e.target.value)} /> <Button disabled={!studentId.trim()} onClick={lookup}>Find certificates</Button></div>
      {certs && (<>
        <p>Student: <strong>{certs.student.fullName}</strong></p>
        <select className="adm-select" aria-label="Existing document" value={form.documentId} onChange={(e) => setForm({ ...form, documentId: e.target.value })}><option value="">Select the certificate to correct</option>{certs.documents.map((d) => <option key={d.id} value={d.id}>{d.documentNumber} · {d.internshipTitle}</option>)}</select>
        <select className="adm-select" aria-label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value, corrected: {} })}>{Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        {(FIELDS[form.category] ?? []).map(([k, label]) => <label key={k}>{label}<input className="adm-select" value={form.corrected[k] ?? ''} onChange={(e) => setForm({ ...form, corrected: { ...form.corrected, [k]: e.target.value } })} /></label>)}
        {!FIELDS[form.category] && <p className="text-muted">No stored value is edited for this category: the certificate is regenerated from the verified records, and only if that produces different content.</p>}
        <p className="text-muted">Original values are read from the records by the server and kept permanently with the correction.</p>
        <label>Correction reason (required)<textarea className="adm-select" rows={2} maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
        <label>Supporting evidence (required)<textarea className="adm-select" rows={2} maxLength={1000} value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} /></label>
        <label><input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} /> I confirm this is an ELVORA error, supported by evidence, and not a way to change internship completion or dates without evidence.</label>
        <Button disabled={busy || !doc || !form.confirm} onClick={submit}>Create free correction</Button></>)}
      <Err e={err} />
    </section>);
}

function CorrectionsTab() {
  const [status, setStatus] = useState('All'); const [page, setPage] = useState(1); const [sel, setSel] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const [creating, setCreating] = useState(false);
  const { data, error, reload } = useAdminList(api.listCorrections, { status, page, pageSize: 25 });
  const open = async (id) => { setErr(null); try { setSel(await api.getCorrection(id)); } catch (e) { setErr(e); } };
  const act = async (fn) => { setBusy(true); setErr(null); try { setSel(await fn()); reload(); } catch (e) { setErr(e); reload(); if (sel) open(sel.id); } finally { setBusy(false); } };
  return (<>
    <p role="note"><strong>{FREE}</strong></p>
    <div className="adm-tools card"><select className="adm-select" aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="All">All statuses</option>{['Pending Approval', 'Processing', 'Reissued', 'Failed', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}</select>
      <Button onClick={() => setCreating(!creating)}>{creating ? 'Close form' : 'New free correction'}</Button></div>
    {creating && data && <NewCorrection categories={data.categories} onDone={() => { setCreating(false); reload(); }} />}
    <Err e={error} /><Err e={err} />
    {data && (<><div className="atable card"><table><caption className="sr-only">Free corrections</caption><thead><tr><th>Correction</th><th>Student</th><th>Category</th><th>Status</th><th>Fee</th><th>Created</th><th /></tr></thead>
      <tbody>{data.corrections.map((c) => <tr key={c.id}><td className="mono">{c.id}</td><td>{c.studentName}</td><td>{c.categoryLabel}</td><td>{c.status}</td><td>Free</td><td>{fmtDateTime(c.createdAt)}</td><td><Button onClick={() => open(c.id)}>Open</Button></td></tr>)}</tbody></table></div>
      <Pagination {...data.pagination} onChange={setPage} /></>)}
    {sel && (<section className="card" style={{ padding: 16, display: 'grid', gap: 8 }} aria-label={`Correction ${sel.id}`}>
      <h2>{sel.id} · {sel.status} · Free</h2><p>{sel.categoryLabel}</p><p>Reason: {sel.reason}<br />Evidence: {sel.evidence}</p>
      <p>Original: <code>{JSON.stringify(sel.originalValues)}</code><br />Corrected: <code>{JSON.stringify(sel.correctedValues)}</code></p>
      <p>Original document: <span className="mono">{sel.originalDocument?.documentNumber}</span> ({sel.originalDocument?.status}){sel.replacementDocument && <> · Replacement: <span className="mono">{sel.replacementDocument.documentNumber}</span> ({sel.replacementDocument.status})</>}</p>
      {sel.failureCode && <p role="alert">Last attempt failed ({sel.failureCode}). Nothing was changed; you can retry.</p>}
      <ul>{sel.history.map((h, i) => <li key={i}>{fmtDateTime(h.at)} · {h.from ?? '—'} → {h.to}{h.note ? ` · ${h.note}` : ''}</li>)}</ul>
      {['Pending Approval', 'Failed'].includes(sel.status) && <div style={{ display: 'flex', gap: 8 }}>
        <Button disabled={busy} onClick={() => act(() => api.approveCorrection(sel.id))}>{sel.status === 'Failed' ? 'Retry reissue' : 'Approve and reissue certificate'}</Button>
        <Button disabled={busy} onClick={() => { const r = window.prompt('Reason for cancelling (10+ characters)'); if (r) act(() => api.cancelCorrection(sel.id, r)); }}>Cancel correction</Button></div>}
    </section>)}
  </>);
}

export default function AdminPriorityPage() {
  usePageMeta('Priority Certificate Requests · Admin');
  const [tab, setTab] = useState('requests');
  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><h1>Priority Certificate Requests</h1><p className="text-muted">Review requests, run eligibility checks and process free corrections. Payment handling is not part of this release.</p></div></header>
      <div role="tablist" style={{ display: 'flex', gap: 8 }}>
        {[['requests', 'Requests'], ['corrections', 'Free corrections']].map(([k, l]) => <Button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</Button>)}</div>
      {tab === 'requests' ? <RequestsTab /> : <CorrectionsTab />}
    </div>);
}
