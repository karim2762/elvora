import SectionHeader from '../../../components/ui/SectionHeader';
import Reveal from '../../../components/ui/Reveal';
import { howItWorks } from '../../../config/site';

export default function HowItWorks() {
  return (
    <section className="section container" id="how-it-works" aria-labelledby="how-title">
      <SectionHeader id="how-title" eyebrow="How It Works" title="Four Simple Steps" />
      <ol className="steps">
        {howItWorks.map(({ icon: Icon, title, text }, i) => (
          <Reveal as="li" key={title} delay={i * 80} className="step">
            <span className="step__num">{i + 1}</span>
            <span className="card__icon"><Icon size={22} aria-hidden="true" /></span>
            <h3 className="card__title">{title}</h3>
            <p className="card__text">{text}</p>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}
