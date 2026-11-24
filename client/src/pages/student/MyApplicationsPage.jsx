import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardList, SearchX } from 'lucide-react';
import ApplicationsTable, { ApplicationsSkeleton } from '../../components/applications/ApplicationsTable';
import Pagination from '../../components/applications/Pagination';
import { LoadError } from '../../components/dashboard/PageStates';
import Button from '../../components/ui/Button';
import { useMyApplications } from '../../hooks/useApplications';
import { useSessionExpiry } from '../../hooks/useSessionExpiry';
import { usePageMeta } from '../../hooks/usePageMeta';
import { APPLICATION_FILTERS } from '../../config/internshipStatus';

const PAGE_SIZE = 10;

export default function MyApplicationsPage() {
  usePageMeta('My Applications');
  // Filter and page live in the URL, so refresh, back and shared links keep the same view.
  const [params, setParams] = useSearchParams();
  const status = APPLICATION_FILTERS.includes(params.get('status')) ? params.get('status') : 'All';
  const page = Math.max(1, Number.parseInt(params.get('page'), 10) || 1);

  const { status: load, data, error, reload } = useMyApplications({ status, page, pageSize: PAGE_SIZE });
  const expired = useSessionExpiry(load, error);

  const update = (next, replace = false) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v === null || v === undefined || v === 'All' || v === 1) p.delete(k); else p.set(k, String(v)); }
    setParams(p, { replace });
  };
  // The server clamps a page that is past the end (e.g. after statuses change); keep the URL in step with it.
  const serverPage = data?.pagination.page;
  useEffect(() => { if (serverPage && serverPage !== page) update({ page: serverPage }, true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [serverPage]);

  if (expired) return null;
  const first = load === 'loading' && !data;
  const refreshing = load === 'loading' && Boolean(data);
  const counts = data?.counts;
  const none = data && counts.All === 0;

  return (
    <div className="track">
      <header className="track__head">
        <div>
          <h1>My Applications</h1>
          <p className="text-muted">Every internship you’ve applied for. Only ELVORA administrators can change an application’s status.</p>
        </div>
        <Button to="/internships" variant="secondary" size="sm">Explore internships</Button>
      </header>

      {load === 'error' ? (
        <LoadError title="We couldn’t load your applications" error={error} onRetry={reload} />
      ) : none ? (
        <div className="empty" role="status">
          <span className="empty__icon"><ClipboardList size={28} aria-hidden="true" /></span>
          <h3>No applications yet</h3>
          <p className="text-muted">When you apply for an internship, it will show up here with its status.</p>
          <Button to="/internships">Explore internships</Button>
        </div>
      ) : (
        <>
          <div className="afilter" role="group" aria-label="Filter applications by status">
            {APPLICATION_FILTERS.map((f) => (
              <button key={f} type="button" className={`chip chip--btn afilter__btn ${status === f ? 'is-on' : ''}`} aria-pressed={status === f}
                onClick={() => update({ status: f, page: 1 })}>
                {f}{counts && <span className="afilter__n" aria-label={`, ${counts[f]} applications`}>{counts[f]}</span>}
              </button>
            ))}
          </div>

          <div className={refreshing ? 'is-refreshing' : undefined} aria-busy={load === 'loading'}>
            {first ? <ApplicationsSkeleton /> : data.applications.length === 0 ? (
              <div className="empty" role="status">
                <span className="empty__icon"><SearchX size={28} aria-hidden="true" /></span>
                <h3>No {status} applications</h3>
                <p className="text-muted">You don’t have any applications with this status.</p>
                <Button onClick={() => update({ status: 'All', page: 1 })}>Show all applications</Button>
              </div>
            ) : (
              <>
                <ApplicationsTable items={data.applications} />
                <Pagination {...data.pagination} onChange={(p) => update({ page: p })} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
