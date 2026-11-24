import { Link, useLocation } from 'react-router-dom';
import { Clock, Gauge, Layers, Star, Users } from 'lucide-react';
import Button from '../ui/Button';
import ApplyButton from './ApplyButton';
import { domainBySlug } from '../../config/site';
import { statusInfo } from '../../config/internships';
import { formatDuration } from '../../lib/duration';
import { detailPath } from '../../lib/applyLinks';
import { effectiveStatus } from '../../lib/internshipFilters';

const MAX_SKILLS = 4;

export default function InternshipCard({ item, index = 0 }) {
  const { pathname, search } = useLocation();
  const cat = domainBySlug(item.category);
  const Icon = cat?.icon;
  const status = effectiveStatus(item);
  const extra = item.skills.length - MAX_SKILLS;
  return (
    <article className="card card--interactive i-card" style={{ '--i': Math.min(index, 8) }}>
      <div className="i-card__top">
        <span className="card__icon">{Icon && <Icon size={22} aria-hidden="true" />}</span>
        {item.featured && <span className="chip chip--featured"><Star size={12} aria-hidden="true" /> Featured</span>}
      </div>
      <p className="i-card__cat">{cat?.title}</p>
      <h3 className="card__title i-card__title"><Link to={detailPath(item.id)} state={{ from: pathname + search }}>{item.title}</Link></h3>
      <p className="card__text i-card__desc">{item.description}</p>
      <ul className="meta" aria-label="Program details">
        <li className="badge-sm badge-sm--blue"><Clock size={14} aria-hidden="true" />{formatDuration(item.durationDays)}</li>
        <li className="badge-sm"><Gauge size={14} aria-hidden="true" />{item.difficulty}</li>
        <li className="badge-sm"><Layers size={14} aria-hidden="true" />{item.type}</li>
      </ul>
      <ul className="skills" aria-label="Required skills">
        {item.skills.slice(0, MAX_SKILLS).map((s) => <li key={s}>{s}</li>)}
        {extra > 0 && <li className="skills__more">+{extra}</li>}
      </ul>
      <div className="i-card__status">
        <span className={`dot dot--${statusInfo[status].tone}`} aria-hidden="true" />{statusInfo[status].label}
        {status === 'open' && item.seats != null && <span className="i-card__seats"><Users size={13} aria-hidden="true" />{item.seats} seats</span>}
      </div>
      <div className="i-card__actions">
        <Button variant="secondary" size="sm" to={detailPath(item.id)} state={{ from: pathname + search }} aria-label={`View details: ${item.title}`}>View Details</Button>
        <ApplyButton internship={item} size="sm" />
      </div>
    </article>
  );
}
