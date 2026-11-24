import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Github, ExternalLink, Check, Undo2, X, TriangleAlert, Mail, CalendarClock } from 'lucide-react';
import Button from '../../components/ui/Button';
import { SubmissionStatus } from '../../components/tasks/SubmissionPanel';
import { useToast } from '../../components/ui/Toast';
import { usePageMeta } from '../../hooks/usePageMeta';
import { fmtDateTime } from '../../lib/format';
import * as api from '../../services/adminManagementService';

// Simple review: read the student's links and description, then approve, send back, or reject. No rubric scores.
// The server still records who decided, requires feedback for "changes" and "reject", and never lets a decision be changed afterwards.
const DECISIONS = {
  Approved: { icon: Check, label: 'Approve', done: 'Approved.', tone: 'go' },
  'Changes Requested': { icon: Undo2, label: 'Send back for changes', done: 'Sent back to the student.', tone: 'warn' },
  Rejected: { icon: X, label: 'Reject', done: 'Rejected.', tone: 'bad' },
};

export default function AdminProjectEvaluationPage() {
  const { id } = useParams(); usePageMeta('Review · Admin');
  const toast = useToast();
  const [d, setD] = useState(null); const [error, setError] = useState(null); const [feedback, setFeedback] = useState('');
  const [fbError, setFbError] = useState(''); const [busy, setBusy] = useState(false); const started = useRef(false);
  const [startError, setStartError] = useState('');

  useEffect(() => {
    started.current = false; setD(null); setError(null); setStartError('');
    api.getProject(id).then(async (data) => {
      // Opening a submission that is waiting moves it to "Under Review" (once, by an explicit request).
      if (['Submitted', 'Resubmitted'].includes(data.submission.status) && !started.current) { started.current = true; try { data = await api.startProjectReview(id); } catch (e) { setStartError(e?.message || 'Could not open this project for review.'); } }
      setD(data); setFeedback(data.draft?.feedback ?? '');
    }).catch(setError);
  }, [id]);

  const decide = async (decision) => {
    setFbError('');
    if (decision !== 'Approved' && feedback.trim().length < 10) { setFbError('Write a short message for the student (at least 10 characters).'); return; }
    setBusy(true);
    try { const next = await api.decideProject(id, { decision, feedback, simple: true }); setD(next); toast.success(DECISIONS[decision].done); }
    catch (e) { const f = e?.data?.error?.fields; if (f?.feedback) setFbError(f.feedback); else toast.error(e?.message || 'That did not work. Please try again.'); }
    finally { setBusy(false); }
  };

  if (error) return <div className="adm-page"><div className="empty" role="alert"><span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span><h3>{error.status === 404 ? 'Not found' : 'Couldn’t load this submission'}</h3><Button to="/admin/projects" variant="secondary" icon={ArrowLeft}>Back</Button></div></div>;
  if (!d) return <div className="adm-page"><div className="card asks" aria-hidden="true">{[0, 1, 2].map((n) => <i key={n} className="sk sk--line" />)}</div></div>;

  const retry = async () => { setStartError(''); setBusy(true); try { setD(await api.startProjectReview(id)); } catch (e) { setStartError(e?.message || 'Could not open this project for review.'); } finally { setBusy(false); } };
  const waiting = ['Submitted', 'Resubmitted'].includes(d.submission.status);
  const sub = d.latestSubmission; const editable = d.submission.status === 'Under Review';
  const last = d.previousEvaluations?.at(-1);
  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><Link to="/admin/projects" className="text-muted"><ArrowLeft size={14} aria-hidden="true" /> Back</Link>
        <h1>{d.task.title}</h1><p className="text-muted">{d.student.name} · <Mail size={13} aria-hidden="true" /> {d.student.email}</p></div>
        <div><SubmissionStatus status={d.submission.status} />{d.submission.isResubmission && <span className="badge-sm"> v{d.submission.versions}</span>}</div></header>
      <section className="card pe-panel" aria-label="Submission">
        {sub ? <>
          <div className="pe-links">
            {sub.repositoryUrl && <a className="btn btn--secondary" href={sub.repositoryUrl} target="_blank" rel="noopener noreferrer" title="Open repository"><Github size={18} aria-hidden="true" />Repository</a>}
            {sub.liveUrl && <a className="btn btn--secondary" href={sub.liveUrl} target="_blank" rel="noopener noreferrer" title="Open demo"><ExternalLink size={18} aria-hidden="true" />Demo</a>}
          </div>
          <p className="text-muted"><CalendarClock size={14} aria-hidden="true" /> {fmtDateTime(sub.submittedAt)}</p>
          <p className="pe-pre">{sub.description}</p>
          {sub.submissionNotes && <p className="pe-pre text-muted">{sub.submissionNotes}</p>}
        </> : <p className="text-muted">Nothing has been submitted.</p>}
      </section>
      <section className="card pe-panel" aria-label="Decision">
        {editable ? <>
          <label htmlFor="pe-fb"><strong>Message to the student</strong></label>
          <textarea id="pe-fb" className="pe-textarea" rows={3} value={feedback} maxLength={4000} disabled={busy} onChange={(e) => { setFeedback(e.target.value); setFbError(''); }} aria-invalid={fbError ? 'true' : undefined} />
          {fbError && <p className="eval-err" role="alert">{fbError}</p>}
          <div className="adm-iconrow" role="group" aria-label="Decision">
            {Object.entries(DECISIONS).map(([k, v]) => { const Icon = v.icon; return (
              <button key={k} type="button" className={`adm-ib adm-ib--${v.tone}`} title={v.label} aria-label={v.label} disabled={busy} onClick={() => decide(k)}><Icon size={22} aria-hidden="true" /></button>); })}
          </div>
        </> : waiting ? <div role="alert"><p className="eval-err">{startError || 'This project is waiting to be opened for review.'}</p><Button variant="secondary" onClick={retry} disabled={busy}>Try again</Button></div>
        : <p className="sub-locked" role="status">{['Approved', 'Rejected'].includes(d.submission.status) ? `Decision made: ${d.submission.status}.` : d.submission.status === 'Changes Requested' ? 'Waiting for the student to resubmit.' : 'Nothing to review right now.'}{last?.feedback ? ` “${last.feedback}”` : ''}</p>}
      </section>
    </div>
  );
}
