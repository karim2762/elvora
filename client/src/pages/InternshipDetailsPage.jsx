import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, CheckCircle2, Clock, Gauge, Layers, Users, Award } from 'lucide-react';
import { usePageMeta } from '../hooks/usePageMeta';
import { useInternship } from '../hooks/useInternships';
import ApplyButton from '../components/internships/ApplyButton';
import DemoNotice from '../components/internships/DemoNotice';
import { ErrorState } from '../components/internships/ListingStates';
import PageLoader from '../components/PageLoader';
import Button from '../components/ui/Button';
import { domainBySlug } from '../config/site';
import { statusInfo } from '../config/internships';
import { formatDuration } from '../lib/duration';
import { effectiveStatus } from '../lib/internshipFilters';

const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }); };
const List = ({ items }) => <ul className="ticks">{items.map((t) => <li key={t}><CheckCircle2 size={18} aria-hidden="true" />{t}</li>)}</ul>;
const Panel = ({ id, title, children }) => <section className="panel" aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;

export default function InternshipDetailsPage() {
  const { id } = useParams();
  const { state } = useLocation();
  const { status, data: item, reload } = useInternship(id);
  usePageMeta(item ? item.title : 'Internship', item?.description);

  const from = typeof state?.from === 'string' && state.from.startsWith('/internships') ? state.from : '/internships';
  const back = <Link className="back-link" to={from}><ArrowLeft size={16} aria-hidden="true" /> Back to internships</Link>;

  if (status === 'loading') return <PageLoader />;
  if (status === 'error') return <div className="container section">{back}<ErrorState onRetry={reload} /></div>;
  if (!item) return (
    <div className="container container--narrow state-box">
      <h1>Internship not found</h1>
      <p className="text-muted">We couldn’t find an internship with ID “{id}”. It may have been removed.</p>
      <Button to="/internships">Browse internships</Button>
    </div>
  );

  const cat = domainBySlug(item.category);
  const Icon = cat?.icon;
  const st = effectiveStatus(item);
  const { eligibility: el, structure: ds } = item;

  return (
    <>
      <section className="detail-hero">
        <div className="container">
          {back}
          <div className="detail-hero__grid">
            <div>
              <Link className="chip chip--link" to={`/internships?category=${item.category}`}>{Icon && <Icon size={14} aria-hidden="true" />}{cat?.title}</Link>
              <h1>{item.title}</h1>
              <p className="text-muted detail-hero__lead">{item.description}</p>
              <ul className="meta" aria-label="Program details">
                <li className="badge-sm badge-sm--blue"><Clock size={14} aria-hidden="true" />{formatDuration(item.durationDays)}</li>
                <li className="badge-sm"><Gauge size={14} aria-hidden="true" />{item.difficulty}</li>
                <li className="badge-sm"><Layers size={14} aria-hidden="true" />{item.type}</li>
              </ul>
              <DemoNotice />
            </div>
          </div>
        </div>
      </section>

      <div className="container detail">
        <div className="detail__main">
          <Panel id="overview" title="Internship Overview"><p>{item.overview}</p></Panel>

          <Panel id="learn" title="What You Will Learn">
            <h3 className="panel__sub">Skills</h3>
            <ul className="skills skills--lg">{item.skills.map((s) => <li key={s}>{s}</li>)}</ul>
            <h3 className="panel__sub">Technologies</h3>
            <ul className="skills skills--lg skills--tech">{item.technologies.map((s) => <li key={s}>{s}</li>)}</ul>
            <h3 className="panel__sub">Learning outcomes</h3>
            <List items={item.outcomes} />
          </Panel>

          <Panel id="eligibility" title="Eligibility">
            <h3 className="panel__sub">Who can apply</h3><p>{el.who}</p>
            <h3 className="panel__sub">Required knowledge</h3><List items={el.knowledge} />
            <h3 className="panel__sub">Academic requirements</h3><p>{el.academic}</p>
          </Panel>

          <Panel id="structure" title="Internship Structure">
            <p><strong>Program duration:</strong> {formatDuration(item.durationDays)} ({item.durationDays} days)</p>
            <h3 className="panel__sub">Learning plan</h3>
            <ol className="timeline">{ds.plan.map((p) => <li key={p.label}><span className="timeline__label">{p.label}</span><strong>{p.title}</strong><span className="text-muted">{p.detail}</span></li>)}</ol>
            <h3 className="panel__sub">Project</h3><p>{ds.project}</p>
            <h3 className="panel__sub">Assessment</h3><p>{ds.assessment}</p>
            <h3 className="panel__sub">Completion requirements</h3><List items={ds.completion} />
          </Panel>

          <Panel id="additional" title="Additional Information">
            <dl className="facts">
              <div><dt>Application status</dt><dd><span className={`dot dot--${statusInfo[st].tone}`} aria-hidden="true" />{statusInfo[st].label}</dd></div>
              <div><dt>Application deadline</dt><dd>{item.deadline ? fmtDate(item.deadline) : 'Not announced'}</dd></div>
              {item.seats != null && <div><dt>Available seats</dt><dd>{item.seats}</dd></div>}
            </dl>
            <h3 className="panel__sub">Certificate eligibility</h3>
            <p className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><Award size={20} aria-hidden="true" style={{ flex: 'none', marginTop: 3, color: 'var(--teal)' }} />{item.certificate}</p>
          </Panel>
        </div>

        <aside className="detail__side">
          <div className="card summary">
            <h2 className="summary__title">Program summary</h2>
            <dl className="facts facts--stack">
              <div><dt><Clock size={14} aria-hidden="true" /> Duration</dt><dd>{formatDuration(item.durationDays)}</dd></div>
              <div><dt><Gauge size={14} aria-hidden="true" /> Level</dt><dd>{item.difficulty}</dd></div>
              <div><dt><Layers size={14} aria-hidden="true" /> Type</dt><dd>{item.type}</dd></div>
              {item.deadline && <div><dt><CalendarClock size={14} aria-hidden="true" /> Deadline</dt><dd>{fmtDate(item.deadline)}</dd></div>}
              {item.seats != null && <div><dt><Users size={14} aria-hidden="true" /> Seats</dt><dd>{item.seats}</dd></div>}
            </dl>
            <p className="summary__status"><span className={`dot dot--${statusInfo[st].tone}`} aria-hidden="true" />{statusInfo[st].label}</p>
            <ApplyButton internship={item} size="lg" className="btn--block" />
          </div>
        </aside>
      </div>
    </>
  );
}
