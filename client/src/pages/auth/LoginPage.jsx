import { useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, LogIn, Loader2, AlertCircle } from 'lucide-react';
import AuthShell, { RedirectNotice } from '../../components/forms/AuthShell';
import { TextField, PasswordField } from '../../components/forms/Field';
import PageLoader from '../../components/PageLoader';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../auth/AuthContext';
import { useForm } from '../../hooks/useForm';
import { usePageMeta } from '../../hooks/usePageMeta';
import { safeRedirect, signupLink } from '../../lib/applyLinks';

const FIELDS = ['email', 'password'];

export default function LoginPage() {
  usePageMeta('Log in');
  const [params] = useSearchParams();
  const target = safeRedirect(params.get('redirect'), '/profile');
  const { isAuthenticated, loading, login } = useAuth();
  const toast = useToast();
  const f = useForm({ email: '', password: '' }, FIELDS);
  const formRef = useRef(null);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setFormError('');
    const errs = {};
    if (!f.values.email.trim()) errs.email = 'Email is required';
    if (!f.values.password) errs.password = 'Password is required';
    if (Object.keys(errs).length) {
      const first = f.setServerErrors(errs);
      formRef.current?.querySelector(`[name="${first}"]`)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const user = await login({ email: f.values.email.trim(), password: f.values.password, remember });
      toast.success(`Welcome back, ${user.fullName.split(' ')[0]}!`);
    } catch (err) {
      const msg = err.message || 'Could not log in. Please try again.';
      setFormError(msg);
      if (err.status !== 401) toast.error(msg);
    } finally { setSubmitting(false); }
  }

  if (loading) return <PageLoader />;
  if (isAuthenticated) return <Navigate to={target} replace />;

  const p = (name) => ({ name, value: f.values[name], onChange: f.setField, onBlur: undefined, error: f.errors[name] });
  return (
    <AuthShell title="Welcome back" subtitle="Log in to manage your ELVORA student profile."
      footer={<>New to ELVORA? <Link to={signupLink(target)}>Create an account</Link></>}>
      <RedirectNotice />
      <form ref={formRef} onSubmit={onSubmit} noValidate aria-busy={submitting}>
        {formError && <div className="form-alert" role="alert"><AlertCircle size={18} aria-hidden="true" />{formError}</div>}
        <div className="form-stack">
          <TextField label="Email address" icon={Mail} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" placeholder="you@example.com" {...p('email')} />
          <PasswordField label="Password" icon={Lock} autoComplete="current-password" {...p('password')} />
        </div>
        <div className="form-row">
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span className="check__box" aria-hidden="true" />
            <span>Remember me</span>
          </label>
          <Link className="link" to="/forgot-password">Forgot password?</Link>
        </div>
        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={submitting}>
          {submitting ? <><Loader2 className="spin-icon" size={18} aria-hidden="true" />Logging in…</> : <>Log in<LogIn size={18} aria-hidden="true" /></>}
        </button>
        <p className="form-note">{remember ? 'You’ll stay signed in on this device for up to 30 days.' : 'You’ll be signed out when you close the browser or after 24 hours.'} Don’t use “Remember me” on shared computers.</p>
      </form>
    </AuthShell>
  );
}
