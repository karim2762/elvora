import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert, ClipboardCheck, Github, ExternalLink } from 'lucide-react';
import Button from '../../components/ui/Button';
import { SubmissionStatus } from '../../components/tasks/SubmissionPanel';
import { usePageMeta } from '../../hooks/usePageMeta';
import { fmtDateTime } from '../../lib/format';
import * as api from '../../services/adminManagementService';

// Stage 09B Part 2B — every GitHub project submission, with filters. Opening one starts (or continues) its review.
const sessionEnded = (e) => e?.status === 401 || e?.status === 403;
const CATEGORIES = [['python-development', 'Python'], ['java-development', 'Java'], ['web-development', 'Web Development'], ['full-stack-development', 'Full Stack'], ['artificial-intelligence', 'Artificial Intelligence'],
  ['machine-learning', 'Machine Learning'], ['data-science', 'Data Science'], ['cybersecurity', 'Cybersecurity'], ['cloud-computing', 'Cloud Computing'], ['ui-ux-design', 'UI/UX'], ['c-programming', 'C'], ['software-development', 'Software Development']];

export default function AdminProjectsPage() {
  usePageMeta('Project Reviews · Admin');
  const [opts, setOpts] = useState(null); const [res, setRes] = useState(null); const [error, setError] = useState(null);
  const [f, setF] = useState({ category: '', taskId: '', studentId: '', status: '', q: '', page: 1 });
  useEffect(() => { api.getProjectOptions().then(setOpts).catch(() => {}); }, []);
  const load = () => { setError(null); api.listProjects({ ...f, pageSize: 20 }).then(setRes).catch(setError); };
  useEffect(load, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((x) => ({ ...x, [k]: v, page: k === 'page' ? v : 1 }));
  const tasks = (opts?.tasks ?? []).filter((t) => !f.category || t.category === f.category);
  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><h1>Project Reviews</h1><p className="text-muted">Open a submission, then approve it, send it back or reject it.</p></div></header>
      {res && <div className="adm-chips" role="group" aria-label="Filter by status">
        <button type="button" className={`adm-chip ${f.status === '' ? 'is-on' : ''}`} onClick={() => set('status', '')}>All submitted</button>
        {(opts?.statuses ?? []).filter((s) => s !== 'Not Submitted').map((s) => <button key={s} type="button" className={`adm-chip ${f.status === s ? 'is-on' : ''}`} onClick={() => set('status', s)}>{s}<span className="adm-chip__n">{res.counts[s] ?? 0}</span></button>)}
      </div>}
      <div className="adm-tools card">
        <select className="adm-select" value={f.category} onChange={(e) => setF((x) => ({ ...x, category: e.target.value, taskId: '', page: 1 }))} aria-label="Filter by internship category"><option value="">All categories</option>{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select className="adm-select" value={f.taskId} onChange={(e) => set('taskId', e.target.value)} aria-label="Filter by task"><option value="">All tasks</option>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
        <select className="adm-select" value={f.studentId} onChange={(e) => set('studentId', e.target.value)} aria-label="Filter by student"><option value="">All students</option>{(opts?.students ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input type="search" className="adm-select" placeholder="Search student, task or repository" value={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Search submissions" />
      </div>
      {error ? <div className="empty" role="alert"><span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span><h3>Couldn’t load project submissions</h3>
        <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended. Sign in again.' : 'Something went wrong. Please try again.'}</p><Button onClick={load}>Try again</Button></div>
        : !res ? <div className="card asks" aria-hidden="true">{[0, 1, 2].map((n) => <i key={n} className="sk sk--line" />)}</div>
        : res.submissions.length === 0 ? <div className="empty" role="status"><span className="empty__icon"><ClipboardCheck size={28} aria-hidden="true" /></span><h3>No project submissions match</h3><p className="text-muted">Try a different filter.</p></div>
        : <>
          <ul className="tl-list">{res.submissions.map((s) => (
            <li key={s.id} className="card tl-admin"><div className="tl-admin__row">
              <div>
                <strong>{s.task.title}</strong> <span className="text-muted">· {s.student.name}</span>
                <p className="tl-item__meta"><SubmissionStatus status={s.status} />
                  {s.isNew && <span className="badge-sm badge-sm--blue">New</span>}{s.isResubmission && <span className="badge-sm">Resubmission · v{s.versions}</span>}{s.hasDraft && <span className="badge-sm">Draft saved</span>}
                  <span className="badge-sm">{s.internship.title}</span>{s.lastEvaluation && <span className="badge-sm">{s.lastEvaluation.decision}</span>}</p>
                <p className="text-muted">Submitted {s.submittedAt ? fmtDateTime(s.submittedAt) : '—'}
                  {s.repositoryUrl && <> · <a href={s.repositoryUrl} target="_blank" rel="noopener noreferrer"><Github size={14} aria-hidden="true" /> Repository<span className="sr-only"> (opens in a new tab)</span></a></>}
                  {s.liveUrl && <> · <a href={s.liveUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" /> Live site<span className="sr-only"> (opens in a new tab)</span></a></>}</p>
              </div>
              <div className="tl-admin__act"><Button to={`/admin/projects/${s.id}`} variant={['Submitted', 'Resubmitted', 'Under Review'].includes(s.status) ? 'primary' : 'secondary'}>{['Submitted', 'Resubmitted'].includes(s.status) ? 'Review' : s.status === 'Under Review' ? 'Continue review' : 'View'}</Button></div>
            </div></li>))}</ul>
          <div className="adm-pager"><Button variant="secondary" disabled={res.pagination.page <= 1} onClick={() => set('page', f.page - 1)}>Previous</Button>
            <span>Page {res.pagination.page} of {res.pagination.totalPages} · {res.pagination.total} submissions</span>
            <Button variant="secondary" disabled={res.pagination.page >= res.pagination.totalPages} onClick={() => set('page', f.page + 1)}>Next</Button></div>
        </>}
    </div>
  );
}
