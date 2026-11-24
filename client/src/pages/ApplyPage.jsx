import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Loader2, Lock, Pencil, Send, AlertCircle } from 'lucide-react';
import { NamePhoneFields, AcademicFields } from '../components/forms/StudentFields';
import { TextField, SkillsInput, TextAreaField } from '../components/forms/Field';
import InternshipSummary from '../components/applications/InternshipSummary';
import ReviewList from '../components/applications/ReviewList';
import PageLoader from '../components/PageLoader';
import Button from '../components/ui/Button';
import { ErrorState } from '../components/internships/ListingStates';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../auth/AuthContext';
import { useForm } from '../hooks/useForm';
import { usePageMeta } from '../hooks/usePageMeta';
import { useInternship } from '../hooks/useInternships';
import { useAllMyApplications } from '../hooks/useApplications';
import { isValidPhone, APPLICATION_FIELDS, MOTIVATION_MAX, MOTIVATION_MIN, applicationRules, tidyMotivation } from '../lib/validation';
import { applicationPath, applicationSubmittedPath, applyPath, detailPath, loginLink } from '../lib/applyLinks';
import { effectiveStatus } from '../lib/internshipFilters';
import { submitApplication } from '../services/applicationService';
import { currentUser } from '../services/authService';
import { routes } from '../config/site';

// Only the account identity (name, mobile) is pre-filled. Education, skills and motivation start empty so
// nothing is submitted by accident. Set to true to pre-fill education and skills from the profile again.
const PREFILL_EDUCATION_FROM_PROFILE = false;
const initialValues = (u) => ({
  fullName: u.fullName ?? '', phone: isValidPhone(u.phone ?? '') ? u.phone : '', // placeholder numbers (e.g. 0000000000 on admin-created accounts) are never pre-filled
  college: PREFILL_EDUCATION_FROM_PROFILE ? (u.college ?? '') : '',
  degree: PREFILL_EDUCATION_FROM_PROFILE ? (u.degree ?? '') : '',
  branch: PREFILL_EDUCATION_FROM_PROFILE ? (u.branch ?? '') : '',
  academicYear: PREFILL_EDUCATION_FROM_PROFILE ? (u.academicYear ?? '') : '',
  skills: PREFILL_EDUCATION_FROM_PROFILE ? (u.skills ?? []) : [],
  motivation: '',
});
const STEPS = [{ key: 'details', label: 'Your details' }, { key: 'review', label: 'Review and submit' }];

function Stepper({ step }) {
  const at = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="stepper" aria-label="Application progress">
      {STEPS.map((s, i) => (
        <li key={s.key} className={i < at ? 'is-done' : i === at ? 'is-current' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="stepper__dot" aria-hidden="true">{i < at ? <Check size={14} /> : i + 1}</span>
          <span className="stepper__label">{s.label}{i < at && <span className="sr-only"> (completed)</span>}</span>
        </li>
      ))}
    </ol>
  );
}

