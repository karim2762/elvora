import { useState, useId } from 'react';
import { ChevronDown } from 'lucide-react';

// Accessible single-open accordion. items: [{ q, a }]
export default function Accordion({ items }) {
  const [open, setOpen] = useState(0);
  const base = useId();
  return (
    <div className="accordion">
      {items.map((it, i) => {
        const isOpen = open === i;
        return (
          <div key={it.q} className={`accordion__item ${isOpen ? 'is-open' : ''}`}>
            <h3>
              <button type="button" className="accordion__trigger" aria-expanded={isOpen}
                aria-controls={`${base}-${i}`} id={`${base}-h${i}`} onClick={() => setOpen(isOpen ? -1 : i)}>
                <span>{it.q}</span><ChevronDown size={20} aria-hidden="true" />
              </button>
            </h3>
            <div id={`${base}-${i}`} role="region" aria-labelledby={`${base}-h${i}`} className="accordion__panel">
              <div className="accordion__clip"><p className="text-muted">{it.a}</p></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
