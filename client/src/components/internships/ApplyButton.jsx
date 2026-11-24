import { ArrowRight } from 'lucide-react';
import Button from '../ui/Button';
import { useAuth } from '../../auth/AuthContext';
import { applyPath, loginLink } from '../../lib/applyLinks';
import { effectiveStatus } from '../../lib/internshipFilters';

// Signed in -> application form route. Signed out -> login with the application path preserved.
export default function ApplyButton({ internship, size = 'md', className = '' }) {
  const { isAuthenticated } = useAuth();
  const status = effectiveStatus(internship);
  if (status !== 'open') {
    return <Button variant="secondary" size={size} className={className} disabled aria-disabled="true">{status === 'upcoming' ? 'Opens soon' : 'Applications closed'}</Button>;
  }
  const target = applyPath(internship.id);
  return <Button size={size} className={className} to={isAuthenticated ? target : loginLink(target)} icon={ArrowRight}>Apply Now</Button>;
}
