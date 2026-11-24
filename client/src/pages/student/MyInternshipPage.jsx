import { useSearchParams } from 'react-router-dom';
import { Briefcase, CalendarDays, CalendarCheck, Clock, FolderKanban, Hash, Layers, Target, ListChecks, Lock } from 'lucide-react';
import InternshipStatusBadge from '../../components/internships/InternshipStatusBadge';
import ProgressTimeline, { TimelineSkeleton } from '../../components/progress/ProgressTimeline';
import { LoadError } from '../../components/dashboard/PageStates';
import Button from '../../components/ui/Button';
import { useMyInternships } from '../../hooks/useMyInternships';
import { useSessionExpiry } from '../../hooks/useSessionExpiry';
import { usePageMeta } from '../../hooks/usePageMeta';
import { domainBySlug } from '../../config/site';
import { internshipStatusMeta } from '../../config/internshipStatus';
import { formatDuration } from '../../lib/duration';
import { fmtDate } from '../../lib/format';

function Skeleton() {
  return (
    <div className="track" aria-busy="true" aria-label="Loading your internship">
      <div className="card track__card" aria-hidden="true"><i className="sk sk--title" /><i className="sk sk--line" /><i className="sk sk--line sk--short" /></div>
      <div className="card track__card" aria-hidden="true"><TimelineSkeleton /></div>
    </div>
  );
}

const Fact = ({ icon: Icon, label, children }) => <div><dt><Icon size={14} aria-hidden="true" />{label}</dt><dd>{children}</dd></div>;

export default function MyInternshipPage() {
  usePageMeta('My Internship');
  const { status, data, error, reload } = useMyInternships();
  const [params, setParams] = useSearchParams();
  const expired = useSessionExpiry(status, error);
  if (expired) return null;

  if (status === 'loading') return <Skeleton />;
  if (status === 'error') return <div className="track"><LoadError title="We couldn’t load your internship" error={error} onRetry={reload} /></div>;

  if (data.length === 0) {
    return (
      <div className="track">
        <header className="track__head"><div><h1>My Internship</h1></div></header>
        <div className="empty" role="status">
          <span className="empty__icon"><Briefcase size={28} aria-hidden="true" /></span>
          <h3>No internship yet</h3>
          <p className="text-muted">Your internship appears here once an application is approved and ELVORA sets it up. Until then, you can explore internships and apply.</p>
          <Button to="/internships">Explore internships</Button>
        </div>
      </div>
    );
  }

  // Normally one internship. If there are several, ?id= picks one; otherwise prefer an Active one.
  const chosen = data.find((i) => i.id === params.get('id')) ?? data.find((i) => i.status === 'Active') ?? data[0];
  const i = chosen;
  const meta = internshipStatusMeta(i.status);
  const cat = domainBySlug(i.internship.category);
  return (
    <div className="track">
      <header className="track__head">
        <div><h1>My Internship</h1><p className="text-muted">Your internship details and progress. Only ELVORA can start, complete or change an internship.</p></div>
      </header>

      {data.length > 1 && (
        <div className="afilter" role="group" aria-label="Choose an internship">
          {data.map((x) => (
            <button key={x.id} type="button" className={`chip chip--btn afilter__btn ${x.id === i.id ? 'is-on' : ''}`} aria-pressed={x.id === i.id}
              onClick={() => setParams({ id: x.id })}>{x.internship.title}</button>
          ))}
        </div>
      )}

      <section className="card track__card intern" aria-labelledby="int-h">
        <div className="intern__top">
          <div className="intern__title">
            <p className="appd__cat">{cat?.title ?? i.internship.category}</p>
            <h2 id="int-h">{i.internship.title}</h2>
          </div>
          <div className={`appd__status appd__status--${meta.tone === 'teal' ? 'teal' : 'blue'}`}>
            <InternshipStatusBadge status={i.status} />
            <p>{meta.help}</p>
          </div>
        </div>
        {i.progressPercent !== null && i.progressPercent !== undefined && (
          <div className="intern__progress" role="img" aria-label={`Progress ${i.progressPercent}%`}><div className="adm-progress__bar"><i style={{ width: `${i.progressPercent}%` }} /></div><span>Progress: {i.progressPercent}%</span></div>
        )}
        <dl className="intern__facts">
          <Fact icon={Hash} label="Internship ID"><span className="mono">{i.id}</span></Fact>
          <Fact icon={Layers} label="Category">{cat?.title ?? i.internship.category}</Fact>
          <Fact icon={Clock} label="Duration">{formatDuration(i.internship.durationDays)}</Fact>
          <Fact icon={CalendarDays} label="Start date">{i.startDate ? fmtDate(i.startDate) : 'To be announced'}</Fact>
          <Fact icon={CalendarCheck} label="Expected end date">{i.expectedEndDate ? fmtDate(i.expectedEndDate) : '—'}</Fact>
          <Fact icon={FolderKanban} label="Assigned project">{i.assignedProject ?? 'Not assigned yet'}</Fact>
        </dl>
      </section>

      <div className="intern__cols">
        <section className="card track__card" aria-labelledby="obj-h">
          <h2 id="obj-h" className="track__h"><Target size={18} aria-hidden="true" />Learning objectives</h2>
          {i.learningObjectives.length ? (
            <ul className="intern__list">{i.learningObjectives.map((o, n) => <li key={n}>{o}</li>)}</ul>
          ) : <p className="text-muted">Learning objectives haven’t been published for this internship yet.</p>}
        </section>
        <section className="card track__card" aria-labelledby="ins-h">
          <h2 id="ins-h" className="track__h"><ListChecks size={18} aria-hidden="true" />Internship instructions</h2>
          {i.instructions ? <p className="intern__text">{i.instructions}</p> : <p className="text-muted">Instructions haven’t been published for this internship yet.</p>}
        </section>
      </div>

      <section className="card track__card" aria-labelledby="tl-h">
        <h2 id="tl-h" className="track__h">Progress timeline</h2>
        <ProgressTimeline milestones={i.timeline} />
        <p className="track__note"><Lock size={14} aria-hidden="true" />Milestones are updated by ELVORA. A certificate appears here only after an official one has been issued.</p>
      </section>
    </div>
  );
}
