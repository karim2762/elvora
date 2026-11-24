import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

// Lightweight notifications. Success/info use role="status" (polite), errors use role="alert".
const ToastContext = createContext({ notify: () => {} });
const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info };

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());
  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);
  const notify = useCallback((type, message) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setItems((list) => [...list.slice(-2), { id, type, message }]);
    timers.current.set(id, setTimeout(() => dismiss(id), type === 'error' ? 7000 : 5000));
  }, [dismiss]);
  useEffect(() => { const t = timers.current; return () => t.forEach(clearTimeout); }, []);
  const value = useMemo(() => ({
    notify, success: (m) => notify('success', m), error: (m) => notify('error', m), info: (m) => notify('info', m),
  }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-label="Notifications">
        {items.map((t) => {
          const Icon = ICONS[t.type];
          return (
            <div key={t.id} className={`toast toast--${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
              <Icon size={20} aria-hidden="true" />
              <p>{t.message}</p>
              <button type="button" className="toast__close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}><X size={16} aria-hidden="true" /></button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
