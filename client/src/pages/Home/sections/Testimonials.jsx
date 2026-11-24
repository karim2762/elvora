import { Quote } from 'lucide-react';
import SectionHeader from '../../../components/ui/SectionHeader';
import Reveal from '../../../components/ui/Reveal';
import { testimonials } from '../../../config/site';

export default function Testimonials() {
  const hasSample = testimonials.some((t) => t.isSample);
  return (
    <section className="section section--tint" id="testimonials" aria-labelledby="testi-title">
      <div className="container">
        <SectionHeader id="testi-title" eyebrow="Student Voices" title="What Students Will Say" />
        {hasSample && <p className="notice" role="note">Demo content: these are sample placeholders, not real student reviews.</p>}
        <div className="grid grid--3">
          {testimonials.map((t, i) => (
            <Reveal as="figure" key={t.name} delay={i * 70} className="card testi">
              <Quote size={22} aria-hidden="true" />
              <blockquote>{t.quote}</blockquote>
              <figcaption><strong>{t.name}</strong><span className="text-muted">{t.role}</span>{t.isSample && <span className="chip chip--muted">Sample</span>}</figcaption>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
