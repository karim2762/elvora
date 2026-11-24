import { BadgeCheck, Clock3, CircleAlert, Link2Off, ShieldOff, RefreshCw, CircleSlash } from 'lucide-react';

// One badge for repository verification (NOT academic approval). The label and wording come from the server.
const ICON = { verified: BadgeCheck, pending_verification: Clock3, verification_failed: CircleAlert, access_revoked: ShieldOff, repository_unavailable: CircleSlash, evidence_outdated: RefreshCw, not_linked: Link2Off };
export default function VerificationBadge({ verification, className = '' }) {
  if (!verification) return null;
  const Icon = ICON[verification.state] ?? Clock3;
  return <span className={`status status--${verification.tone ?? 'slate'} vbadge ${className}`}><Icon size={14} aria-hidden="true" />{verification.label}</span>;
}
