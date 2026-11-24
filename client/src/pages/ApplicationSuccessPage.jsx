import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LayoutDashboard, FileText } from 'lucide-react';
import StatusBadge from '../components/applications/StatusBadge';
import PageLoader from '../components/PageLoader';
import Button from '../components/ui/Button';
import { ErrorState } from '../components/internships/ListingStates';
import { useApplication } from '../hooks/useApplications';
import { usePageMeta } from '../hooks/usePageMeta';
import { formatDuration } from '../lib/duration';
import { fmtDateTime } from '../lib/format';
import { applicationPath } from '../lib/applyLinks';
import { routes } from '../config/site';

// Shown after the server confirms the application is stored. It loads the saved record from the API (not from
// form state), so what you see here is exactly what was written to the database, and a refresh still works.
export default function ApplicationSuccessPage() {
  const { id } = useParams();
  const { status, data: a, error, reload } = useApplication(id);
  const headingRef = useRef(null);
  usePageMeta('Application submitted');
  useEffect(() => { if (status === 'ready') headingRef.current?.focus({ preventScroll: true }); }, [status]);

  if (status === 'loading') return <PageLoader />;
  if (status === 'error' && error?.status !== 404) return <div className="container section app-scope"><ErrorState onRetry={reload} /></div>;
  if (!a) return (
    <section className="section container container--narrow state-box app-scope">
      <h1>Application not found</h1>
      <p className="text-muted">We couldn’t find that application on your account.</p>
      <Button to={routes.applications}>View my applications</Button>
    </section>
  );

  return (
    <section className="app-scope success container">
      <div className="success__card card">
        <div className="success__check" aria-hidden="true">
          <svg viewBox="0 0 52 52" fill="none"><circle className="success__ring" cx="26" cy="26" r="23" /><path className="success__tick" d="M15 27l8 8 14-16" /></svg>
        </div>
        <h1 className="success__title" ref={headingRef} tabIndex={-1}>Your application has been submitted successfully!</h1>
        <p className="text-muted success__lead">Keep your application ID handy if you need to refer to this application.</p>

        <dl className="success__facts">
          <div className="success__fact success__fact--id"><dt>Application ID</dt><dd className="mono">{a.id}</dd></div>
          <div className="success__fact"><dt>Student name</dt><dd>{a.responses.fullName}</dd></div>
          <div className="success__fact"><dt>Internship</dt><dd>{a.internship.title}</dd></div>
          <div className="success__fact"><dt>Duration</dt><dd>{formatDuration(a.internship.durationDays)}</dd></div>
          <div className="success__fact"><dt>Submitted on</dt><dd>{fmtDateTime(a.submittedAt)}</dd></div>
          <div className="success__fact"><dt>Status</dt><dd><StatusBadge status={a.status} /></dd></div>
        </dl>

        <div className="success__actions">
          <Button to={routes.dashboard} icon={LayoutDashboard}>Go to Student Dashboard</Button>
          <Link className="btn btn--secondary" to={applicationPath(a.id)}><FileText size={18} aria-hidden="true" />View application</Link>
        </div>
      </div>
    </section>
  );
}
