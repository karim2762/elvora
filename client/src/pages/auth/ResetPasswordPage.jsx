import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Lock, KeyRound, Loader2, AlertCircle, CheckCircle2, LinkIcon } from 'lucide-react';
import AuthShell from '../../components/forms/AuthShell';
import { PasswordField } from '../../components/forms/Field';
import { useToast } from '../../components/ui/Toast';
import { useForm } from '../../hooks/useForm';
import { usePageMeta } from '../../hooks/usePageMeta';
import { resetPassword } from '../../services/authService';

const FIELDS = ['password', 'confirmPassword'];

export default function ResetPasswordPage() {
  usePageMeta('Reset password');
  const [params, setParams] = useSearchParams();
  const [token] = useState(() => params.get('token') || '');
  const toast = useToast();
  const f = useForm({ password: '', confirmPassword: '' }, FIELDS);
  const formRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [state, setState] = useState(token ? 'form' : 'invalid'); // form | done | invalid

  // Keep the token out of the address bar, history and any screenshots once we've read it.
  useEffect(() => { if (params.has('token')) setParams({}, { replace: true }); }, [params, setParams]);

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setFormError('');
    const first = f.validateAll();
    if (first) { formRef.current?.querySelector(`[name="${first}"]`)?.focus(); return; }
    setSubmitting(true);
    try {
      await resetPassword({ token, password: f.values.password, confirmPassword: f.values.confirmPassword });
      setState('done');
      toast.success('Password updated. You can now log in.');
    } catch (err) {
      if (err.data?.error?.code === 'RESET_TOKEN_INVALID' || err.data?.error?.fields?.token) { setState('invalid'); return; }
      const fields = err.data?.error?.fields;
      if (fields) f.setServerErrors(fields);
      const msg = err.message || 'Something went wrong. Please try again.';
      setFormError(msg); toast.error(msg);
    } finally { setSubmitting(false); }
  }

  if (state === 'done') {
    return (
      <AuthShell title="Password updated">
        <div className="status-panel status-panel--ok" role="status"><CheckCircle2 size={28} aria-hidden="true" /><p>Your password has been changed and you’ve been signed out on all devices.</p></div>
        <Link className="btn btn--primary btn--lg btn--block" to="/login">Log in</Link>
      </AuthShell>
    );
  }
  if (state === 'invalid') {
    return (
      <AuthShell title="This link can’t be used">
        <div className="status-panel status-panel--warn" role="alert"><LinkIcon size={28} aria-hidden="true" /><p>This reset link is invalid, has expired, or has already been used. Reset links work once and expire after a short time.</p></div>
        <Link className="btn btn--primary btn--lg btn--block" to="/forgot-password">Request a new link</Link>
      </AuthShell>
    );
  }

  const p = (name) => ({ name, value: f.values[name], onChange: f.setField, onBlur: f.blur, error: f.errors[name] });
  return (
    <AuthShell title="Choose a new password" subtitle="Pick something you don’t use anywhere else.">
      <form ref={formRef} onSubmit={onSubmit} noValidate aria-busy={submitting}>
        {formError && <div className="form-alert" role="alert"><AlertCircle size={18} aria-hidden="true" />{formError}</div>}
        <div className="form-stack">
          <PasswordField label="New password" icon={Lock} autoComplete="new-password" showStrength {...p('password')} />
          <PasswordField label="Confirm new password" icon={Lock} autoComplete="new-password" {...p('confirmPassword')} />
        </div>
        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={submitting}>
          {submitting ? <><Loader2 className="spin-icon" size={18} aria-hidden="true" />Updating…</> : <>Update password<KeyRound size={18} aria-hidden="true" /></>}
        </button>
      </form>
    </AuthShell>
  );
}
