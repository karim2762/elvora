import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import PageLoader from '../components/PageLoader';
import { adminRoutes } from '../config/admin';
import { studentRoutes } from '../config/dashboard';

// Admin pages. Not signed in -> admin login. Signed in as a student -> back to the student dashboard (no admin UI is rendered).
// The server checks the role on every admin API call; this only avoids showing pages that would fail.
export default function AdminRoute({ children }) {
  const { isAuthenticated, isAdmin, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!isAuthenticated) return <Navigate to={adminRoutes.login} replace />;
  if (!isAdmin) return <Navigate to={studentRoutes.overview} replace />;
  return children;
}
