import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, Send } from 'lucide-react';
import TaskDetail from '../../components/tasks/TaskDetail';
import SubmissionPanel, { SubmissionStatus } from '../../components/tasks/SubmissionPanel';
import { LoadError } from '../../components/dashboard/PageStates';
import { useRemote } from '../../hooks/useApplications';
import { useSessionExpiry } from '../../hooks/useSessionExpiry';
import { usePageMeta } from '../../hooks/usePageMeta';
import { getMyTask } from '../../services/studentService';
import { studentRoutes } from '../../config/dashboard';
import { fmtDate } from '../../lib/format';

export default function TaskDetailPage() {
  const { id } = useParams();
  const [tab, setTab] = useState(() => (typeof window !== 'undefined' && window.location.hash === '#submit-work' ? 'submit' : 'task'));
  const { status, data, error, reload } = useRemote(() => getMyTask(id), [id]);
  usePageMeta(data?.task?.title ? `${data.task.title} · My Tasks` : 'Task');
  const expired = useSessionExpiry(status, error);
  if (expired) return null;
  const back = <Link to={studentRoutes.tasks} className="td__back"><ArrowLeft size={16} aria-hidden="true" /> All my tasks</Link>;
  if (status === 'loading') return <div className="td" aria-busy="true"><div className="card td__head"><i className="sk sk--title" /><i className="sk sk--line" /></div></div>;
  if (status === 'error') return <div className="track">{back}{error?.status === 404
    ? <div className="empty" role="alert"><h3>We couldn’t find that task</h3><p className="text-muted">It may not be assigned to you.</p></div>
    : <LoadError title="We couldn’t load this task" error={error} onRetry={reload} />}</div>;
  const { assignment, task, position, submission, submissions, reviews, evaluations } = data;
  return (
    <div className="track">
      {back}
      <p className="text-muted td__meta">Task {position.index} of {position.total} · Status: <SubmissionStatus status={assignment.submissionStatus} />{assignment.dueDate ? <> · Due {fmtDate(assignment.dueDate)}</> : null}{assignment.required ? '' : ' · Optional'}</p>
      <div className="td-tabs" role="tablist" aria-label="Task sections">
        <button type="button" role="tab" id="tab-task" aria-selected={tab === 'task'} aria-controls="panel-task" className={`td-tabs__btn${tab === 'task' ? ' is-on' : ''}`} onClick={() => setTab('task')}><BookOpen size={16} aria-hidden="true" />Instructions</button>
        <button type="button" role="tab" id="tab-submit" aria-selected={tab === 'submit'} aria-controls="panel-submit" className={`td-tabs__btn${tab === 'submit' ? ' is-on' : ''}`} onClick={() => setTab('submit')}><Send size={16} aria-hidden="true" />Submit your work</button>
      </div>
      <div id="panel-task" role="tabpanel" aria-labelledby="tab-task" hidden={tab !== 'task'}>
        <TaskDetail task={task} storageKey={assignment.id} />
        <div className="card td-cta"><div><strong>Finished the work?</strong><p className="text-muted">Send your project link for review.</p></div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => { setTab('submit'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><Send size={16} aria-hidden="true" />Go to submission form</button></div>
      </div>
      <div id="panel-submit" role="tabpanel" aria-labelledby="tab-submit" hidden={tab !== 'submit'}>
        {/* key = latest version + status: after a submit or a review the form re-seeds from the server's current state */}
        <SubmissionPanel key={`${submission.versions}-${assignment.status}`} taskId={assignment.id} submission={submission} submissions={submissions} reviews={reviews} evaluations={evaluations} onChanged={reload} />
      </div>
    </div>
  );
}
