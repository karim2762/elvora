import { activeDurations, domains } from '../../config/site';
import { difficultyLevels, internshipTypes } from '../../config/internships';

function Group({ label, options, value, onChange }) {
  return (
    <fieldset className="fgroup">
      <legend>{label}</legend>
      <div className="fgroup__chips">
        <button type="button" className={`chip chip--btn ${!value ? 'is-on' : ''}`} aria-pressed={!value} onClick={() => onChange('')}>All</button>
        {options.map((o) => (
          <button key={o.value} type="button" className={`chip chip--btn ${value === o.value ? 'is-on' : ''}`} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    </fieldset>
  );
}

const asOptions = (arr) => arr.map((v) => ({ value: v, label: v }));

export default function FilterPanel({ id, open, filters, onChange, onClear, canClear }) {
  return (
    <aside id={id} className={`filters ${open ? 'is-open' : ''}`} aria-label="Filters">
      <div className="filters__clip">
        <div className="filters__inner">
          <Group label="Category" value={filters.category} onChange={(v) => onChange('category', v)} options={domains.map((d) => ({ value: d.slug, label: d.title }))} />
          <Group label="Duration" value={filters.duration} onChange={(v) => onChange('duration', v)} options={activeDurations.map((d) => ({ value: String(d.days), label: d.label }))} />
          <Group label="Experience level" value={filters.difficulty} onChange={(v) => onChange('difficulty', v)} options={asOptions(difficultyLevels)} />
          <Group label="Internship type" value={filters.type} onChange={(v) => onChange('type', v)} options={asOptions(internshipTypes)} />
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClear} disabled={!canClear}>Clear All Filters</button>
        </div>
      </div>
    </aside>
  );
}
