import { BadgeCheck, Hourglass } from 'lucide-react';
import Reveal from '../../../components/ui/Reveal';
import { msme } from '../../../config/site';

// Shows a verified badge ONLY when verified === true and a number is configured.
export default function Msme() {
  const verified = msme.verified && msme.registrationNumber;
  return (
    <section className="section container" id="verification" aria-labelledby="msme-title">
      <Reveal className={`msme ${verified ? 'msme--ok' : ''}`}>
        <span className="msme__icon">{verified ? <BadgeCheck size={30} aria-hidden="true" /> : <Hourglass size={28} aria-hidden="true" />}</span>
        <div>
          <h2 id="msme-title">Committed to Building Career Opportunities.</h2>
          {verified ? (
            <p className="text-muted">MSME / Udyam registration: <strong>{msme.registrationNumber}</strong>{msme.verifyUrl && <> · <a href={msme.verifyUrl} target="_blank" rel="noopener noreferrer">Verify</a></>}</p>
          ) : (
            <p className="text-muted">Organization verification details will be displayed here after official registration.</p>
          )}
        </div>
      </Reveal>
    </section>
  );
}
