import { useState } from 'react';
import { Github, ExternalLink, RefreshCw, GitCommitHorizontal, FileCode2, FlaskConical, StickyNote, Info } from 'lucide-react';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { fmtDateTime } from '../../lib/format';
import * as api from '../../services/adminManagementService';
import VerificationBadge from '../tasks/VerificationBadge';

// Stage 09C Part 2A — GitHub evidence for ONE project, inside the existing review page. Everything is rendered as TEXT: the README is untrusted and is
// never turned into HTML (React escapes it; there is no dangerouslySetInnerHTML anywhere). Counts are evidence, not a decision rule.
export default function GithubEvidence({ id, github, onChange }) {
  const toast = useToast(); const [busy, setBusy] = useState(false); const [note, setNote] = useState(''); const [noteError, setNoteError] = useState('');
  const g = github; if (!g) return null;
  const repo = g.repository; const e = g.evidence;
  const refresh = async () => { setBusy(true); try { onChange({ github: await api.refreshProjectEvidence(id) }); toast.success('Repository evidence refreshed.'); } catch (err) { toast.error(err?.message || 'Could not refresh the evidence.'); } finally { setBusy(false); } };
  const addNote = async (ev) => {
    ev.preventDefault(); setNoteError('');
    try { const r = await api.addProjectNote(id, note); onChange({ github: { ...g, notes: r.notes } }); setNote(''); toast.success('Note added.'); }
    catch (err) { setNoteError(err?.data?.error?.fields?.note || err?.message || 'Could not add the note.'); }
  };
  return (
    <section className="card pe-panel gh-evidence" aria-labelledby="gh-h">
      <h2 id="gh-h"><Github size={18} aria-hidden="true" />GitHub evidence {repo && <VerificationBadge verification={g.verification} />}</h2>
      <p className="sub-notice" role="note"><Info size={18} aria-hidden="true" /><span>{g.notice} Repository verification is not approval.</span></p>
      {!g.configured && <p className="sub-locked" role="status">GitHub integration is not set up, so evidence cannot be collected. The student’s typed link is shown below, unverified.</p>}
      {!repo ? <p className="text-muted">No repository is linked to this task.</p> : <>
        <div className="pe-links"><a className="btn btn--secondary" href={repo.openUrl ?? undefined} target="_blank" rel="noopener noreferrer"><ExternalLink size={18} aria-hidden="true" />Open on GitHub<span className="sr-only"> (opens in a new tab)</span></a>
          <Button variant="secondary" icon={RefreshCw} disabled={busy || !g.configured} onClick={refresh}>{busy ? 'Refreshing…' : 'Refresh evidence'}</Button></div>
        <dl className="sub-facts"><dt>Repository</dt><dd>{repo.owner}/{repo.name}</dd><dt>Owner</dt><dd>{repo.owner}</dd><dt>Visibility</dt><dd>{repo.visibility ?? 'Unknown'}</dd>
          {e && <><dt>Created</dt><dd>{fmtDateTime(e.metadata.createdAt)}</dd><dt>Last updated</dt><dd>{fmtDateTime(e.metadata.updatedAt)}</dd></>}
          <dt>Last inspected</dt><dd>{g.lastInspection ? `${fmtDateTime(g.lastInspection.inspectedAt)}${g.lastInspection.status === 'ok' ? '' : ' (that attempt failed)'}` : 'Never'}</dd>
          {g.submittedUrlMatchesLinked === false && <><dt>Warning</dt><dd className="repo-msg repo-msg--red">The submitted link differs from the linked repository.</dd></>}</dl>
        {g.lastInspection && g.lastInspection.status !== 'ok' && <p className="repo-msg repo-msg--amber" role="status">The last refresh did not succeed{e ? '; the older evidence below is still shown' : ''}. Try again in a few minutes.</p>}
        {!e ? <p className="text-muted">No repository evidence has been collected yet.</p> : <>
          <h3><FileCode2 size={16} aria-hidden="true" />Languages</h3>
          <p>{e.languages.length ? e.languages.map((l) => `${l.name} ${l.percent}%`).join(' · ') : 'None detected'}</p>
          <h3><FlaskConical size={16} aria-hidden="true" />Structure and tests</h3>
          <p>{e.files.total} files{e.files.truncated ? ' (list truncated)' : ''} · test files: <strong>{e.files.hasTestFiles ? `present (${e.files.testFiles})` : 'none found'}</strong> · branches: {e.branches.names.join(', ') || '—'}</p>
          <details><summary>File structure</summary><pre className="gh-pre" tabIndex={0}>{e.files.paths.join('\n')}</pre></details>
          <h3><GitCommitHorizontal size={16} aria-hidden="true" />Recent commits <span className="text-muted">(newest {e.commits.shown}; not a total)</span></h3>
          {e.commits.latest.length ? <ol className="gh-commits">{e.commits.latest.map((c) => <li key={c.sha}><code>{c.sha}</code> <span>{c.message || '(no message)'}</span><span className="text-muted"> · {c.authorLogin ?? 'unknown'} · {c.authoredAt ? fmtDateTime(c.authoredAt) : ''}</span></li>)}</ol> : <p className="text-muted">No commits found.</p>}
          <details><summary>README preview{e.readme.truncated ? ' (shortened)' : ''}</summary>{e.readme.present ? <pre className="gh-pre" tabIndex={0}>{e.readme.text}</pre> : <p className="text-muted">No README found.</p>}</details>
        </>}
      </>}
      <h3><StickyNote size={16} aria-hidden="true" />Internal review notes <span className="text-muted">(students never see these)</span></h3>
      {g.notes.length ? <ul className="gh-notes">{g.notes.map((n) => <li key={n.id}><p className="pe-pre">{n.note}</p><span className="text-muted">{n.adminName} · {fmtDateTime(n.createdAt)}{n.submissionVersion ? ` · v${n.submissionVersion}` : ''}</span></li>)}</ul> : <p className="text-muted">No notes yet.</p>}
      <form onSubmit={addNote} className="gh-noteform"><label htmlFor="gh-note" className="sr-only">Add an internal note</label>
        <textarea id="gh-note" className="pe-textarea" rows={3} maxLength={2000} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Add an internal note for other reviewers" aria-invalid={noteError ? 'true' : undefined} />
        {noteError && <p className="eval-err" role="alert">{noteError}</p>}<Button type="submit" variant="secondary" disabled={note.trim().length < 3}>Add note</Button></form>
    </section>
  );
}
