import { Link } from 'react-router-dom';
import { usePageMeta } from '../hooks/usePageMeta';

function Placeholder({ title, text, children }) {
  usePageMeta(title);
  return (
    <section className="section container container--narrow state-box">
      <h1>{title}</h1>
      <p className="text-muted">{text}</p>
      {children}
      <p><Link className="btn btn--secondary" to="/">Back to home</Link></p>
    </section>
  );
}
const later = 'This page is a placeholder and will be built in a later stage.';

export const PrivacyPage = () => <Placeholder title="Privacy Policy" text={`${later} The policy text will be added before launch.`} />;
export const TermsPage = () => <Placeholder title="Terms and Conditions" text={`${later} The terms will be added before launch.`} />;
export const NotFoundPage = () => <Placeholder title="Page not found" text="The page you are looking for does not exist." />;
