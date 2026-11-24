import { fmtPhone } from '../../lib/format';

// Read-only list of what the student entered. Used on the review step and on the application detail page.
const Row = ({ label, children, full }) => (
  <div className={`review__row ${full ? 'review__row--full' : ''}`}><dt>{label}</dt><dd>{children}</dd></div>
);

export default function ReviewList({ responses: r }) {
  return (
    <div className="review">
      <section aria-labelledby="rv-applicant">
        <h3 id="rv-applicant" className="review__h">Applicant</h3>
        <dl className="review__grid">
          <Row label="Full name">{r.fullName}</Row>
          <Row label="Registered email">{r.email}</Row>
          <Row label="Mobile number">{fmtPhone(r.phone)}</Row>
        </dl>
      </section>
      <section aria-labelledby="rv-edu">
        <h3 id="rv-edu" className="review__h">Education</h3>
        <dl className="review__grid">
          <Row label="College / University" full>{r.college}</Row>
          <Row label="Degree">{r.degree}</Row>
          <Row label="Branch / Department">{r.branch}</Row>
          <Row label="Academic year">{r.academicYear}</Row>
        </dl>
      </section>
      <section aria-labelledby="rv-skills">
        <h3 id="rv-skills" className="review__h">Skills and motivation</h3>
        <dl className="review__grid">
          <Row label="Technical skills" full><ul className="chips">{r.skills.map((s) => <li key={s} className="skill-chip">{s}</li>)}</ul></Row>
          <Row label="Why do you want to join this internship?" full><p className="review__text">{r.motivation}</p></Row>
        </dl>
      </section>
    </div>
  );
}
