import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellOff, CheckCheck, Loader2, ArrowRight } from 'lucide-react';
import { LoadError } from '../../components/dashboard/PageStates';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/ui/Toast';
import { usePageMeta } from '../../hooks/usePageMeta';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '../../services/studentService';
import { notificationMeta, notificationAction, announceNotificationsChanged } from '../../lib/notifications';
import { fmtDateTime } from '../../lib/format';

const PAGE_SIZE = 10;

function Skeleton() {
  return <div className="stu" aria-busy="true" aria-label="Loading notifications">{[0, 1, 2].map((i) => <div key={i} className="card stu__card" aria-hidden="true"><i className="sk sk--title" /><i className="sk sk--line" /></div>)}</div>;
}

export default function NotificationsPage() {
  usePageMeta('Notifications');
  const { setUser } = useAuth();
  const toast = useToast();
  const [filter, setFilter] = useState('all'); // all | unread
  const [state, setState] = useState({ status: 'loading', items: [], page: 1, totalPages: 1, total: 0, unread: 0, error: null });
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(null); // notification id, or 'all'
  const [tick, setTick] = useState(0);

  const fail = useCallback((err) => { if (err.status === 401) setUser(null); }, [setUser]);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, status: 'loading', error: null }));
    listNotifications({ page: 1, pageSize: PAGE_SIZE, unread: filter === 'unread' })
      .then((r) => alive && setState({ status: 'ready', items: r.notifications, page: r.pagination.page, totalPages: r.pagination.totalPages, total: r.pagination.total, unread: r.unreadCount, error: null }))
      .catch((error) => { if (alive) { fail(error); setState((s) => ({ ...s, status: 'error', error })); } });
    return () => { alive = false; };
  }, [filter, tick, fail]);

  async function loadMore() {
    setMore(true);
    try {
      const r = await listNotifications({ page: state.page + 1, pageSize: PAGE_SIZE, unread: filter === 'unread' });
      setState((s) => {
        const seen = new Set(s.items.map((n) => n.id));
        return { ...s, items: [...s.items, ...r.notifications.filter((n) => !seen.has(n.id))], page: r.pagination.page, totalPages: r.pagination.totalPages, unread: r.unreadCount };
      });
    } catch (err) { fail(err); toast.error(err.status === 0 ? err.message : 'Couldn’t load more notifications.'); } finally { setMore(false); }
  }

  // The UI changes only after the server confirms.
  async function read(id) {
    setBusy(id);
    try {
      const r = await markNotificationRead(id);
      setState((s) => ({ ...s, unread: r.unreadCount, items: filter === 'unread' ? s.items.filter((n) => n.id !== id) : s.items.map((n) => (n.id === id ? r.notification : n)), total: filter === 'unread' ? s.total - 1 : s.total }));
      announceNotificationsChanged();
    } catch (err) { fail(err); toast.error(err.status === 0 ? err.message : 'Couldn’t mark it as read. Please try again.'); } finally { setBusy(null); }
  }
  async function readAll() {
    setBusy('all');
    try {
      await markAllNotificationsRead();
      announceNotificationsChanged();
      if (filter === 'unread') setTick((t) => t + 1);
      else setState((s) => ({ ...s, unread: 0, items: s.items.map((n) => ({ ...n, read: true })) }));
      toast.success('All notifications marked as read.');
    } catch (err) { fail(err); toast.error(err.status === 0 ? err.message : 'Couldn’t mark all as read. Please try again.'); } finally { setBusy(null); }
  }

  const { status, items, unread, error } = state;
  return (
    <div className="stu">
      <header className="stu__head stu__head--row">
        <div><h1>Notifications</h1><p className="text-muted">Updates about your applications, internship and documents.</p></div>
        <button type="button" className="btn btn--secondary btn--sm" onClick={readAll} disabled={busy === 'all' || status !== 'ready' || unread === 0}>
          {busy === 'all' ? <Loader2 className="spin-icon" size={16} aria-hidden="true" /> : <CheckCheck size={16} aria-hidden="true" />}Mark all as read
        </button>
      </header>
      <div className="afilter" role="group" aria-label="Filter notifications">
        {[['all', 'All'], ['unread', 'Unread']].map(([k, label]) => (
          <button key={k} type="button" className={`chip chip--btn afilter__btn ${filter === k ? 'is-on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}{k === 'unread' && status === 'ready' && unread > 0 ? ` (${unread})` : ''}
          </button>
        ))}
      </div>

      {status === 'loading' && <Skeleton />}
      {status === 'error' && <LoadError title="We couldn’t load your notifications" error={error} onRetry={() => setTick((t) => t + 1)} />}
      {status === 'ready' && items.length === 0 && (
        <div className="empty" role="status">
          <span className="empty__icon">{filter === 'unread' ? <BellOff size={28} aria-hidden="true" /> : <Bell size={28} aria-hidden="true" />}</span>
          <h3>{filter === 'unread' ? 'You’re all caught up' : 'No notifications yet'}</h3>
          <p className="text-muted">{filter === 'unread' ? 'You have no unread notifications.' : 'Updates about your applications, internship and documents will show up here.'}</p>
        </div>
      )}
      {status === 'ready' && items.length > 0 && (
        <>
          <ul className="notif-list" aria-live="polite">
            {items.map((n) => {
              const { icon: Icon, tone, label } = notificationMeta(n.type);
              const action = notificationAction(n);
              return (
                <li key={n.id} className={`card notif ${n.read ? '' : 'is-unread'}`}>
                  <span className={`notif__icon notif__icon--${tone}`}><Icon size={20} aria-hidden="true" /></span>
                  <div className="notif__main">
                    <p className="notif__meta"><span>{label}</span><time dateTime={n.createdAt}>{fmtDateTime(n.createdAt)}</time>{!n.read && <span className="notif__dot"><span className="sr-only">Unread</span></span>}</p>
                    <h3 className="notif__title">{n.title}</h3>
                    <p className="notif__msg">{n.message}</p>
                    <div className="notif__actions">
                      {action && <Link className="notif__link" to={action.to} onClick={() => !n.read && markNotificationRead(n.id).then(announceNotificationsChanged).catch(() => {})}>{action.label}<ArrowRight size={14} aria-hidden="true" /></Link>}
                      {!n.read && <button type="button" className="notif__btn" disabled={busy === n.id} onClick={() => read(n.id)}>{busy === n.id ? 'Saving…' : 'Mark as read'}</button>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {state.page < state.totalPages && (
            <div className="stu__more"><button type="button" className="btn btn--secondary" onClick={loadMore} disabled={more}>{more ? <><Loader2 className="spin-icon" size={16} aria-hidden="true" />Loading…</> : 'Load more'}</button></div>
          )}
        </>
      )}
    </div>
  );
}
