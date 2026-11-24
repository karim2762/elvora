import { Check, X } from 'lucide-react';
import { fmtDate } from '../../lib/format';

// Vertical milestone timeline. The server decides every state from backend records (services/progress.js);
// this component only draws it. state: completed | current | pending | stopped.
const STATE_TEXT = { completed: 'Completed', current: 'Current step', pending: 'Upcoming', stopped: 'Stopped' };

export default function ProgressTimeline({ milestones, label = 'Internship progress' }) {
  return (
    <ol className="ptl" aria-label={label}>
      {milestones.map((m, i) => (
        <li key={m.key} className={`ptl__item is-${m.state}`} style={{ animationDelay: `${i * 40}ms` }} aria-current={m.state === 'current' ? 'step' : undefined}>
          <span className="ptl__marker" aria-hidden="true">
            {m.state === 'completed' && <Check size={14} strokeWidth={3} />}
            {m.state === 'stopped' && <X size={14} strokeWidth={3} />}
          </span>
          <div className="ptl__body">
            <p className="ptl__label">{m.label}<span className="sr-only"> — {STATE_TEXT[m.state]}</span></p>
            {m.date && <p className="ptl__date"><time dateTime={m.date}>{fmtDate(m.date)}</time></p>}
            {!m.date && m.state === 'completed' && <p className="ptl__date ptl__date--none">Date not recorded</p>}
            {m.note && <p className="ptl__note">{m.note}</p>}
            {m.state === 'pending' && <p className="ptl__date ptl__date--none">Pending</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function TimelineSkeleton() {
  return (
    <ul className="ptl ptl--sk" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => <li key={i} className="ptl__item"><span className="ptl__marker" /><div className="ptl__body"><i className="sk sk--title" style={{ width: '40%' }} /><i className="sk sk--line" style={{ width: '25%' }} /></div></li>)}
    </ul>
  );
}
