import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getUnreadCount } from '../services/studentService';
import { NOTIFICATIONS_CHANGED } from '../lib/notifications';

// Real unread count from the backend for the header bell. Refreshes on navigation and when notifications change.
// A failure just hides the badge; it never shows a made-up number.
export function useUnreadCount() {
  const { pathname } = useLocation();
  const [count, setCount] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => getUnreadCount().then((n) => alive && setCount(n)).catch(() => alive && setCount(null));
    load();
    window.addEventListener(NOTIFICATIONS_CHANGED, load);
    return () => { alive = false; window.removeEventListener(NOTIFICATIONS_CHANGED, load); };
  }, [pathname]);
  return count;
}
