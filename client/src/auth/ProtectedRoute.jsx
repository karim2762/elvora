import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import PageLoader from '../components/PageLoader';
import { loginLink } from '../lib/applyLinks';

// Private routes. The server enforces access too; this only avoids showing pages that would fail.
export default function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const { pathname, search } = useLocation();
  if (loading) return <PageLoader />;
  return isAuthenticated ? children : <Navigate to={loginLink(pathname + search)} replace />;
}
