import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as authService from '../services/authService';
import { adminLogin as adminLoginRequest } from '../services/adminDashboardService';

// Real session state. The server owns the session (httpOnly cookie); the client just asks "who am I?".
// `loading` is true until the first /auth/me answer, so protected pages never flash a wrong redirect.
// `initialUser` is kept for tests: when provided, no network request is made.
const AuthContext = createContext({
  user: null, isAuthenticated: false, loading: false,
  setUser: () => {}, login: async () => {}, adminLogin: async () => {}, register: async () => {}, logout: async () => {},
});

export function AuthProvider({ initialUser, children }) {
  const seeded = initialUser !== undefined;
  const [user, setUser] = useState(seeded ? initialUser : null);
  const [loading, setLoading] = useState(!seeded);

  useEffect(() => {
    if (seeded) return undefined;
    let alive = true;
    authService.currentUser().then((u) => alive && setUser(u)).catch(() => alive && setUser(null)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [seeded]);

  const login = useCallback(async (payload) => { const u = await authService.login(payload); setUser(u); return u; }, []);
  const adminLogin = useCallback(async (payload) => { const u = await adminLoginRequest(payload); setUser(u); return u; }, []);
  const register = useCallback(async (payload) => { const u = await authService.register(payload); setUser(u); return u; }, []);
  const logout = useCallback(async () => {
    try { await authService.logout(); } finally { setUser(null); }
  }, []);

  const value = useMemo(() => ({ user, isAuthenticated: Boolean(user), isAdmin: user?.role === 'admin', loading, setUser, login, adminLogin, register, logout }),
    [user, loading, login, adminLogin, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
