import { isDemoData } from '../../services/internshipService';

// Honest labeling: shown whenever the app is serving built-in demo internships.
export default function DemoNotice() {
  if (!isDemoData) return null;
  return <p className="notice" role="note">Demo data: these internships are sample records for development, not real openings.</p>;
}
