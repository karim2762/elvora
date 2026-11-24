import { SearchX, TriangleAlert } from 'lucide-react';
import Button from '../ui/Button';

export function EmptyState({ onClear }) {
  return (
    <div className="empty" role="status">
      <span className="empty__icon"><SearchX size={30} aria-hidden="true" /></span>
      <h3>No internships match your search</h3>
      <p className="text-muted">Try a different keyword or remove some filters to see more opportunities.</p>
      <Button onClick={onClear}>Clear All Filters</Button>
    </div>
  );
}

export function ErrorState({ onRetry }) {
  return (
    <div className="empty" role="alert">
      <span className="empty__icon empty__icon--warn"><TriangleAlert size={30} aria-hidden="true" /></span>
      <h3>We couldn’t load internships</h3>
      <p className="text-muted">Please check your connection and try again.</p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}

export function CardSkeletons({ count = 6 }) {
  return (
    <div className="i-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card skeleton"><i className="sk sk--icon" /><i className="sk sk--line" /><i className="sk sk--title" /><i className="sk sk--line" /><i className="sk sk--line sk--short" /></div>
      ))}
    </div>
  );
}
