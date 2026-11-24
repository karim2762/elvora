import { CalendarClock, ListChecks, Rocket, LayoutDashboard, FileCheck2, TrendingUp, Award } from 'lucide-react';
import SectionHeader from '../../../components/ui/SectionHeader';
import Reveal from '../../../components/ui/Reveal';

const ROWS = [
  { visual: 'steps', title: 'Learn at your own pace, with a clear path',
    features: [{ icon: CalendarClock, title: 'Flexible internship durations', text: 'Choose a duration that fits your schedule.' }, { icon: ListChecks, title: 'Structured learning', text: 'A clear plan from start to finish.' }] },
  { visual: 'dashboard', title: 'Real work, tracked in one place',
    features: [{ icon: Rocket, title: 'Practical projects', text: 'Build things that reflect real-world tasks.' }, { icon: LayoutDashboard, title: 'Student dashboard', text: 'Follow your internship progress in one view.' }] },
  { visual: 'document', title: 'Documents and growth, all digital',
    features: [{ icon: FileCheck2, title: 'Digital documentation', text: 'Keep your internship documents organized online.' }, { icon: TrendingUp, title: 'Professional development', text: 'Build habits and skills employers look for.' }] },
];

function Visual({ type }) {
  if (type === 'steps') return (<div className="viz viz--steps" aria-hidden="true">{['Week 1', 'Week 2', 'Week 3', 'Week 4'].map((w, i) => (<div key={w} className="viz__step"><span>{i + 1}</span><b style={{ width: `${40 + i * 15}%` }} />{w}</div>))}</div>);
  if (type === 'dashboard') return (<div className="viz viz--dash" aria-hidden="true"><div className="viz__tiles"><i /><i /><i /></div><div className="viz__chart"><b style={{ height: '40%' }} /><b style={{ height: '65%' }} /><b style={{ height: '50%' }} /><b style={{ height: '85%' }} /><b style={{ height: '70%' }} /></div></div>);
  return (<div className="viz viz--doc" aria-hidden="true"><Award size={34} /><b style={{ width: '60%' }} /><b style={{ width: '80%' }} /><b style={{ width: '45%' }} /></div>);
}

export default function WhyChoose() {
  return (
    <section className="section section--tint" id="why" aria-labelledby="why-title">
      <div className="container">
        <SectionHeader id="why-title" eyebrow="Why Choose ELVORA" title="Built Around the Student Experience" />
        <div className="why">
          {ROWS.map((r, i) => (
            <Reveal key={r.title} className={`why__row ${i % 2 ? 'why__row--flip' : ''}`}>
              <div>
                <h3 className="why__title">{r.title}</h3>
                <ul className="why__list">
                  {r.features.map(({ icon: Icon, title, text }) => (
                    <li key={title}><span className="card__icon"><Icon size={22} aria-hidden="true" /></span><div><strong>{title}</strong><p className="text-muted">{text}</p></div></li>
                  ))}
                </ul>
              </div>
              <Visual type={r.visual} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
