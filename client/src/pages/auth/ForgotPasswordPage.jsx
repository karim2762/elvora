import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Send, Loader2, AlertCircle, MailCheck, MailX } from 'lucide-react';
import AuthShell from '../../components/forms/AuthShell';
import { TextField } from '../../components/forms/Field';
import { useToast } from '../../components/ui/Toast';
import { usePageMeta } from '../../hooks/usePageMeta';
import { rules } from '../../lib/validation';
import { forgotPassword } from '../../services/authService';

export default function ForgotPasswordPage() {
  usePageMeta('Forgot password');
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setFormError('');
    const err = rules.email(email);
    setError(err);
    if (err) { e.currentTarget.elements.email?.focus(); return; }
    setSubmitting(true);
    try {
      const res = await forgotPassword(email.trim());
      setResult(res);
      // Never claim success when the server says email isn't set up.
      if (res.emailDelivery === 'enabled') toast.success('If that account exists, we’ll email a reset link.');
      else toast.info('Email delivery isn’t configured, so no email was sent.');
    } catch (e2) {
      const msg = e2.data?.error?.fields?.email || e2.message || 'Something went wrong. Please try again.';
      setFormError(msg); toast.error(msg);
    } finally { setSubmitting(false); }
  }

  if (result) {
    const sent = result.emailDelivery === 'enabled';
    return (
      <AuthShell title={sent ? 'Check your inbox' : 'Email isn’t set up yet'}>
        <div className={`status-panel ${sent ? 'status-panel--ok' : 'status-panel--warn'}`} role="status">
          {sent ? <MailCheck size={28} aria-hidden="true" /> : <MailX size={28} aria-hidden="true" />}
          <p>{result.message}</p>
        </div>
        {sent && <p className="form-note">Didn’t get it? Check your spam folder, or <button type="button" className="link link--btn" onClick={() => setResult(null)}>try again</button>. The link expires in about 30 minutes and works only once.</p>}
        <Link className="btn btn--secondary btn--block" to="/login">Back to log in</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Forgot your password?" subtitle="Enter the email you registered with and we’ll send you a link to choose a new one."
      footer={<>Remembered it? <Link to="/login">Log in</Link></>}>
      <form onSubmit={onSubmit} noValidate aria-busy={submitting}>
        {formError && <div className="form-alert" role="alert"><AlertCircle size={18} aria-hidden="true" />{formError}</div>}
        <div className="form-stack">
          <TextField label="Email address" name="email" icon={Mail} type="email" inputMode="email" autoComplete="email" autoCapitalize="none"
            placeholder="you@example.com" value={email} error={error}
            onChange={(_, v) => { setEmail(v); if (error) setError(rules.email(v)); }} onBlur={() => email && setError(rules.email(email))} />
        </div>
        <button className="btn btn--primary btn--lg btn--block" type="submit" disabled={submitting}>
          {submitting ? <><Loader2 className="spin-icon" size={18} aria-hidden="true" />Sending…</> : <>Send reset link<Send size={18} aria-hidden="true" /></>}
        </button>
      </form>
    </AuthShell>
  );
}
