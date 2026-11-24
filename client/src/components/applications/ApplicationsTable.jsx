import { Link } from 'react-router-dom';
import StatusBadge from './StatusBadge';
import { domainBySlug } from '../../config/site';
import { formatDuration } from '../../lib/duration';
import { fmtDate } from '../../lib/format';
import { applicationPath } from '../../lib/applyLinks';

const catName = (a) => domainBySlug(a.internship.category)?.title ?? a.internship.category;

// Desktop: a real table. Phones: the same rows as cards (CSS shows one of the two; the other is display:none).
export default function ApplicationsTable({ items }) {
  return (
    <>
      <div className="atable card">
        <table>
          <caption className="sr-only">Your internship applications</caption>
          <thead>
            <tr>
              <th scope="col">Application ID</th><th scope="col">Internship</th><th scope="col">Duration</th>
              <th scope="col">Applied</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.id}</td>
                <td><span className="atable__title">{a.internship.title}</span><span className="atable__cat">{catName(a)}</span></td>
                <td>{formatDuration(a.internship.durationDays)}</td>
                <td>{fmtDate(a.submittedAt)}</td>
                <td><StatusBadge status={a.status} /></td>
                <td className="atable__act"><Link className="btn btn--secondary btn--sm" to={applicationPath(a.id)} aria-label={`View details of application ${a.id} for ${a.internship.title}`}>View Details</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="acards">
        {items.map((a) => (
          <li key={a.id} className="acards__item card">
            <div className="acards__top">
              <div><p className="acards__cat">{catName(a)}</p><h2 className="acards__title">{a.internship.title}</h2></div>
              <StatusBadge status={a.status} />
            </div>
            <dl className="acards__facts">
              <div><dt>Application ID</dt><dd className="mono">{a.id}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(a.internship.durationDays)}</dd></div>
              <div><dt>Applied</dt><dd>{fmtDate(a.submittedAt)}</dd></div>
            </dl>
            <Link className="btn btn--secondary btn--sm" to={applicationPath(a.id)} aria-label={`View details of application ${a.id} for ${a.internship.title}`}>View Details</Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ApplicationsSkeleton() {
  return (
    <div className="card asks" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => <div key={i} className="asks__row"><i className="sk sk--line" style={{ width: '22%' }} /><i className="sk sk--title" style={{ width: '34%' }} /><i className="sk sk--line" style={{ width: '12%' }} /></div>)}
    </div>
  );
}
