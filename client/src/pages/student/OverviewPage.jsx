import { useEffect } from 'react';
import { ClipboardList, CheckCircle2, Briefcase, Award, TriangleAlert, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import StatCard from '../../components/dashboard/StatCard';
import RecentApplications, { RecentApplicationsSkeleton } from '../../components/dashboard/RecentApplications';
import Button from '../../components/ui/Button';
import { useStudentDashboard } from '../../hooks/useStudentDashboard';
import { useAuth } from '../../auth/AuthContext';
import { usePageMeta } from '../../hooks/usePageMeta';
import { firstName } from '../../lib/names';
import { studentRoutes } from '../../config/dashboard';

export default function OverviewPage() {
  usePageMeta('Student dashboard');
  const { user, setUser } = useAuth();
  const { status, data, error, reload } = useStudentDashboard();
  const loading = status === 'loading';

  // Session expired while the page was open: clearing the user makes the route guard send them to login.
  const expired = status === 'error' && error?.status === 401;
  useEffect(() => { if (expired) setUser(null); }, [expired, setUser]);
  if (expired) return null;

  const stats = data?.stats;
  const tracked = stats?.internshipsTracked;
  const pct = user?.profileCompletion?.percent;

  return (
    <div className="overview">
      <section className="overview__hero">
        <div>
          <h1>Hello, {firstName(user?.fullName)} 👋</h1>
          <p>Here’s a snapshot of your internship journey with ELVORA.</p>
        </div>
        {typeof pct === 'number' && pct < 100 && (
          <Link className="overview__nudge" to={studentRoutes.profile}>
            <span>Profile {pct}% complete</span>
            <span className="overview__bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
            <span className="overview__nudge-cta">Complete it <ArrowRight size={14} aria-hidden="true" /></span>
          </Link>
        )}
      </section>

      {status === 'error' ? (
        <div className="empty" role="alert">
          <span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span>
          <h3>We couldn’t load your dashboard</h3>
          <p className="text-muted">{error?.status === 0 ? error.message : 'Something went wrong on our side. Please try again.'}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      ) : (
        <>
          <section aria-label="Statistics" className="stats" aria-busy={loading}>
            <StatCard loading={loading} icon={ClipboardList} label="Total Applications" value={stats?.totalApplications}
              hint={stats?.totalApplications === 0 ? 'You haven’t applied yet' : undefined} />
            <StatCard loading={loading} icon={CheckCircle2} tone="teal" label="Approved Applications" value={stats?.approvedApplications}
              hint={stats && stats.totalApplications > 0 && stats.approvedApplications === 0 ? 'None approved yet' : undefined} />
            <StatCard loading={loading} icon={Briefcase} tone="indigo" label="Active Internships" value={stats?.activeInternships}
              hint={tracked === false ? 'Appears once internship progress tracking is live' : undefined} />
            <StatCard loading={loading} icon={Award} tone="amber" label="Completed Internships" value={stats?.completedInternships}
              hint={tracked === false ? 'Appears once internship progress tracking is live' : undefined} />
          </section>

          <section className="recent card" aria-labelledby="recent-h">
            <div className="recent__head">
              <h2 id="recent-h">Recent Applications</h2>
              {!loading && data.recentApplications.length > 0 && <Link className="recent__link" to={studentRoutes.applications}>View all</Link>}
            </div>
            {loading ? <RecentApplicationsSkeleton /> : <RecentApplications items={data.recentApplications} />}
          </section>
        </>
      )}
    </div>
  );
}
