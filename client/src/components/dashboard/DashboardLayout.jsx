import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, LogOut, Menu, X, UserRound, Settings } from 'lucide-react';
import Logo from '../ui/Logo';
import ScrollManager from '../layout/ScrollManager';
import { useAuth } from '../../auth/AuthContext';
import { studentNav, studentRoutes } from '../../config/dashboard';
import { firstName, initials } from '../../lib/names';
import { useUnreadCount } from '../../hooks/useUnreadCount';

// Shell for every /student/* page: fixed sidebar on desktop, slide-in drawer below 1024px.
export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const toggleRef = useRef(null);
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);
  const drawerRef = useRef(null);
  const unread = useUnreadCount();

  useEffect(() => { setDrawer(false); setMenu(false); }, [pathname]);

  // Escape closes whichever overlay is open and returns focus to its trigger. Body scroll is locked while the drawer is open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (menu) { setMenu(false); menuBtnRef.current?.focus(); }
      else if (drawer) { setDrawer(false); toggleRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, drawer]);
  useEffect(() => {
    document.body.style.overflow = drawer ? 'hidden' : '';
    if (drawer) drawerRef.current?.querySelector('a')?.focus();
    return () => { document.body.style.overflow = ''; };
  }, [drawer]);
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => { if (!menuRef.current?.contains(e.target)) setMenu(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menu]);
  // Leaving mobile width with the drawer open would leave scroll locked; close it.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e) => e.matches && setDrawer(false);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const signOut = useCallback(async () => {
    try { await logout(); } finally { navigate('/login', { replace: true }); }
  }, [logout, navigate]);

  const name = user?.fullName ?? '';
  const nav = (
    <ul className="dash-nav__list">
      {studentNav.map(({ label, to, icon: Icon }) => (
        <li key={label}>
          <NavLink to={to} className={({ isActive }) => `dash-nav__link ${isActive ? 'is-active' : ''}`}>
            <Icon size={20} aria-hidden="true" /><span>{label}</span>
          </NavLink>
        </li>
      ))}
      <li className="dash-nav__sep" role="presentation" />
      <li>
        <button type="button" className="dash-nav__link dash-nav__btn" onClick={signOut}>
          <LogOut size={20} aria-hidden="true" /><span>Logout</span>
        </button>
      </li>
    </ul>
  );

  return (
    <div className="dash app-scope">
      <ScrollManager />
      <a className="skip-link" href="#main">Skip to content</a>

      <header className="dash-header">
        <button ref={toggleRef} type="button" className="dash-iconbtn dash-header__toggle" aria-label={drawer ? 'Close navigation' : 'Open navigation'}
          aria-expanded={drawer} aria-controls="dash-sidebar" onClick={() => setDrawer((d) => !d)}>
          {drawer ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
        </button>
        <Logo href={studentRoutes.overview} />
        <p className="dash-header__welcome">Welcome back, <strong>{firstName(name)}</strong></p>
        <div className="dash-header__actions">
          <NavLink to={studentRoutes.notifications} className="dash-iconbtn dash-bell" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
            <Bell size={20} aria-hidden="true" />{unread > 0 && <span className="dash-bell__badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
          </NavLink>
          <div className="dash-menu" ref={menuRef}>
            <button ref={menuBtnRef} type="button" className="dash-menu__btn" aria-haspopup="menu" aria-expanded={menu}
              aria-label="Account menu" onClick={() => setMenu((m) => !m)}>
              <span className="dash-avatar" aria-hidden="true">{initials(name)}</span>
              <ChevronDown size={16} aria-hidden="true" className="dash-menu__chev" />
            </button>
            {menu && (
              <div className="dash-menu__panel" role="menu">
                <div className="dash-menu__who">
                  <strong>{name}</strong>
                  <span>{user?.email}</span>
                </div>
                <NavLink role="menuitem" to={studentRoutes.profile} className="dash-menu__item"><UserRound size={16} aria-hidden="true" />My Profile</NavLink>
                <NavLink role="menuitem" to={studentRoutes.settings} className="dash-menu__item"><Settings size={16} aria-hidden="true" />Settings</NavLink>
                <button role="menuitem" type="button" className="dash-menu__item" onClick={signOut}><LogOut size={16} aria-hidden="true" />Logout</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {drawer && <div className="dash-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <aside id="dash-sidebar" ref={drawerRef} className={`dash-sidebar ${drawer ? 'is-open' : ''}`}>
        <nav aria-label="Student dashboard">{nav}</nav>
      </aside>

      <main id="main" tabIndex={-1} className="dash-main">
        <div key={pathname} className="page-enter"><Outlet /></div>
      </main>
    </div>
  );
}
