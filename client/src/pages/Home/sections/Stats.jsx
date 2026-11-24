import Reveal from '../../../components/ui/Reveal';
import { stats } from '../../../config/site';

export default function Stats() {
  return (
    <section className="stats" aria-label="Highlights">
      <div className="container">
        <dl className="stats__grid">
          {stats.map((s, i) => (
            <Reveal key={s.label} delay={i * 60} className="stat">
              <dd className="stat__value text-gradient">{s.value}</dd>
              <dt className="stat__label">{s.label}</dt>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}
