// Reusable statistic card. `value` null/undefined means "not available": shows a dash and the hint explains why.
export default function StatCard({ icon: Icon, label, value, hint, tone = 'blue', loading = false }) {
  if (loading) {
    return (
      <div className="stat card" aria-hidden="true">
        <i className="sk sk--icon" /><i className="sk sk--line" style={{ width: '55%' }} /><i className="sk sk--title" style={{ width: '35%', height: 28 }} />
      </div>
    );
  }
  const available = value !== null && value !== undefined;
  return (
    <div className="stat card">
      <span className={`stat__icon stat__icon--${tone}`}><Icon size={22} aria-hidden="true" /></span>
      <p className="stat__label">{label}</p>
      <p className="stat__value" aria-label={available ? `${label}: ${value}` : `${label}: not available yet`}>{available ? value : '—'}</p>
      {hint && <p className="stat__hint">{hint}</p>}
    </div>
  );
}
