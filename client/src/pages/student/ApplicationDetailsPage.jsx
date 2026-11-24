import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Clock, Hash, RefreshCw, Briefcase } from 'lucide-react';
import StatusBadge from '../../components/applications/StatusBadge';
import ReviewList from '../../components/applications/ReviewList';
import ProgressTimeline, { TimelineSkeleton } from '../../components/progress/ProgressTimeline';
import { LoadError } from '../../components/dashboard/PageStates';
import Button from '../../components/ui/Button';
import { useApplicationDetails } from '../../hooks/useApplications';
import { useInternship } from '../../hooks/useInternships';
import { useSessionExpiry } from '../../hooks/useSessionExpiry';
import { usePageMeta } from '../../hooks/usePageMeta';
import { domainBySlug } from '../../config/site';
import { statusMeta } from '../../config/applications';
import { studentRoutes } from '../../config/dashboard';
import { formatDuration } from '../../lib/duration';
import { fmtDateTime } from '../../lib/format';
import { detailPath } from '../../lib/applyLinks';

export default function ApplicationDetailsPage() {
  const { id } = useParams();
  const { status, data, error, reload } = useApplicationDetails(id);
  const a = data?.application;
  const { data: live } = useInternship(a?.internship.id); // richer description from the listing
  usePageMeta(a ? `Application ${a.id}` : 'Application');
  const expired = useSessionExpiry(status, error);
  if (expired) return null;

  const back = <Link className="back-link" to={studentRoutes.applications}><ArrowLeft size={16} aria-hidden="true" /> My Applications</Link>;
  if (status === 'loading') {
    return <div className="track">{back}<div className="card track__card" aria-hidden="true"><i className="sk sk--title" /><i className="sk sk--line" /><i className="sk sk--line sk--short" /></div><div className="card track__card"><TimelineSkeleton /></div></div>;
  }
  if (status === 'error' && error?.status !== 404) return <div className="track">{back}<LoadError title="We couldn’t load this application" error={error} onRetry={reload} /></div>;
  if (!a) {
    // Missing and someone-else's look identical (404) on purpose.
    return (
      <div className="track">
        {back}
        <div className="empty" role="status"><h3>Application not found</h3><p className="text-muted">We couldn’t find that application on your account.</p><Button to={studentRoutes.applications}>View my applications</Button></div>
      </div>
    );
  }

  const cat = domainBySlug(a.internship.category);
  const meta = statusMeta(a.status);
  const hasInternship = data.timeline.some((m) => m.key === 'activated' && m.state === 'completed');
  return (
    <div className="track">
      {back}
      <header className="appd__head card">
        <div className="appd__title">
          <p className="appd__cat">{cat?.title ?? a.internship.category}</p>
          <h1>{a.internship.title}</h1>
          {live?.description && <p className="text-muted">{live.description}</p>}
          <p><Link className="link" to={detailPath(a.internship.id)}>View internship details</Link></p>
        </div>
        <div className={`appd__status appd__status--${meta.tone}`}>
          <StatusBadge status={a.status} />
          <p>{meta.help}</p>
          {hasInternship && <Link className="btn btn--secondary btn--sm" to={studentRoutes.internship}><Briefcase size={16} aria-hidden="true" />Go to My Internship</Link>}
        </div>
      </header>

      <dl className="appd__facts card">
        <div><dt><Hash size={14} aria-hidden="true" />Application ID</dt><dd className="mono">{a.id}</dd></div>
        <div><dt><Hash size={14} aria-hidden="true" />Internship ID</dt><dd className="mono">{a.internship.id}</dd></div>
        <div><dt><Clock size={14} aria-hidden="true" />Duration</dt><dd>{formatDuration(a.internship.durationDays)}</dd></div>
        <div><dt><CalendarDays size={14} aria-hidden="true" />Submitted</dt><dd>{fmtDateTime(a.submittedAt)}</dd></div>
        <div><dt><RefreshCw size={14} aria-hidden="true" />Last updated</dt><dd>{fmtDateTime(a.updatedAt)}</dd></div>
      </dl>

      <section className="card track__card" aria-labelledby="prog-h">
        <h2 id="prog-h" className="track__h">Progress</h2>
        <ProgressTimeline milestones={data.timeline} label="Application progress" />
      </section>

      <div className="card appd__responses track__card">
        <h2 className="track__h">What you submitted</h2>
        <ReviewList responses={a.responses} />
      </div>
    </div>
  );
}