function ApplicationForm({ user, item }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { setUser } = useAuth();
  const f = useForm(initialValues(user), APPLICATION_FIELDS, applicationRules);
  const [step, setStep] = useState('details');
  const [agree, setAgree] = useState({ terms: false, privacy: false });
  const [agreeErrors, setAgreeErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const rootRef = useRef(null);
  const headingRef = useRef(null);
  const agreeRef = useRef(null);
  const shownStep = useRef(step);

  // Moving between steps: bring the new heading into view and hand focus to it (keyboard and screen-reader friendly).
  // Compares against the step already shown, so it stays quiet on first render (also under StrictMode's double effect run).
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: 'start' });
  }, [step]);

  // Focus without letting the browser jump, then bring the field to the middle of the screen so the red mark and message are visible.
  const focusField = (name) => {
    const el = rootRef.current?.querySelector(`[name="${name}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    (el.closest('.field, .agree__item') ?? el).scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const p = (name) => ({ name, value: f.values[name], onChange: f.setField, onBlur: f.blur, error: f.errors[name] });

  function goReview(e) {
    e.preventDefault();
    const first = f.validateAll();
    if (first) { setFormError(''); focusField(first); return; }
    setFormError('');
    setStep('review');
  }

  // What the review step shows, and exactly what is sent. Never includes a student ID: the server uses the session.
  const v = f.values;
  const responses = {
    fullName: v.fullName.trim(), email: user.email, phone: v.phone.trim(), college: v.college.trim(), degree: v.degree,
    branch: v.branch.trim(), academicYear: v.academicYear, skills: v.skills, motivation: tidyMotivation(v.motivation),
  };

  async function onSubmit() {
    if (submitting) return;
    const errs = {};
    if (!agree.terms) errs.termsAccepted = 'Accept the Terms and Conditions to submit';
    if (!agree.privacy) errs.privacyAccepted = 'Agree to the Privacy Policy to submit';
    setAgreeErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('');
      const target = errs.termsAccepted ? 'terms' : 'privacy';
      agreeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      agreeRef.current?.querySelector(`[name="${target}"]`)?.focus({ preventScroll: true });
      return;
    }

    setSubmitting(true); setFormError('');
    try {
      const { email: _registeredEmail, ...body } = responses; // email comes from the server-side session, not from here
      const saved = await submitApplication({ internshipId: item.id, ...body, termsAccepted: true, privacyAccepted: true });
      currentUser().then(setUser).catch(() => {}); // the server may have updated the profile: refresh it
      navigate(applicationSubmittedPath(saved.id), { replace: true });
    } catch (err) {
      const info = err.data?.error;
      if (err.status === 401) { toast.error('Your session has expired. Please sign in again.'); setUser(null); return; }
      if (err.status === 409 && info?.code === 'ALREADY_APPLIED' && info.details?.applicationId) {
        toast.info('You have already applied for this internship.');
        navigate(applicationPath(info.details.applicationId), { replace: true });
        return;
      }
      if (info?.fields) {
        const { termsAccepted, privacyAccepted, ...fieldErrors } = info.fields;
        setAgreeErrors({ termsAccepted, privacyAccepted });
        if (Object.keys(fieldErrors).length) { setStep('details'); const first = f.setServerErrors(fieldErrors); if (first) setTimeout(() => focusField(first), 0); }
      }
      const msg = info?.message || err.message || 'We couldn’t submit your application. Please try again.';
      setFormError(msg);
      toast.error(msg);
    } finally { setSubmitting(false); }
  }

  return (
    <section className="app-scope apply container" ref={rootRef}>
      <Link className="back-link" to={detailPath(item.id)}><ArrowLeft size={16} aria-hidden="true" /> Back to internship</Link>
      <header className="apply__head">
        <h1>Apply for this internship</h1>
        <Stepper step={step} />
      </header>

      <div className="apply__grid">
        <div className="apply__main card" aria-busy={submitting}>
          {formError && <div className="form-alert" role="alert"><AlertCircle size={18} aria-hidden="true" />{formError}</div>}

          {step === 'details' ? (
            <form key="details" className="step-pane" onSubmit={goReview} noValidate>
              <h2 className="apply__h" ref={headingRef} tabIndex={-1}>Your details</h2>
              <p className="text-muted apply__lead">Fill in the details below. Your name and mobile number come from your account.</p>
              <fieldset className="form-section">
                <legend>About you</legend>
                <div className="form-grid">
                  <NamePhoneFields f={f} />
                  <div className="form-grid__full">
                    <TextField label="Registered email" name="email" icon={Lock} value={user.email} onChange={() => {}} disabled readOnly hint="Your account email. It can’t be changed here." />
                  </div>
                </div>
              </fieldset>
              <fieldset className="form-section">
                <legend>Education</legend>
                <AcademicFields f={f} omitGraduationYear />
              </fieldset>
              <fieldset className="form-section">
                <legend>Skills and motivation</legend>
                <div className="form-stack">
                  <SkillsInput label="Technical skills" optional={false} {...p('skills')} hint="Add the skills you already have. Press Enter or comma after each one." />
                  <TextAreaField label="Why do you want to join this internship?" maxLength={MOTIVATION_MAX} rows={6}
                    hint={`At least ${MOTIVATION_MIN} characters. Tell us what you want to learn and build.`} {...p('motivation')} />
                </div>
              </fieldset>
              <div className="form-actions">
                <Button to={detailPath(item.id)} variant="secondary">Cancel</Button>
                <button type="submit" className="btn btn--primary">Review application<ArrowRight size={18} aria-hidden="true" /></button>
              </div>
            </form>
          ) : (
            <div key="review" className="step-pane">
              <div className="apply__review-head">
                <div>
                  <h2 className="apply__h" ref={headingRef} tabIndex={-1}>Review your application</h2>
                  <p className="text-muted apply__lead">Check everything before you submit. You can’t edit an application after it’s submitted.</p>
                </div>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setStep('details')} disabled={submitting}><Pencil size={16} aria-hidden="true" />Edit details</button>
              </div>
              <ReviewList responses={responses} />

              <fieldset className={`agree ${agreeErrors.termsAccepted || agreeErrors.privacyAccepted ? 'agree--error' : ''}`} disabled={submitting} ref={agreeRef}>
                <legend className="sr-only">Agreements</legend>
                {[
                  { key: 'terms', err: 'termsAccepted', label: <>I accept the <Link className="link" to={routes.terms} target="_blank" rel="noopener noreferrer">Terms and Conditions</Link></> },
                  { key: 'privacy', err: 'privacyAccepted', label: <>I agree to the <Link className="link" to={routes.privacy} target="_blank" rel="noopener noreferrer">Privacy Policy</Link> and to ELVORA using my details to process this application</> },
                ].map(({ key, err, label }) => (
                  <div key={key} className={`agree__item ${agreeErrors[err] ? 'agree__item--error' : ''}`}>
                    <label className="check">
                      <input type="checkbox" name={key} checked={agree[key]} aria-invalid={agreeErrors[err] ? 'true' : undefined} aria-describedby={agreeErrors[err] ? `${key}-err` : undefined}
                        onChange={(e) => { setAgree((a) => ({ ...a, [key]: e.target.checked })); if (e.target.checked) setAgreeErrors((x) => ({ ...x, [err]: undefined })); }} />
                      <span className="check__box" aria-hidden="true" />
                      <span>{label}</span>
                    </label>
                    {agreeErrors[err] && <p className="field__error" id={`${key}-err`} role="alert">{agreeErrors[err]}</p>}
                  </div>
                ))}
              </fieldset>

              <div className="form-actions">
                <button type="button" className="btn btn--secondary" onClick={() => setStep('details')} disabled={submitting}><ArrowLeft size={18} aria-hidden="true" />Back</button>
                <button type="button" className="btn btn--primary" onClick={onSubmit} disabled={submitting}>
                  {submitting ? <><Loader2 className="spin-icon" size={18} aria-hidden="true" />Submitting…</> : <>Submit application<Send size={18} aria-hidden="true" /></>}
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="apply__aside"><InternshipSummary item={item} /></aside>
      </div>
    </section>
  );
}

const StateBox = ({ title, children }) => (
  <section className="section container container--narrow state-box app-scope"><h1>{title}</h1>{children}</section>
);

export default function ApplyPage() {
  const { id } = useParams();
  const { isAuthenticated, loading: authLoading, user } = useAuth();
  const { status, data: item, reload } = useInternship(id);
  const mine = useAllMyApplications(isAuthenticated);
  usePageMeta('Apply');

  if (authLoading) return <PageLoader />;
  // Signed out: go to login and come straight back to THIS internship's application afterwards.
  if (!isAuthenticated) return <Navigate to={loginLink(applyPath(id))} replace />;
  if (status === 'loading' || mine.status === 'loading') return <PageLoader />;
  if (status === 'error') return <div className="container section"><ErrorState onRetry={reload} /></div>;
  if (!item) return (
    <StateBox title="Internship not found">
      <p className="text-muted">We couldn’t find an internship with ID “{id}”. It may have been removed.</p>
      <Button to="/internships">Browse internships</Button>
    </StateBox>
  );

  // If the list couldn't load we still let them continue: the server rejects duplicates either way.
  const existing = Array.isArray(mine.data) ? mine.data.find((a) => a.internship.id === item.id) : undefined;
  if (existing) return (
    <StateBox title="You’ve already applied">
      <p className="text-muted">You applied for <strong>{item.title}</strong>. Each student can apply once per internship.</p>
      <p className="row" style={{ justifyContent: 'center' }}>
        <Button to={applicationPath(existing.id)}>View my application</Button>
        <Button to="/internships" variant="secondary">Browse internships</Button>
      </p>
    </StateBox>
  );
  if (effectiveStatus(item) !== 'open') return (
    <StateBox title="Applications are not open">
      <p className="text-muted"><strong>{item.title}</strong> is not accepting applications right now.</p>
      <p className="row" style={{ justifyContent: 'center' }}>
        <Button to={detailPath(item.id)} variant="secondary">Back to internship</Button>
        <Button to="/internships">Browse internships</Button>
      </p>
    </StateBox>
  );
  return <ApplicationForm user={user} item={item} />;
}
