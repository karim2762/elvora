import { useCallback, useEffect, useState } from 'react';
import { Github } from 'lucide-react';
import Button from '../ui/Button';
import { getGithubStatus, startGithubConnect, disconnectGithub } from '../../services/studentService';

// Stage 09C Part 1 — the student's GitHub connection. Identity is proven by GitHub's own sign-in, never by a typed username.
const REASONS = {
  GITHUB_ACCOUNT_IN_USE: 'That GitHub account is already connected to another ELVORA account.',
  GITHUB_AUTH_DENIED: 'GitHub access was not approved, so nothing was connected.',
  GITHUB_STATE_INVALID: 'That GitHub sign-in link expired. Please start again.',
  GITHUB_ACCOUNT_TYPE: 'Only personal GitHub accounts can be connected.',
  GITHUB_NOT_CONFIGURED: 'GitHub sign-in is not set up yet. Please contact ELVORA support.',
};

export default function GithubCard() {
  const [state, setState] = useState({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('github') === 'connected') return { ok: true, text: 'GitHub account connected.' };
    if (q.get('github') === 'error') return { ok: false, text: REASONS[q.get('reason')] ?? 'GitHub could not be connected. Please try again.' };
    return null;
  });
  const load = useCallback(() => getGithubStatus().then((data) => setState({ status: 'ready', data })).catch(() => setState({ status: 'error' })), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (notice) window.history.replaceState(null, '', window.location.pathname); }, [notice]);

  const connect = async () => { setBusy(true); try { window.location.assign(await startGithubConnect()); } catch (e) { setNotice({ ok: false, text: e?.message || 'GitHub could not be started.' }); setBusy(false); } };
  const disconnect = async () => {
    if (!window.confirm('Disconnect your GitHub account from ELVORA?')) return;
    setBusy(true);
    try { await disconnectGithub(); setNotice({ ok: true, text: 'GitHub account disconnected.' }); await load(); } catch (e) { setNotice({ ok: false, text: e?.message || 'Could not disconnect. Please try again.' }); }
    setBusy(false);
  };

  const data = state.data; const account = data?.account; const setupRequired = data?.integration?.canConnectAccount === false;
  return (
    <section className="card github-card" id="github" aria-labelledby="github-h" aria-busy={state.status === 'loading'}>
      <h2 id="github-h"><Github size={18} aria-hidden="true" /> GitHub</h2>
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={notice.ok ? 'text-muted' : 'github-card__error'}>{notice.text}</p>}
      {state.status === 'loading' && <p className="text-muted">Checking your GitHub connection…</p>}
      {state.status === 'error' && <p className="text-muted" role="alert">We couldn’t load your GitHub status. Please refresh the page.</p>}
      {state.status === 'ready' && setupRequired && <p className="text-muted">GitHub connection is not set up yet. You can keep working; ELVORA will announce when it is ready.</p>}
      {state.status === 'ready' && !setupRequired && account?.connected && (
        <>
          <p><strong>@{account.login}</strong> · Connected · Identity verified by GitHub</p>
          <Button variant="secondary" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
        </>
      )}
      {state.status === 'ready' && !setupRequired && !account?.connected && (
        <>
          <p className="text-muted">{account?.status === 'authorization_revoked' ? 'Your GitHub authorization was revoked. Reconnect to continue.' : 'Connect your GitHub account to get a project repository. ELVORA never asks for your GitHub password or tokens.'}</p>
          <Button onClick={connect} disabled={busy}>{busy ? 'Opening GitHub…' : 'Connect GitHub'}</Button>
        </>
      )}
    </section>
  );
}
