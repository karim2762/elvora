import { Link } from 'react-router-dom';
import { useId } from 'react';

// Circular mark: gradient disc with two rising chevrons ("elevate").
export default function Logo({ withWordmark = true, href = '/' }) {
  const id = useId();
  return (
    <Link className="logo" to={href} aria-label="ELVORA home">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
            <stop stopColor="#2563EB" /><stop offset="1" stopColor="#14B8A6" />
          </linearGradient>
        </defs>
        <circle cx="24" cy="24" r="22" fill={`url(#${id})`} />
        <path d="M14 27l10-9 10 9" stroke="#F8FAFC" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 35l10-9 10 9" stroke="#F8FAFC" strokeOpacity=".6" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {withWordmark && <span>ELVORA</span>}
    </Link>
  );
}
