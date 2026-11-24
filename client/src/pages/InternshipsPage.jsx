import { useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { usePageMeta } from '../hooks/usePageMeta';
import { useInternships } from '../hooks/useInternships';
import InternshipCard from '../components/internships/InternshipCard';
import FilterPanel from '../components/internships/FilterPanel';
import DemoNotice from '../components/internships/DemoNotice';
import { EmptyState, ErrorState, CardSkeletons } from '../components/internships/ListingStates';
import { sortOptions } from '../config/internships';
import { readFilters, withFilter, clearFilters, panelFilterCount, hasActiveFilters, filterInternships, sortInternships } from '../lib/internshipFilters';

export default function InternshipsPage() {
  usePageMeta('Internships', 'Search and filter practical CSE internships by category, duration, experience level and type.');
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const { status, data, reload } = useInternships();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const setFilter = (key, value) => setParams((p) => withFilter(p, key, value), { replace: true });
  const clearAll = () => setParams((p) => clearFilters(p), { replace: true });

  const results = useMemo(() => (data ? sortInternships(filterInternships(data, filters), filters.sort) : []), [data, filters]);
  const panelCount = panelFilterCount(filters);
  const filtered = hasActiveFilters(filters);

  return (
    <>
      <section className="page-hero">
        <div className="container">
          <span className="eyebrow">Internships</span>
          <h1>Explore Opportunities</h1>
          <p className="text-muted page-hero__sub">Discover internships designed to develop your technical skills and prepare you for the future.</p>
          <DemoNotice />
        </div>
      </section>

      <section className="container listing-wrap" aria-label="Internship listing">
        <div className="toolbar">
          <div className="search">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="q">Search internships</label>
            <input id="q" type="search" inputMode="search" autoComplete="off" placeholder="Search by title, category, skill or keyword"
              value={filters.q} onChange={(e) => setFilter('q', e.target.value)} />
            {filters.q && <button type="button" className="search__clear" aria-label="Clear search" onClick={() => setFilter('q', '')}><X size={16} aria-hidden="true" /></button>}
          </div>
          <div className="toolbar__row">
            <button type="button" className="btn btn--secondary btn--sm filter-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
              <SlidersHorizontal size={16} aria-hidden="true" /> Filters{panelCount > 0 && <span className="count-pill">{panelCount}</span>}
            </button>
            <label className="select">
              <span className="sr-only">Sort by</span>
              <select value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)}>
                {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="listing">
          <FilterPanel id={panelId} open={open} filters={filters} onChange={setFilter} onClear={clearAll} canClear={filtered} />
          <div className="results">
            <div className="results__bar">
              <p className="results__count" aria-live="polite">
                {status === 'ready' ? <><strong>{results.length}</strong> {results.length === 1 ? 'internship' : 'internships'} found{filtered && data ? <span className="text-muted"> of {data.length}</span> : null}</> : '\u00a0'}
              </p>
              {filtered && <button type="button" className="btn btn--ghost btn--sm" onClick={clearAll}>Clear All Filters</button>}
            </div>
            {status === 'loading' && <CardSkeletons />}
            {status === 'error' && <ErrorState onRetry={reload} />}
            {status === 'ready' && (results.length === 0
              ? <EmptyState onClear={clearAll} />
              : <div className="i-grid">{results.map((item, i) => <InternshipCard key={item.id} item={item} index={i} />)}</div>)}
          </div>
        </div>
      </section>
    </>
  );
}
