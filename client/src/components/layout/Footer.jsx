import { Link } from 'react-router-dom';
import { Github, Linkedin, Instagram, Youtube, Twitter, Mail, Phone, MapPin } from 'lucide-react';
import Logo from '../ui/Logo';
import { brand, contact, socials, domains, navLinks, routes } from '../../config/site';

const SOCIAL_ICONS = { LinkedIn: Linkedin, Instagram, YouTube: Youtube, GitHub: Github, X: Twitter };
const soon = (v) => v || 'Coming soon';

export default function Footer() {
  const activeSocials = socials.filter((s) => s.url);
  return (
    <footer className="footer" id="contact">
      <div className="container">
        <div className="footer__grid">
          <div>
            <Logo />
            <p className="footer__about">{brand.description}</p>
            {activeSocials.length > 0 && (
              <ul className="footer__social">
                {activeSocials.map((s) => {
                  const Icon = SOCIAL_ICONS[s.platform];
                  return <li key={s.platform}><a href={s.url} target="_blank" rel="noopener noreferrer" aria-label={s.platform}>{Icon && <Icon size={18} />}</a></li>;
                })}
              </ul>
            )}
          </div>
          <div>
            <h4 className="footer__title">Quick links</h4>
            <ul className="footer__list">{navLinks.map((l) => <li key={l.label}><Link to={l.to}>{l.label}</Link></li>)}</ul>
          </div>
          <div>
            <h4 className="footer__title">Categories</h4>
            <ul className="footer__list">
              {domains.slice(0, 6).map((d) => <li key={d.slug}><Link to={`${routes.internships}?category=${d.slug}`}>{d.title}</Link></li>)}
            </ul>
          </div>
          <div>
            <h4 className="footer__title">Contact</h4>
            <ul className="footer__list footer__contact">
              <li><Mail size={16} aria-hidden="true" />{contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : soon()}</li>
              <li><Phone size={16} aria-hidden="true" />{soon(contact.phone)}</li>
              <li><MapPin size={16} aria-hidden="true" />{soon(contact.address)}</li>
            </ul>
          </div>
        </div>
        <div className="footer__bottom">
          <span>© {new Date().getFullYear()} {brand.name}. All rights reserved.</span>
          <span className="footer__legal"><Link to={routes.privacy}>Privacy Policy</Link><Link to={routes.terms}>Terms and Conditions</Link></span>
        </div>
      </div>
    </footer>
  );
}
