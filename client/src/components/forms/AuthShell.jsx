import { Link, useSearchParams } from 'react-router-dom';
import { ShieldCheck, Layers3, BadgeCheck } from 'lucide-react';
import Logo from '../ui/Logo';
import { useInternship } from '../../hooks/useInternships';
import { internshipIdFromRedirect } from '../../lib/applyLinks';

// Split layout: midnight brand panel + form card. Panel collapses to a compact header on phones.
const points = [
  { icon: Layers3, text: 'One profile for every internship you explore.' },
  { icon: BadgeCheck, text: 'Practical Computer Science and Engineering domains.' },
  { icon: ShieldCheck, text: 'We never ask for Aadhaar numbers or bank details.' },
];

export function RedirectNotice() {
  const [params] = useSearchParams();
  const id = internshipIdFromRedirect(params.get('redirect'));
  const { data: item } = useInternship(id);
  if (!id || !item) return null;
  return <p className="notice notice--info" role="note">You’re applying for <strong>{item.title}</strong>. After signing in you’ll return to your application.</p>;
}

export default function AuthShell({ eyebrow, title, subtitle, wide = false, children, footer }) {
  return (
    <section className="auth">
      <aside className="auth__panel" aria-hidden="false">
        <Logo />
        <div className="auth__panel-body">
          <p className="auth__panel-tag">Elevate Your Skills.<br />Build Your Future.</p>
          <ul className="auth__points">
            {points.map(({ icon: Icon, text }) => <li key={text}><span><Icon size={18} aria-hidden="true" /></span>{text}</li>)}
          </ul>
        </div>
      </aside>
      <div className="auth__main">
        <div className={`auth__card ${wide ? 'auth__card--wide' : ''}`}>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h1 className="auth__title">{title}</h1>
          {subtitle && <p className="auth__sub">{subtitle}</p>}
          {children}
          {footer && <p className="auth__footer">{footer}</p>}
        </div>
        <p className="auth__back"><Link to="/">← Back to home</Link></p>
      </div>
    </section>
  );
}
