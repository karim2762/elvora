import { ChevronLeft, ChevronRight } from 'lucide-react';

export default function Pagination({ page, totalPages, total, pageSize, onChange }) {
  if (totalPages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Applications pages">
      <p className="pager__info" aria-live="polite">Showing {from}–{to} of {total}</p>
      <div className="pager__btns">
        <button type="button" className="btn btn--secondary btn--sm" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={16} aria-hidden="true" />Previous</button>
        <span className="pager__page">Page {page} of {totalPages}</span>
        <button type="button" className="btn btn--secondary btn--sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>Next<ChevronRight size={16} aria-hidden="true" /></button>
      </div>
    </nav>
  );
}
