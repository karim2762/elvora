import { Clock } from 'lucide-react';
import SectionHeader from '../../../components/ui/SectionHeader';
import Reveal from '../../../components/ui/Reveal';
import { activeDurations } from '../../../config/site';

export default function Durations() {
  return (
    <section className="section section--dark" id="durations" aria-labelledby="dur-title">
      <div className="container">
        <SectionHeader id="dur-title" eyebrow="Internship Duration" title="Pick a Duration That Fits You" text="Flexible options so you can learn alongside your studies." />
        <div className="grid grid--dur">
          {activeDurations.map((d, i) => (
            <Reveal key={d.label} delay={i * 70} className="dur">
              <Clock size={22} aria-hidden="true" />
              <strong>{d.label}</strong>
              <span>{d.text}</span>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
