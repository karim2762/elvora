import { useEffect, useState } from 'react';
import { ScrollText, TriangleAlert, RefreshCw } from 'lucide-react';
import Button from '../../components/ui/Button';
import Pagination from '../../components/applications/Pagination';
import { useAdminList } from '../../hooks/useAdminList';
import { usePageMeta } from '../../hooks/usePageMeta';
import { fmtDateTime } from '../../lib/format';
import * as api from '../../services/adminManagementService';

const sessionEnded = (e) => e?.status === 401 || e?.status === 403;
const label = (a) => a.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Read-only. There is no control here (or API route) that creates, edits or deletes an entry.
export default function AdminAuditPage() {
  usePageMeta('Audit Logs · Admin');
  const [f, setF] = useState({ action: 'All', result: 'All', adminId: 'All', from: '', to: '' });
  const [page, setPage] = useState(1);
  const set = (k, v) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const { loading, error, data, reload } = useAdminList(api.listAuditLogs, { ...f, page, pageSize: 25 });
  const rows = data?.events ?? [];
  const [opts, setOpts] = useState(null);
  useEffect(() => { if (data?.filters && !opts) setOpts(data.filters); }, [data, opts]);
  const filtered = Object.entries(f).some(([k, v]) => v && v !== 'All');
  const who = (e) => `${e.adminName ?? '—'}${e.adminId ? '' : ''}`;

  return (
    <div className="adm-page">
      <header className="adm-page__head"><div><h1>Audit Logs</h1><p className="text-muted">A permanent, read-only record of administrator actions. Entries can’t be edited or deleted.</p></div></header>
      <div className="adm-tools card">
        <select className="adm-select" value={f.action} onChange={(e) => set('action', e.target.value)} aria-label="Filter by action">
          <option value="All">All actions</option>{(opts?.actions ?? []).map((a) => <option key={a} value={a}>{label(a)}</option>)}</select>
        <select className="adm-select" value={f.adminId} onChange={(e) => set('adminId', e.target.value)} aria-label="Filter by administrator">
          <option value="All">All administrators</option>{(opts?.admins ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select className="adm-select" value={f.result} onChange={(e) => set('result', e.target.value)} aria-label="Filter by result">
          <option value="All">Any result</option><option value="success">Success</option><option value="failure">Failure</option></select>
        <label className="adm-datefield">From <input type="date" value={f.from} max={f.to || undefined} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="adm-datefield">To <input type="date" value={f.to} min={f.from || undefined} onChange={(e) => set('to', e.target.value)} /></label>
      </div>
      {error && !data ? (
        <div className="empty" role="alert"><span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span>
          <h3>Couldn’t load the audit log</h3>
          <p className="text-muted">{sessionEnded(error) ? 'Your administrator session has ended. Sign in again.' : 'Something went wrong. Please try again.'}</p>
          {sessionEnded(error) ? <Button to="/admin/login">Sign in</Button> : <Button icon={RefreshCw} onClick={reload}>Try again</Button>}</div>
      ) : loading && !data ? (
        <div className="card asks" aria-hidden="true">{[0, 1, 2, 3].map((n) => <i key={n} className="sk sk--line" />)}</div>
      ) : rows.length === 0 ? (
        <div className="empty" role="status"><span className="empty__icon"><ScrollText size={28} aria-hidden="true" /></span>
          <h3>{filtered ? 'No events match' : 'No events recorded yet'}</h3><p className="text-muted">{filtered ? 'Try different filters.' : 'Administrator actions appear here as they happen.'}</p></div>
      ) : (
        <div className={loading ? 'adm-loading' : ''} aria-busy={loading}>
          <div className="atable card"><table>
            <caption className="sr-only">Audit events</caption>
            <thead><tr><th scope="col">Event</th><th scope="col">Time</th><th scope="col">Administrator</th><th scope="col">Action</th><th scope="col">Related record</th><th scope="col">Result</th><th scope="col">Notes</th></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}><td className="mono">{e.id}</td><td>{fmtDateTime(e.timestamp)}</td><td>{who(e)}</td><td>{label(e.action)}</td>
                <td className="mono">{e.relatedId ? `${e.relatedType ?? ''} ${e.relatedId}`.trim() : '—'}</td>
                <td><span className={`status ${e.result === 'success' ? 'status--teal' : 'status--red'}`}>{e.result === 'success' ? 'Success' : 'Failure'}</span></td><td>{e.reason || '—'}</td></tr>))}</tbody>
          </table></div>
          <ul className="acards">{rows.map((e) => (
            <li key={e.id} className="acards__item card">
              <div className="acards__top"><div><p className="acards__cat mono">{e.id}</p><h2 className="acards__title">{label(e.action)}</h2></div>
                <span className={`status ${e.result === 'success' ? 'status--teal' : 'status--red'}`}>{e.result === 'success' ? 'Success' : 'Failure'}</span></div>
              <dl className="acards__facts"><div><dt>Time</dt><dd>{fmtDateTime(e.timestamp)}</dd></div><div><dt>Administrator</dt><dd>{who(e)}</dd></div>
                <div><dt>Record</dt><dd className="mono">{e.relatedId || '—'}</dd></div><div><dt>Notes</dt><dd>{e.reason || '—'}</dd></div></dl>
            </li>))}</ul>
          <Pagination {...data.pagination} onChange={setPage} />
        </div>
      )}
    </div>
  );
}
