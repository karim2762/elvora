import { Link, Navigate, useParams } from 'react-router-dom';
import { Hammer, ArrowRight } from 'lucide-react';
import { usePageMeta } from '../../hooks/usePageMeta';
import { adminSections, adminRoutes } from '../../config/admin';

// Honest placeholder for management pages that are built in a later stage. It does nothing and promises nothing beyond the stage named.
export default function AdminSectionPage() {
  const { section } = useParams();
  const info = adminSections[section];
  usePageMeta(info ? `${info.title} · Admin` : 'Admin');
  if (!info) return <Navigate to={adminRoutes.overview} replace />;
  return (
    <section className="card adm-soonpage" aria-labelledby="soon-h">
      <span className="empty__icon"><Hammer size={28} aria-hidden="true" /></span>
      <h1 id="soon-h">{info.title}</h1>
      <p className="adm-soonpage__stage">Planned for Stage {info.stage}</p>
      <p className="text-muted">{info.text}</p>
      {info.legacy && (
        <p className="text-muted">Until then, the existing admin console already covers part of this.{' '}
          <Link className="link" to={`${adminRoutes.console}?tab=${info.legacy}`}>Open it <ArrowRight size={14} aria-hidden="true" /></Link></p>
      )}
      <Link className="btn btn--secondary" to={adminRoutes.overview}>Back to Overview</Link>
    </section>
  );
}
