import { BookOpenCheck, FolderGit2, IdCard } from 'lucide-react';
import SectionHeader from '../../../components/ui/SectionHeader';
import Card from '../../../components/ui/Card';
import Reveal from '../../../components/ui/Reveal';

const ITEMS = [
  { icon: BookOpenCheck, title: 'Learn Practical Skills', text: 'Move beyond theory with hands-on, industry-relevant technology skills.' },
  { icon: FolderGit2, title: 'Work on Projects', text: 'Apply what you learn to real project work you can be proud of.' },
  { icon: IdCard, title: 'Build Your Career Profile', text: 'Grow a profile of skills, projects and documents for your next step.' },
];

export default function About() {
  return (
    <section className="section container" id="about" aria-labelledby="about-title">
      <SectionHeader id="about-title" eyebrow="About ELVORA" title="More Than an Internship. A Step Towards Your Career."
        text="ELVORA helps students bridge the gap between academic learning and practical technology skills through structured internship opportunities." />
      <div className="grid">
        {ITEMS.map((it, i) => <Reveal key={it.title} delay={i * 80}><Card interactive {...it} /></Reveal>)}
      </div>
    </section>
  );
}
