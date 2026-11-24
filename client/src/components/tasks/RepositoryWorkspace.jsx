import { useCallback, useEffect, useState } from 'react';
import { Github, ExternalLink, GitBranchPlus, Link2, RefreshCw, ShieldCheck, Unlink, Info } from 'lucide-react';
import Button from '../ui/Button';
import { TextField } from '../forms/Field';
import { useToast } from '../ui/Toast';
import { githubRepoError } from '../../lib/github';
import { fmtDateTime } from '../../lib/format';
import * as api from '../../services/studentService';
import VerificationBadge from './VerificationBadge';

// Stage 09C Part 2A — the repository card inside the task workspace. Everything shown (state, wording, buttons that make sense) comes from the server.
// Repository verification is NOT approval; the wording says so. GitHub failures are shown as plain sentences, never as raw API errors.
const friendly = (e) => (e?.status === 0 ? e.message : e?.status === 429 ? 'Please wait a little before trying again.' : e?.message || 'That did not work. Please try again.');

export default function RepositoryWorkspace({ taskId, canChange, onLinked }) {
  const toast = useToast();
  const [d, setD] = useState(null); const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(''); const [url, setUrl] = useState(''); const [urlError, setUrlError] = useState(''); const [replacing, setReplacing] = useState(false);
  const load = useCallback(() => api.getTaskRepository(taskId).then((r) => { setD(r); setLoadError(false); }).catch(() => setLoadError(true)), [taskId]);
  useEffect(() => { load(); }, [load]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); toast.success(ok); await load(); onLinked?.(); } catch (e) { toast.error(friendly(e)); await load(); } finally { setBusy(''); }
  };
  const link = async (ev) => {
    ev.preventDefault(); const err = githubRepoError(url, { required: true }); if (err) { setUrlError(err); return; }
    setBusy('link'); setUrlError('');
    try { await api.linkTaskRepository(taskId, url.trim()); toast.success('Repository linked.'); setUrl(''); setReplacing(false); await load(); onLinked?.(); }
    catch (e) { setUrlError(e?.data?.error?.fields?.repositoryUrl || friendly(e)); } finally { setBusy(''); }
  };

  if (loadError) return <p className="sub-locked" role="status">We couldn’t load your repository details. <button type="button" className="linklike" onClick={load}>Try again</button></p>;
  if (!d) return <div className="card repo-card" aria-hidden="true"><i className="sk sk--line" /><i className="sk sk--line" /></div>;
  const ready = d.integration?.state === 'ready'; const repo = d.repository; const v = repo?.verification; const el = d.eligibility;
  const showForm = canChange && el.eligible && (!repo || replacing) && repo?.source !== 'organization';

  return (
    <div className="repo-card" aria-live="polite">
      <h3><Github size={18} aria-hidden="true" />Your repository <VerificationBadge verification={v ?? { state: 'not_linked', label: 'Not linked', tone: 'slate' }} /></h3>
      {!ready && <p className="sub-notice" role="note"><Info size={18} aria-hidden="true" /><span>GitHub integration is not set up yet, so we can’t verify repositories right now. You can still link a repository and submit; it will be marked “pending verification”.</span></p>}
      {repo ? (
        <>
          <dl className="sub-facts"><dt>Repository</dt><dd><a href={repo.url} target="_blank" rel="noopener noreferrer">{repo.owner}/{repo.name} <ExternalLink size={13} aria-hidden="true" /><span className="sr-only"> (opens GitHub in a new tab)</span></a></dd>
            {repo.visibility && <><dt>Visibility</dt><dd>{repo.visibility}</dd></>}
            <dt>Last checked</dt><dd>{repo.lastInspection ? fmtDateTime(repo.lastInspection.inspectedAt) : 'Not checked yet'}</dd></dl>
          <p className={`repo-msg repo-msg--${v.tone}`} role="status">{v.message}</p>
          {repo.state === 'failed' && repo.setupMessage && <p className="repo-msg repo-msg--amber">{repo.setupMessage}</p>}
          <p className="text-muted">{v.academicNote}</p>
          <div className="repo-actions">
            {ready && <Button variant="secondary" icon={ShieldCheck} disabled={!!busy} onClick={() => run('verify', () => api.verifyTaskRepository(taskId), 'Repository checked.')}>{busy === 'verify' ? 'Checking…' : 'Check ownership'}</Button>}
            {ready && <Button variant="secondary" icon={RefreshCw} disabled={!!busy} onClick={() => run('inspect', () => api.refreshTaskEvidence(taskId), 'Repository evidence refreshed.')}>{busy === 'inspect' ? 'Refreshing…' : 'Refresh evidence'}</Button>}
            {canChange && repo.source !== 'organization' && el.eligible && <Button variant="secondary" icon={Link2} disabled={!!busy} onClick={() => setReplacing((x) => !x)}>{replacing ? 'Cancel' : 'Replace link'}</Button>}
            {canChange && repo.source !== 'organization' && el.eligible && <Button variant="secondary" icon={Unlink} disabled={!!busy} onClick={() => window.confirm('Unlink this repository from the task?') && run('unlink', () => api.unlinkTaskRepository(taskId), 'Repository unlinked.')}>Unlink</Button>}
          </div>
        </>
      ) : <p className="text-muted">{el.eligible ? 'No repository is linked yet. Create one with ELVORA or link a repository you already own.' : el.reason}</p>}
      {canChange && el.eligible && !repo && ready && d.integration.canCreateRepositories && d.account?.connected && (
        <div className="repo-actions"><Button icon={GitBranchPlus} disabled={!!busy} onClick={() => run('create', () => api.createTaskRepository(taskId), 'Repository created. Check your email for the GitHub invitation.')}>{busy === 'create' ? 'Creating…' : 'Create repository'}</Button></div>)}
      {ready && !d.account?.connected && canChange && <p className="text-muted">Connect your GitHub account from your dashboard to verify ownership and create repositories.</p>}
      {showForm && <form onSubmit={link} noValidate className="repo-link" aria-label="Link an existing repository">
        <TextField name="repositoryUrl" value={url} onChange={(_n, val) => { setUrl(val); setUrlError(''); }} error={urlError} label="Link an existing repository" type="url" inputMode="url" autoComplete="off" placeholder="https://github.com/your-username/your-repository" />
        <Button type="submit" variant="secondary" icon={Link2} disabled={!!busy}>{busy === 'link' ? 'Linking…' : repo ? 'Replace repository' : 'Link repository'}</Button></form>}
    </div>
  );
}
