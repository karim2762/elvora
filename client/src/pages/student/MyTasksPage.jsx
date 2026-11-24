import { Link } from 'react-router-dom';
import { ListChecks, ChevronRight, Clock, RefreshCw } from 'lucide-react';
import { LoadError } from '../../components/dashboard/PageStates';
import { useRemote } from '../../hooks/useApplications';
import { useSessionExpiry } from '../../hooks/useSessionExpiry';
import { usePageMeta } from '../../hooks/usePageMeta';
import { listMyTasks } from '../../services/studentService';
import { studentRoutes } from '../../config/dashboard';
import { fmtDate } from '../../lib/format';
import { SubmissionStatus } from '../../components/tasks/SubmissionPanel';

const STAGES = ['Beginner Foundation', 'Intermediate Implementation', 'Practical Internship Project'];

export default function MyTasksPage() {
  usePageMeta('My Tasks');
  const { status, data, error, reload } = useRemote(listMyTasks, []);
  const expired = useSessionExpiry(status, error);
  if (expired) return null;
  if (status === 'loading') return <div className="track" aria-busy="true" aria-label="Loading your tasks"><div className="card"><i className="sk sk--title" /><i className="sk sk--line" /></div></div>;
  if (status === 'error') return <div className="track"><LoadError title="We couldn’t load your tasks" error={error} onRetry={reload} /></div>;
  const { tasks, summary } = data;
  return (
    <div className="track">
      <header className="track__head"><div><h1>My Tasks</h1><p className="text-muted">Open a task to read the instructions and submit your work.</p></div></header>
      {tasks.length === 0
        ? <div className="empty" role="status"><span className="empty__icon"><ListChecks size={28} aria-hidden="true" /></span><h3>No tasks yet</h3><p className="text-muted">Tasks appear here once your internship is set up. Pull down to refresh in a moment.</p><button type="button" className="btn btn--secondary btn--sm" onClick={reload} aria-label="Refresh"><RefreshCw size={16} aria-hidden="true" /></button></div>
        : <>
          <div className="card tl-summary"><div><strong>{summary.approved} of {summary.total}</strong> tasks approved</div>
            <div className="td__meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.percent} aria-label="Approved tasks"><span style={{ width: `${summary.percent}%` }} /></div></div>
          {STAGES.map((stage, i) => { const rows = tasks.filter((t) => t.task?.learningStage === stage); if (!rows.length) return null; return (
            <section key={stage} aria-labelledby={`tl-${i}`} className="tl-stage">
              <h2 id={`tl-${i}`}><span className="tl-stage__n">{i + 1}</span>{stage}</h2>
              <ul className="tl-list">{rows.map((t) => (
                <li key={t.id}><Link to={`${studentRoutes.tasks}/${t.id}`} className="card card--interactive tl-item">
                  <div><strong>{t.task.title}</strong><p className="text-muted">{t.task.shortDescription}</p>
                    <p className="tl-item__meta"><SubmissionStatus status={t.submissionStatus} /><span className="badge-sm">{t.task.difficulty}</span>
                      {t.task.estimatedHours ? <span className="badge-sm"><Clock size={13} aria-hidden="true" />{t.task.estimatedHours} h</span> : null}{t.dueDate ? <span className="badge-sm">Due {fmtDate(t.dueDate)}</span> : null}</p></div>
                  <ChevronRight size={20} aria-hidden="true" /></Link></li>))}</ul>
            </section>); })}
        </>}
    </div>
  );
}
