import { useRef, useState } from 'react';
import { History, MessageSquareText, Send } from 'lucide-react';
import { TextField, TextAreaField } from '../forms/Field';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { githubRepoError, httpsUrlError } from '../../lib/github';
import { submitMyTask } from '../../services/studentService';
import { fmtDateTime } from '../../lib/format';

// Stage 09B Part 2A — the student's GitHub project submission: requirements, the form, current status, feedback and version history.
// Everything shown comes from the server (`submission` block of GET /student/tasks/:id). The checks here are for instant feedback only;
// the server validates everything again. Nothing on this screen says a repository is verified, because nothing has verified it yet.
const TONE = { 'Not Submitted': 'slate', Submitted: 'blue', 'Under Review': 'indigo', 'Changes Requested': 'amber', Resubmitted: 'blue', Approved: 'teal', Rejected: 'red' };
export const SubmissionStatus = ({ status }) => <span className={`status status--${TONE[status] ?? 'slate'}`}>{status}</span>;
const EMPTY = { repositoryUrl: '', repositoryDescription: '', liveUrl: '', documentationUrl: '', description: '', submissionNotes: '', implementedFeatures: '', testingPerformed: '', challengesEncountered: '' };
const friendly = (e) => (e?.status === 0 ? e.message : e?.status === 429 ? 'You are submitting too quickly. Please wait a while and try again.' : e?.message || 'We couldn’t submit your work. Please try again.');

function SubmissionHistory({ submissions, reviews }) {
  if (!submissions.length) return null;
  const list = [...submissions].reverse();
  return (
    <section className="td__section card" aria-labelledby="sub-history"><h2 id="sub-history"><History size={18} aria-hidden="true" />Submission history</h2>
      <ol className="sub-history">{list.map((s) => { const r = reviews.filter((x) => x.submissionVersion === s.version); return (
        <li key={s.id}>
          <p className="sub-history__head"><strong>Version {s.version}</strong><span className="text-muted">{fmtDateTime(s.submittedAt)}</span></p>
          <dl className="sub-facts">
            {s.repositoryUrl && <><dt>Repository</dt><dd><a href={s.repositoryUrl} target="_blank" rel="noopener noreferrer">{s.repositoryUrl}</a></dd></>}
            {s.liveUrl && <><dt>Demo link</dt><dd><a href={s.liveUrl} target="_blank" rel="noopener noreferrer">{s.liveUrl}</a></dd></>}
            <dt>What you did</dt><dd className="sub-pre">{s.description}</dd>
            {s.submissionNotes && <><dt>Notes</dt><dd className="sub-pre">{s.submissionNotes}</dd></>}
          </dl>
          {r.map((x) => <div key={x.id} className="sub-feedback"><p><strong>{x.decision}</strong> · {x.reviewerName} · {fmtDateTime(x.reviewedAt)}{x.score != null ? ` · Score ${x.score}/100` : ''}</p>{x.feedback && <p className="sub-pre">{x.feedback}</p>}</div>)}
        </li>); })}</ol>
    </section>
  );
}

const hasScores = (e) => e.weightedTotal != null && (e.breakdown ?? []).some((r) => r.score != null);
const DECISION_TONE = { Approved: 'teal', 'Changes Requested': 'amber', Rejected: 'red' };
// Finalized evaluations only (the server never sends drafts to students): decision, overall score, the rubric breakdown and the reviewer's feedback.
function Evaluations({ evaluations }) {
  if (!evaluations?.length) return null;
  return (
    <section className="td__section card" aria-labelledby="eval-h">
      <h2 id="eval-h"><MessageSquareText size={18} aria-hidden="true" />Evaluation results</h2>
      <ol className="sub-history">{[...evaluations].reverse().map((e) => (
        <li key={e.id}>
          <p className="sub-history__head"><strong>Version {e.submissionVersion}</strong><span><span className={`status status--${DECISION_TONE[e.decision] ?? 'slate'}`}>{e.decision}</span> <span className="text-muted">· {fmtDateTime(e.decidedAt)}</span></span></p>
          {hasScores(e) && <p className="eval-total">Overall score <strong>{e.weightedTotal}</strong> / 100 <span className="text-muted">· {e.rubricName}</span></p>}
          {hasScores(e) && <div className="eval-tablewrap"><table className="eval-table"><thead><tr><th scope="col">Area</th><th scope="col">Weight</th><th scope="col">Score</th><th scope="col">Weighted</th></tr></thead>
            <tbody>{e.breakdown.map((r) => <tr key={r.key}><th scope="row">{r.label}</th><td>{r.weight}%</td><td>{r.score} / {r.maxScore}</td><td>{r.contribution} / {r.maxContribution}</td></tr>)}</tbody></table></div>}
          {e.feedback && <div className="sub-feedback"><h3>Reviewer feedback</h3><p className="sub-pre">{e.feedback}</p></div>}
        </li>))}</ol>
    </section>
  );
}

