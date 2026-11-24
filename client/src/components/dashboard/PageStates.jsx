import { TriangleAlert } from 'lucide-react';
import Button from '../ui/Button';

// Error block for dashboard pages. 401 is handled by useSessionExpiry before this renders.
export function LoadError({ title, error, onRetry }) {
  return (
    <div className="empty" role="alert">
      <span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span>
      <h3>{title}</h3>
      <p className="text-muted">{error?.status === 0 ? error.message : 'Something went wrong on our side. Please try again.'}</p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}
