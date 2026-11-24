import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Users, Briefcase, ClipboardList, Hourglass, CheckCircle2, PlayCircle, Award, FileCheck2, TriangleAlert, RefreshCw, ArrowRight, UserPlus,
  FilePlus2, FileText, Activity, PlusCircle, Clock } from 'lucide-react';
import StatCard from '../../components/dashboard/StatCard';
import Button from '../../components/ui/Button';
import { useAdminDashboard } from '../../hooks/useAdminDashboard';
import { useAuth } from '../../auth/AuthContext';
import { usePageMeta } from '../../hooks/usePageMeta';
import { firstName } from '../../lib/names';
import { fmtDateTime } from '../../lib/format';
import { adminRoutes } from '../../config/admin';

const ICON = {
  student_registered: UserPlus, application_submitted: FilePlus2, application_status: ClipboardList, internship_created: PlusCircle,
  internship_activated: PlayCircle, internship_completed: Award, offer_letter_issued: FileText, certificate_issued: FileCheck2,
};
// Only existing routes: the console at /admin (opened on the right tab) and the Students page of this dashboard.
const ACTIONS = [
  { label: 'Manage Internships', text: 'Create, publish and edit internship listings.', to: adminRoutes.internships, icon: PlusCircle },
  { label: 'View Pending Applications', text: 'Review newly submitted applications.', to: `${adminRoutes.applications}?status=Submitted`, icon: Hourglass },
  { label: 'View Students', text: 'Student management arrives in Stage 07B.', to: adminRoutes.students, icon: Users, soon: true },
  { label: 'Manage Documents', text: 'Certificates, approvals and automation.', to: `${adminRoutes.console}?tab=certificates`, icon: FileText },
];
const STATUS_ORDER = ['Submitted', 'Under Review', 'Approved', 'Rejected', 'Cancelled'];

function ActivitySkeleton() {
  return (
    <ul className="recent__list" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => <li key={i} className="recent__item recent__item--sk"><i className="sk sk--line" /><i className="sk sk--line sk--short" /></li>)}
    </ul>
  );
}

function Activity_({ items }) {
  if (!items.length) {
    return (
      <div className="recent__empty" role="status">
        <span className="empty__icon"><Activity size={28} aria-hidden="true" /></span>
        <h3>No activity yet</h3>
        <p className="text-muted">Registrations, applications, internships and issued documents will appear here as they happen.</p>
      </div>
    );
  }
  return (
    <ol className="adm-activity">
      {items.map((e) => {
        const Icon = ICON[e.type] ?? Activity;
        return (
          <li key={`${e.type}-${e.reference}-${e.at}`} className="adm-activity__item">
            <span className="adm-activity__icon"><Icon size={18} aria-hidden="true" /></span>
            <div className="adm-activity__body">
              <p className="adm-activity__text">{e.description}</p>
              <p className="adm-activity__meta"><time dateTime={e.at}>{fmtDateTime(e.at)}</time><span className="mono">{e.reference}</span></p>
            </div>
            {e.link && <Link className="adm-activity__go" to={e.link} aria-label={`Open ${e.reference} in the admin console`}>Open <ArrowRight size={14} aria-hidden="true" /></Link>}
          </li>
        );
      })}
    </ol>
  );
}

