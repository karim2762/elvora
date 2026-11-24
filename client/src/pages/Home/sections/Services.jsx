import SectionHeader from '../../../components/ui/SectionHeader';
import Card from '../../../components/ui/Card';
import Reveal from '../../../components/ui/Reveal';
import { services } from '../../../config/site';

export default function Services() {
  return (
    <section className="section section--tint" id="services" aria-labelledby="services-title">
      <div className="container">
        <SectionHeader id="services-title" eyebrow="Our Services" title="Everything You Need to Grow" text="Services are shown as available only when the organization has enabled them." />
        <div className="grid grid--3">
          {services.map((s, i) => (
            <Reveal key={s.title} delay={i * 60}>
              <Card interactive icon={s.icon} title={s.title} text={s.text}>
                {!s.available && <span className="chip chip--muted">Coming soon</span>}
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
