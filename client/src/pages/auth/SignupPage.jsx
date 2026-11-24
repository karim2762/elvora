import { useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, User, Phone, UserPlus, Loader2, AlertCircle } from 'lucide-react';
import AuthShell, { RedirectNotice } from '../../components/forms/AuthShell';
import { TextField, PasswordField } from '../../components/forms/Field';
import { AcademicFields, ProfessionalFields } from '../../components/forms/StudentFields';
import PageLoader from '../../components/PageLoader';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../auth/AuthContext';
import { useForm } from '../../hooks/useForm';
import { usePageMeta } from '../../hooks/usePageMeta';
import { SIGNUP_FIELDS } from '../../lib/validation';
import { safeRedirect, loginLink } from '../../lib/applyLinks';

const initial = {
  fullName: '', email: '', phone: '', password: '', confirmPassword: '',
  college: '', degree: '', branch: '', academicYear: '', graduationYear: '',
  skills: [], github: '', linkedin: '',
};

export default function SignupPage() {
  usePageMeta('Sign up');
  const [params] = useSearchParams();
  const redirect = params.get('redirect');
  const target = safeRedirect(redirect, '/profile');
  const { isAuthenticated, loading, register } = useAuth();
  const toast = useToast();
  const f = useForm(initial, SIGNUP_FIELDS);
  const formRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const focusField = (name) => formRef.current?.querySelector(`[name="${name}"]`)?.focus();

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setFormError('');
    const firstInvalid = f.validateAll();
    if (firstInvalid) { setFormError('Please fix the highlighted fields.'); focusField(firstInvalid); return; }
    setSubmitting(true);
    try {
      const v = f.values;
      const user = await register({
        ...v, fullName: v.fullName.trim(), email: v.email.trim(), graduationYear: Number(v.graduationYear),
        college: v.college.trim(), branch: v.branch.trim(),
      });
      toast.success(`Welcome to ELVORA, ${user.fullName.split(' ')[0]}! Your account is ready.`);
      // AuthContext now has the user, so the guard below navigates to `target`.
    } catch (err) {
      const fields = err.data?.error?.fields;
      if (fields) { const first = f.setServerErrors(fields); if (first) focusField(first); }
      const msg = err.status === 409 ? 'An account with this email already exists.' : err.message || 'Something went wrong. Please try again.';
      setFormError(msg);
      toast.error(msg);
    } finally { setSubmitting(false); }
  }

  if (loading) return <PageLoader />;
  if (isAuthenticated) return <Navigate to={target} replace />;

  const p = (name) => ({ name, value: f.values[name], onChange: f.setField, onBlur: f.blur, error: f.errors[name] });
  return (
    <AuthShell wide title="Start Your Journey With ELVORA"
      subtitle="Create your student account in a minute. You can finish optional details later."
      footer={<>Already have an account? <Link to={loginLink(target)}>Log in</Link></>}>
      <RedirectNotice />
      <form ref={formRef} onSubmit={onSubmit} noValidate aria-busy={submitting}>
        {formError && <div className="form-alert" role="alert"><AlertCircle size={18} aria-hidden="true" />{formError}</div>}

        <fieldset className="form-section">
          <legend>Personal information</legend>
          <div className="form-grid">
            <div className="form-grid__full"><PersonalFields p={p} /></div>
            <PasswordField label="Password" icon={Lock} autoComplete="new-password" showStrength {...p('password')} />
            <PasswordField label="Confirm password" icon={Lock} autoComplete="new-password" {...p('confirmPassword')} />
          </div>
        </fieldset>

        <fieldset className="form-section">
          <legend>Academic information</legend>
          <AcademicFields f={f} />
        </fieldset>

        <fieldset className="form-section">
          <legend>Optional</legend>
          <ProfessionalFields f={f} />
        </fieldset>

        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={submitting}>
          {submitting ? <><Loader2 className="spin-icon" size={18} aria-hidden="true" />Creating your account…</> : <>Create account<UserPlus size={18} aria-hidden="true" /></>}
        </button>
        <p className="form-note">By creating an account you agree to our <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy Policy</Link>. We never ask for Aadhaar or bank details.</p>
      </form>
    </AuthShell>
  );
}

// Name + email + phone in the order students expect.
function PersonalFields({ p }) {
  return (
    <div className="form-grid">
      <div className="form-grid__full"><TextField label="Full name" icon={User} autoComplete="name" placeholder="As on your college ID" {...p('fullName')} /></div>
      <TextField label="Email address" icon={Mail} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" placeholder="you@example.com" {...p('email')} />
      <TextField label="Mobile number" icon={Phone} type="tel" inputMode="tel" autoComplete="tel-national" placeholder="98765 43210" hint="Indian mobile number. +91 is optional." {...p('phone')} />
    </div>
  );
}
