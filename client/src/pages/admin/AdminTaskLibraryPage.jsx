import { useEffect, useState } from 'react';
import { TriangleAlert, LibraryBig, ChevronDown } from 'lucide-react';
import Button from '../../components/ui/Button';
import TaskDetail from '../../components/tasks/TaskDetail';
import { useToast } from '../../components/ui/Toast';
import { usePageMeta } from '../../hooks/usePageMeta';
import * as api from '../../services/adminManagementService';

const sessionEnded = (e) => e?.status === 401 || e?.status === 403;

export default function AdminTaskLibraryPage() {
  usePageMeta('Task Library · Admin');
  const toast = useToast();
  const [opts, setOpts] = useState(null); const [f, setF] = useState({ category: '', stage: '', state: '', q: '', page: 1 });
  const [res, setRes] = useState(null); const [error, setError] = useState(null); const [open, setOpen] = useState(null); const [busy, setBusy] = useState(null);
  useEffect(() => { api.getTaskLibraryOptions().then(setOpts).catch(setError); }, []);
  const load = () => { setError(null); api.listTaskTemplates({ ...f, pageSize: 20 }).then(setRes).catch(setError); };
  useEffect(load, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((x) => ({ ...x, [k]: v, page: k === 'page' ? v : 1 }));
  const toggle = async (t) => {
    setBusy(t.id);
    try { const n = await api.setTaskTemplateState(t.id, t.published ? 'unpublish' : 'publish'); toast.success(n.published ? 'Task activated.' : 'Task deactivated.'); load(); }
    catch (e) { toast.error(e.message || 'Could not change the task.'); } finally { setBusy(null); }
  };
  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><h1>Task Library</h1><p className="text-muted">Reusable assignments for every internship category, organised by learning stage. Active tasks can be attached to internships; changing a template never alters an internship that already uses it.</p></div></header>
      <div className="adm-tools card">
        <select className="adm-select" value={f.category} onChange={(e) => set('category', e.target.value)} aria-label="Filter by category"><option value="">All categories</option>{opts?.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <select className="adm-select" value={f.stage} onChange={(e) => set('stage', e.target.value)} aria-label="Filter by learning stage"><option value="">All stages</option>{opts?.learningStages.map((s) => <option key={s}>{s}</option>)}</select>
        <select className="adm-select" value={f.state} onChange={(e) => set('state', e.target.value)} aria-label="Filter by status"><option value="">Active and inactive</option><option value="published">Active</option><option value="draft">Inactive</option></select>
        <input type="search" className="adm-select" placeholder="Search title" value={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Search tasks" />
      </div>
      {error ? <div className="empty" role="alert"><span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span><h3>Couldn’t load the task library</h3>
        <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended. Sign in again.' : 'Something went wrong. Please try again.'}</p><Button onClick={load}>Try again</Button></div>
        : !res ? <div className="card asks" aria-hidden="true">{[0, 1, 2].map((n) => <i key={n} className="sk sk--line" />)}</div>
        : res.templates.length === 0 ? <div className="empty" role="status"><span className="empty__icon"><LibraryBig size={28} aria-hidden="true" /></span><h3>No tasks match</h3></div>
        : <>
          <ul className="tl-list">{res.templates.map((t) => (
            <li key={t.id} className="card tl-admin">
              <div className="tl-admin__row">
                <div><strong>{t.title}</strong><p className="tl-item__meta"><span className="badge-sm">{t.categoryLabel}</span><span className="badge-sm badge-sm--blue">{t.learningStage}</span><span className="badge-sm">{t.difficulty}</span>
                  {t.estimatedHours ? <span className="badge-sm">{t.estimatedHours} h</span> : null}<span className={`badge-sm ${t.published ? 'badge-sm--blue' : ''}`}>{t.published ? 'Active' : 'Inactive'}</span>{!t.readiness.ready && <span className="badge-sm">Incomplete: {t.readiness.missing.join(', ')}</span>}</p></div>
                <div className="tl-admin__act"><Button variant="secondary" disabled={busy === t.id || (!t.published && !t.readiness.ready)} onClick={() => toggle(t)}>{t.published ? 'Deactivate' : 'Activate'}</Button>
                  <button type="button" className="dash-iconbtn" aria-expanded={open === t.id} aria-label={`${open === t.id ? 'Hide' : 'Show'} preview of ${t.title}`} onClick={() => setOpen(open === t.id ? null : t.id)}><ChevronDown size={18} aria-hidden="true" /></button></div>
              </div>
              {open === t.id && <div className="tl-admin__preview"><TaskDetail task={t} /></div>}
            </li>))}</ul>
          <div className="adm-pager"><Button variant="secondary" disabled={res.pagination.page <= 1} onClick={() => set('page', f.page - 1)}>Previous</Button>
            <span>Page {res.pagination.page} of {res.pagination.totalPages} · {res.pagination.total} tasks</span>
            <Button variant="secondary" disabled={res.pagination.page >= res.pagination.totalPages} onClick={() => set('page', f.page + 1)}>Next</Button></div>
        </>}
    </div>
  );
}
