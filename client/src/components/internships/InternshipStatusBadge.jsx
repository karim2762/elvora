import { internshipStatusMeta } from '../../config/internshipStatus';

// Colour + icon + text, so the status never relies on colour alone.
export default function InternshipStatusBadge({ status }) {
  const { label, tone, icon: Icon } = internshipStatusMeta(status);
  return <span className={`status status--${tone}`}><Icon size={14} aria-hidden="true" />{label}</span>;
}