export default function AdminOverviewPage() {
  usePageMeta('Admin dashboard');
  const { user, setUser } = useAuth();
  const { status, data, error, reload } = useAdminDashboard();
  const loading = status === 'loading';

  // Session ended (401) -> clear it so the route guard sends the admin to the sign-in page.
  const expired = status === 'error' && error?.status === 401;
  useEffect(() => { if (expired) setUser(null); }, [expired, setUser]);
  // A 403 means the account is no longer an administrator: refresh who we are so the guard redirects.
  const demoted = status === 'error' && error?.status === 403;
  useEffect(() => { if (demoted) setUser({ ...user, role: 'student' }); }, [demoted]); // eslint-disable-line react-hooks/exhaustive-deps
  if (expired || demoted) return null;

  const s = data?.stats;
  const apps = data?.breakdown?.applications ?? {};
  const totalApps = s?.totalApplications ?? 0;

  return (
    <div className="overview">
      <section className="overview__hero">
        <div>
          <h1>Welcome, {firstName(user?.fullName)}</h1>
          <p>A live view of students, applications, internships and documents across ELVORA.</p>
        </div>
        <button type="button" className="admin-refresh" onClick={reload} disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" className={loading ? 'spin-icon' : ''} />{loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </section>

      {status === 'error' ? (
        <div className="empty" role="alert">
          <span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span>
          <h3>We couldn’t load the dashboard</h3>
          <p className="text-muted">{error?.status === 0 ? error.message : 'Something went wrong on our side. Please try again.'}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      ) : (
        <>
          <section aria-label="Statistics" className="stats admin-stats" aria-busy={loading}>
            <StatCard loading={loading && !data} icon={Users} label="Total Students" value={s?.totalStudents} hint={s?.totalStudents === 0 ? 'No students have registered yet' : 'Registered student accounts'} />
            <StatCard loading={loading && !data} icon={Briefcase} tone="indigo" label="Total Internships" value={s?.totalInternships} hint="Listings in the internship catalog" />
            <StatCard loading={loading && !data} icon={ClipboardList} label="Total Applications" value={s?.totalApplications} hint={s?.totalApplications === 0 ? 'No applications received yet' : undefined} />
            <StatCard loading={loading && !data} icon={Hourglass} tone="amber" label="Pending Applications" value={s?.pendingApplications} hint="Submitted or under review" />
            <StatCard loading={loading && !data} icon={CheckCircle2} tone="teal" label="Approved Applications" value={s?.approvedApplications} />
            <StatCard loading={loading && !data} icon={PlayCircle} tone="indigo" label="Active Internships" value={s?.activeInternships} hint="Student internships in progress" />
            <StatCard loading={loading && !data} icon={Award} tone="amber" label="Completed Internships" value={s?.completedInternships} />
            <StatCard loading={loading && !data} icon={FileCheck2} tone="teal" label="Documents Issued" value={s?.documentsIssued} hint="Offer letters and certificates" />
          </section>

          <section className="card adm-actions" aria-labelledby="qa-h">
            <h2 id="qa-h">Quick actions</h2>
            <ul className="adm-actions__grid">
              {ACTIONS.map(({ label, text, to, icon: Icon, soon }) => (
                <li key={label}>
                  <Link className="adm-action" to={to}>
                    <span className="adm-action__icon"><Icon size={20} aria-hidden="true" /></span>
                    <span className="adm-action__body"><strong>{label}{soon && <em className="adm-soon">Soon</em>}</strong><span>{text}</span></span>
                    <ArrowRight size={16} aria-hidden="true" className="adm-action__arrow" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <div className="adm-two">
            <section className="recent card" aria-labelledby="act-h">
              <div className="recent__head"><h2 id="act-h">Recent activity</h2>{data && <span className="adm-updated"><Clock size={14} aria-hidden="true" />Updated {fmtDateTime(data.generatedAt)}</span>}</div>
              {loading && !data ? <ActivitySkeleton /> : <Activity_ items={data.recentActivity} />}
            </section>

            <section className="recent card" aria-labelledby="pipe-h">
              <div className="recent__head"><h2 id="pipe-h">Application pipeline</h2></div>
              {loading && !data ? <ActivitySkeleton /> : totalApps === 0 ? (
                <div className="recent__empty" role="status"><h3>No applications yet</h3><p className="text-muted">The status breakdown appears once students start applying.</p></div>
              ) : (
                <ul className="adm-bars">
                  {STATUS_ORDER.map((k) => (
                    <li key={k}>
                      <span className="adm-bars__label">{k}</span>
                      <span className="adm-bars__track" aria-hidden="true"><i style={{ width: `${((apps[k] ?? 0) / totalApps) * 100}%` }} /></span>
                      <span className="adm-bars__n">{apps[k] ?? 0}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
