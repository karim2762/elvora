import { ArrowRight } from 'lucide-react';
import Button from '../../../components/ui/Button';
import Reveal from '../../../components/ui/Reveal';
import { routes } from '../../../config/site';

export default function Cta() {
  return (
    <section className="section container" aria-labelledby="cta-title">
      <Reveal className="cta">
        <h2 id="cta-title">Your Next Opportunity Starts Today.</h2>
        <p>Take the first step towards building your technology career with ELVORA.</p>
        <div className="row row--center">
          <Button size="lg" variant="secondary" to={routes.internships} icon={ArrowRight}>Explore Internships</Button>
          <Button size="lg" variant="ghost" className="btn--onDark" to={routes.signup}>Create Your Account</Button>
        </div>
      </Reveal>
    </section>
  );
}
