import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, UserRound } from 'lucide-react';
import Logo from '../ui/Logo';
import Button from '../ui/Button';
import { navLinks, routes } from '../../config/site';
import { useAuth } from '../../auth/AuthContext';

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { pathname, hash } = useLocation();
  const { isAuthenticated, loading } = useAuth();

  useEffect(() => { setOpen(false); }, [pathname, hash]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('keydown', onKey); };
  }, []);

  // Active state: page links match the path; hash links match the current hash.
  const isActive = (to) => {
    const [p, h] = to.split('#');
    return h ? pathname === (p || '/') && hash === `#${h}` : pathname === p && !hash;
  };

  return (
    <header className={`navbar ${scrolled ? 'navbar--scrolled' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="container navbar__inner">
        <Logo />
        <Button variant="ghost" size="sm" className="navbar__toggle" aria-expanded={open}
          aria-controls="nav-panel" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen((o) => !o)}
          icon={open ? X : Menu} />
        <nav id="nav-panel" className={`navbar__panel ${open ? 'navbar__panel--open' : ''}`} aria-label="Main">
          <ul className="navbar__links">
            {navLinks.map((l) => (
              <li key={l.label}>
                <Link to={l.to} className={`navbar__link ${isActive(l.to) ? 'is-active' : ''}`}
                  aria-current={isActive(l.to) ? 'page' : undefined}>{l.label}</Link>
              </li>
            ))}
          </ul>
          <div className="navbar__actions">
            {loading ? null : isAuthenticated
              ? (<>
                <Button variant="ghost" size="sm" to={routes.applications}>My Applications</Button>
                <Button size="sm" to={routes.profile} icon={UserRound}>My Profile</Button>
              </>)
              : (<>
                <Button variant="ghost" size="sm" to={routes.login}>Login</Button>
                <Button size="sm" to={routes.signup}>Get Started</Button>
              </>)}
          </div>
        </nav>
      </div>
    </header>
  );
}
