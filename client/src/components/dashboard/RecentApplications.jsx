import { Link } from 'react-router-dom';
import { ClipboardList, ArrowRight } from 'lucide-react';
import StatusBadge from '../applications/StatusBadge';
import Button from '../ui/Button';
import { fmtDate } from '../../lib/format';
import { formatDuration } from '../../lib/duration';
import { applicationPath } from '../../lib/applyLinks';
import { studentRoutes } from '../../config/dashboard';

export function RecentApplicationsSkeleton() {
  return (
    <ul className="recent__list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="recent__item recent__item--sk"><i className="sk sk--title" /><i className="sk sk--line" /><i className="sk sk--line sk--short" /></li>
      ))}
    </ul>
  );
}

export default function RecentApplications({ items }) {
  if (!items.length) {
    return (
      <div className="recent__empty" role="status">
        <span className="empty__icon"><ClipboardList size={28} aria-hidden="true" /></span>
        <h3>No applications yet</h3>
        <p className="text-muted">Once you apply for an internship, it will show up here with its status.</p>
        <Button to="/internships">Explore internships</Button>
      </div>
    );
  }
  return (
    <>
      <ul className="recent__list">
        {items.map((a) => (
          <li key={a.id} className="recent__item">
            <div className="recent__main">
              <h3 className="recent__title">{a.internship.title}</h3>
              <StatusBadge status={a.status} />
            </div>
            <dl className="recent__facts">
              <div><dt>Application ID</dt><dd className="mono">{a.id}</dd></div>
              <div><dt>Applied</dt><dd>{fmtDate(a.submittedAt)}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(a.internship.durationDays)}</dd></div>
            </dl>
            <Link className="btn btn--secondary btn--sm recent__cta" to={applicationPath(a.id)}
              aria-label={`View details of application ${a.id} for ${a.internship.title}`}>View Details</Link>
          </li>
        ))}
      </ul>
      <Link className="recent__all" to={studentRoutes.applications}>View all applications <ArrowRight size={16} aria-hidden="true" /></Link>
    </>
  );
}
