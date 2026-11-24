import { Link } from 'react-router-dom';
import { Clock, Hash } from 'lucide-react';
import { domainBySlug } from '../../config/site';
import { formatDuration } from '../../lib/duration';
import { detailPath } from '../../lib/applyLinks';

// Dark summary of the internship being applied for. `item` is a catalogue internship (title, category, id, durationDays, description).
export default function InternshipSummary({ item }) {
  const cat = domainBySlug(item.category);
  const Icon = cat?.icon;
  return (
    <section className="apply-summary" aria-labelledby="apply-summary-title">
      <p className="apply-summary__cat">{Icon && <Icon size={16} aria-hidden="true" />}{cat?.title ?? item.category}</p>
      <h2 id="apply-summary-title" className="apply-summary__title">{item.title}</h2>
      <dl className="apply-summary__facts">
        <div><dt><Hash size={14} aria-hidden="true" />Internship ID</dt><dd className="mono">{item.id}</dd></div>
        <div><dt><Clock size={14} aria-hidden="true" />Duration</dt><dd>{formatDuration(item.durationDays)}</dd></div>
      </dl>
      <p className="apply-summary__desc">{item.description}</p>
      <Link className="apply-summary__link" to={detailPath(item.id)}>View full internship details</Link>
    </section>
  );
}