export default function SubmissionPanel({ taskId, submission, submissions, reviews, evaluations = [], onChanged }) {
  const toast = useToast();
  const g = submission.guide;
  const [values, setValues] = useState(() => ({ ...EMPTY, ...Object.fromEntries(Object.entries(submission.draft ?? {}).map(([k, v]) => [k, v ?? ''])) }));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const ref = useRef(null);
  const set = (name, value) => { setValues((v) => ({ ...v, [name]: value })); setErrors((e) => ({ ...e, [name]: undefined })); };

  const check = (v) => {
    const e = {};
    const repo = githubRepoError(v.repositoryUrl, { required: g.requiresRepository }); if (repo) e.repositoryUrl = repo;
    const live = httpsUrlError(v.liveUrl, { required: g.requiresLiveUrl, label: 'The demo link' }); if (live) e.liveUrl = live;
    const d = v.description.trim(); if (d.length < 20) e.description = 'Write at least 20 characters'; else if (d.length > 3000) e.description = 'Keep it to 3000 characters or fewer';
    if (v.submissionNotes.trim().length > 1000) e.submissionNotes = 'Keep the note to 1000 characters or fewer';
    return e;
  };
  const focusFirst = (e) => { const first = Object.keys(e).find((k) => e[k]); if (first) ref.current?.querySelector(`[name="${first}"]`)?.focus(); };
  const blur = (name) => { const e = check(values); setErrors((p) => ({ ...p, [name]: e[name] })); };

  const submit = async (ev) => {
    ev.preventDefault(); if (busy) return;
    const e = check(values); setErrors(e);
    if (Object.keys(e).length) { setFormError('Please fix the highlighted fields.'); focusFirst(e); return; }
    setFormError(''); setBusy(true);
    try {
      await submitMyTask(taskId, { repositoryUrl: values.repositoryUrl, liveUrl: values.liveUrl, description: values.description, submissionNotes: values.submissionNotes });
      toast.success(submission.resubmitting ? 'Your corrected work was resubmitted.' : 'Your work was submitted for review.');
      onChanged();
    } catch (err) {
      const fields = err?.data?.error?.fields;
      if (fields) { setErrors(fields); focusFirst(fields); setFormError('Please fix the highlighted fields.'); } else setFormError(friendly(err));
      if (err?.status === 409) onChanged(); // someone changed the state (for example a review): show the current one
    } finally { setBusy(false); }
  };
  const p = (name) => ({ name, value: values[name], onChange: set, onBlur: blur, error: errors[name] });
  const lastReview = reviews.at(-1);
  const lastEval = evaluations.at(-1);

  return (
    <>
      <section className="td__section card" id="submit-work" aria-labelledby="sub-h">
        <h2 id="sub-h"><Send size={18} aria-hidden="true" />Submit your work</h2>
        <p className="sub-status">Status: <SubmissionStatus status={submission.status} />{submission.versions > 0 && <span className="text-muted"> · Version {submission.versions} submitted</span>}</p>
        {submission.status === 'Changes Requested' && lastReview?.feedback && (
          <div className="sub-feedback sub-feedback--alert" role="status"><h3><MessageSquareText size={18} aria-hidden="true" />Your reviewer asked for changes</h3><p className="sub-pre">{lastReview.feedback}</p><p className="text-muted">Fix it and resubmit below.</p></div>)}
        {submission.status === 'Rejected' && lastEval?.feedback && <div className="sub-feedback sub-feedback--alert" role="status"><h3><MessageSquareText size={18} aria-hidden="true" />This project was not accepted</h3><p className="sub-pre">{lastEval.feedback}</p></div>}
        {submission.status === 'Under Review' && <p className="sub-locked" role="status">A reviewer is looking at your work. You will be notified.</p>}
        {submission.status === 'Approved' && lastReview?.feedback && <div className="sub-feedback" role="status"><h3><MessageSquareText size={18} aria-hidden="true" />Reviewer feedback</h3><p className="sub-pre">{lastReview.feedback}</p></div>}
        {submission.canSubmit ? (
          <form ref={ref} onSubmit={submit} noValidate className="sub-form" aria-label="Submit your project">
            <TextField {...p('repositoryUrl')} label="Repository link" type="url" inputMode="url" autoComplete="off" placeholder="https://github.com/you/project" required={g.requiresRepository} optional={!g.requiresRepository} />
            <TextField {...p('liveUrl')} label="Demo link" type="url" inputMode="url" autoComplete="off" placeholder="https://" optional={!g.requiresLiveUrl} required={g.requiresLiveUrl} />
            <TextAreaField {...p('description')} label="What did you do?" rows={4} maxLength={3000} />
            <TextAreaField {...p('submissionNotes')} label="Note for the reviewer" rows={2} maxLength={1000} optional />
            {formError && <p className="field__error" role="alert">{formError}</p>}
            <div className="sub-form__actions"><Button type="submit" icon={Send} disabled={busy} aria-busy={busy}>{busy ? '…' : submission.resubmitting ? 'Resubmit' : 'Submit'}</Button></div>
          </form>
        ) : <p className="sub-locked" role="status">{submission.blockedReason}</p>}
      </section>
      <Evaluations evaluations={evaluations} />
      <SubmissionHistory submissions={submissions} reviews={reviews} />
    </>
  );
}
