import { ArrowRight } from 'lucide-react';
import SectionHeader from '../../../components/ui/SectionHeader';
import Card from '../../../components/ui/Card';
import Button from '../../../components/ui/Button';
import Reveal from '../../../components/ui/Reveal';
import { domains, routes } from '../../../config/site';

export default function Domains() {
  return (
    <section className="section container" id="domains" aria-labelledby="domains-title">
      <SectionHeader id="domains-title" eyebrow="Internship Domains" title="Choose Your Technology Path" text="Pick a domain that matches your interests and goals." />
      <div className="grid grid--4">
        {domains.map((d, i) => (
          <Reveal key={d.slug} delay={(i % 4) * 60}>
            <Card interactive icon={d.icon} title={d.title} text={d.text} className="card--domain">
              <Button variant="ghost" size="sm" icon={ArrowRight} to={`${routes.internships}?category=${d.slug}`}
                aria-label={`Explore ${d.title} internships`}>Explore</Button>
            </Card>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
