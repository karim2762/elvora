import { statusMeta } from '../../config/applications';

// Colour + icon + text, so the status never relies on colour alone.
export default function StatusBadge({ status }) {
  const { label, tone, icon: Icon } = statusMeta(status);
  return <span className={`status status--${tone}`}><Icon size={14} aria-hidden="true" />{label}</span>;
}
