import { ArrowRight, Sparkles, Terminal, Globe, Brain, Code2, ShieldCheck } from 'lucide-react';
import Button from '../../../components/ui/Button';
import { routes } from '../../../config/site';

const FLOATERS = [
  { icon: Terminal, title: 'Python Development', cls: 'float--a' },
  { icon: Globe, title: 'Web Development', cls: 'float--b' },
  { icon: Brain, title: 'Machine Learning', cls: 'float--c' },
];

export default function Hero() {
  return (
    <section className="hero" id="home" aria-labelledby="hero-title">
      <div className="hero__bg" aria-hidden="true" />
      <div className="container hero__inner">
        <div className="hero__copy animate-rise">
          <span className="badge"><Sparkles size={14} aria-hidden="true" /> Your Career Starts Here</span>
          <h1 id="hero-title" className="hero__title">Build Your Future With <span className="text-gradient">Industry-Ready Skills.</span></h1>
          <p className="hero__text">Discover practical CSE internships, gain real-world experience, develop professional skills and take your first step towards a successful technology career.</p>
          <div className="row">
            <Button size="lg" to={routes.internships} icon={ArrowRight}>Explore Internships</Button>
            <Button size="lg" variant="secondary" to={routes.signup}>Join ELVORA</Button>
          </div>
        </div>
        <div className="hero__visual" aria-hidden="true">
          <div className="hero__window">
            <div className="window__bar"><i /><i /><i /></div>
            <div className="window__body">
              <Code2 size={28} />
              <div className="bars"><b style={{ width: '82%' }} /><b style={{ width: '58%' }} /><b style={{ width: '70%' }} /><b style={{ width: '40%' }} /></div>
            </div>
          </div>
          {FLOATERS.map(({ icon: Icon, title, cls }) => (
            <div key={title} className={`float ${cls}`}><span className="float__icon"><Icon size={18} /></span>{title}</div>
          ))}
          <span className="orb orb--1" /><span className="orb orb--2" />
          <ShieldCheck className="deco deco--1" size={22} /><Sparkles className="deco deco--2" size={20} />
        </div>
      </div>
    </section>
  );
}
