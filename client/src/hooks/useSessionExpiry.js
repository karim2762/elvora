import { useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';

// If the session expires while a dashboard page is open the API answers 401. Clearing the user makes the route guard
// send the student to the login page. Returns true while that is happening so the page can render nothing.
export function useSessionExpiry(status, error) {
  const { setUser } = useAuth();
  const expired = status === 'error' && error?.status === 401;
  useEffect(() => { if (expired) setUser(null); }, [expired, setUser]);
  return expired;
}
