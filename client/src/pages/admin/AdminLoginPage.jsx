import { useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Mail, Lock, ShieldCheck, Loader2, AlertCircle } from 'lucide-react';
import AuthShell from '../../components/forms/AuthShell';
import { TextField, PasswordField } from '../../components/forms/Field';
import PageLoader from '../../components/PageLoader';
import { useAuth } from '../../auth/AuthContext';
import { useForm } from '../../hooks/useForm';
import { usePageMeta } from '../../hooks/usePageMeta';
import { adminRoutes } from '../../config/admin';
import { studentRoutes } from '../../config/dashboard';

const FIELDS = ['email', 'password'];

// Administrator sign-in. There is no sign-up here: administrator accounts are authorized on the server (npm run admin:create).
export default function AdminLoginPage() {
  usePageMeta('Administrator sign in');
  const { isAuthenticated, isAdmin, loading, adminLogin } = useAuth();
  const f = useForm({ email: '', password: '' }, FIELDS);
  const formRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setFormError('');
    const errs = {};
    if (!f.values.email.trim()) errs.email = 'Email is required';
    if (!f.values.password) errs.password = 'Password is required';
    if (Object.keys(errs).length) { formRef.current?.querySelector(`[name="${f.setServerErrors(errs)}"]`)?.focus(); return; }
    setSubmitting(true);
    try { await adminLogin({ email: f.values.email.trim(), password: f.values.password, remember: false }); }
    catch (err) { setFormError(err.status === 429 ? err.message : err.status === 0 ? err.message : err.status === 401 ? 'Incorrect email or password, or this account is not an administrator.' : 'Could not sign in. Please try again.'); }
    finally { setSubmitting(false); }
  }

  if (loading) return <PageLoader />;
  if (isAuthenticated && isAdmin) return <Navigate to={adminRoutes.overview} replace />;
  const p = (name) => ({ name, value: f.values[name], onChange: f.setField, onBlur: undefined, error: f.errors[name] });
  return (
    <AuthShell title="Administrator sign in" subtitle="Restricted area. Authorized ELVORA administrators only."
      footer={<>Student? <Link to="/login">Go to student login</Link></>}>
      {isAuthenticated && !isAdmin && <div className="form-alert" role="status"><AlertCircle size={18} aria-hidden="true" />You are signed in as a student. Sign in below with an administrator account to continue. <Link to={studentRoutes.overview}>Back to my dashboard</Link></div>}
      <form ref={formRef} onSubmit={onSubmit} noValidate aria-busy={submitting}>
        {formError && <div className="form-alert" role="alert"><AlertCircle size={18} aria-hidden="true" />{formError}</div>}
        <div className="form-stack">
          <TextField label="Email address" icon={Mail} type="email" inputMode="email" autoComplete="username" autoCapitalize="none" {...p('email')} />
          <PasswordField label="Password" icon={Lock} autoComplete="current-password" {...p('password')} />
        </div>
        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={submitting}>
          {submitting ? <><Loader2 className="spin-icon" size={18} aria-hidden="true" />Signing in…</> : <>Sign in<ShieldCheck size={18} aria-hidden="true" /></>}
        </button>
        <p className="form-note">The session ends when you close the browser or after 24 hours.</p>
      </form>
    </AuthShell>
  );
}
