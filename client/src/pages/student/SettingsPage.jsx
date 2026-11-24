import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, BellRing, CheckCircle2, KeyRound, Loader2, LogOut, Mail, ShieldCheck, UserRound } from 'lucide-react';
import { PasswordField } from '../../components/forms/Field';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/ui/Toast';
import { useForm } from '../../hooks/useForm';
import { usePageMeta } from '../../hooks/usePageMeta';
import { rules } from '../../lib/validation';
import { changePassword } from '../../services/studentService';
import { fmtDate } from '../../lib/format';

// Same strength rule as sign-up; the server re-checks everything (and verifies the current password).
const pwRules = {
  currentPassword: (v) => (v ? '' : 'Enter your current password'),
  newPassword: (v, all) => rules.password(v) || (v === all.currentPassword ? 'Choose a password different from your current one' : ''),
  confirmPassword: (v, all) => (!v ? 'Confirm your new password' : v !== all.newPassword ? 'Passwords do not match' : ''),
};
const PW_FIELDS = ['currentPassword', 'newPassword', 'confirmPassword'];
const EMPTY = { currentPassword: '', newPassword: '', confirmPassword: '' };

function PasswordForm() {
  const { setUser } = useAuth();
  const toast = useToast();
  const f = useForm(EMPTY, PW_FIELDS, pwRules);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [done, setDone] = useState('');
  const ref = useRef(null);
  const focusField = (n) => ref.current?.querySelector(`[name="${n}"]`)?.focus();

  async function onSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setFormError(''); setDone('');
    const first = f.validateAll();
    if (first) { setFormError('Please fix the highlighted fields.'); focusField(first); return; }
    setSaving(true);
    try {
      const r = await changePassword(f.values); // success only after the server has verified and saved
      f.reset(EMPTY);
      setDone(r.message || 'Password updated.');
      toast.success('Password updated.');
    } catch (err) {
      if (err.status === 401) { setUser(null); return; }
      const fields = err.data?.error?.fields;
      if (fields) { const f2 = f.setServerErrors(fields); if (f2) focusField(f2); }
      const msg = err.status === 429 ? 'Too many incorrect attempts. Please wait a few minutes and try again.' : err.message || 'Could not change your password.';
      setFormError(msg);
    } finally { setSaving(false); }
  }
  const p = (name) => ({ name, value: f.values[name], onChange: f.setField, onBlur: f.blur, error: f.errors[name] });
  return (
    <form ref={ref} onSubmit={onSubmit} noValidate aria-busy={saving} className="stu__pw">
      {formError && <div className="form-alert" role="alert"><AlertCircle size={18} aria-hidden="true" />{formError}</div>}
      {done && <div className="form-ok" role="status"><CheckCircle2 size={18} aria-hidden="true" />{done}</div>}
      <PasswordField label="Current password" icon={KeyRound} autoComplete="current-password" {...p('currentPassword')} />
      <PasswordField label="New password" icon={KeyRound} autoComplete="new-password" showStrength {...p('newPassword')} />
      <PasswordField label="Confirm new password" icon={KeyRound} autoComplete="new-password" {...p('confirmPassword')} />
      <div className="form-actions">
        <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? <><Loader2 className="spin-icon" size={18} aria-hidden="true" />Updating…</> : 'Update password'}</button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  usePageMeta('Settings');
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [leaving, setLeaving] = useState(false);

  async function onLogout() {
    setLeaving(true);
    try { await logout(); } catch { /* the session is cleared locally either way */ }
    navigate('/login', { replace: true });
    toast.success('You’ve been logged out.');
  }

  return (
    <div className="stu">
      <header className="stu__head"><h1>Settings</h1><p className="text-muted">Manage your account and security.</p></header>

      <section className="card stu__card" aria-labelledby="acc-h">
        <h2 id="acc-h" className="stu__h"><UserRound size={18} aria-hidden="true" />Account information</h2>
        <dl className="info-grid">
          <div className="info"><dt>Name</dt><dd>{user.fullName}</dd></div>
          <div className="info"><dt><Mail size={16} aria-hidden="true" />Email</dt><dd>{user.email}</dd></div>
          <div className="info"><dt>Member since</dt><dd>{fmtDate(user.createdAt)}</dd></div>
        </dl>
        <p className="text-muted stu__fine">Your email is your sign-in and can’t be changed here. Update your other details in My Profile.</p>
      </section>

      <section className="card stu__card" aria-labelledby="pw-h">
        <h2 id="pw-h" className="stu__h"><ShieldCheck size={18} aria-hidden="true" />Change password</h2>
        <p className="text-muted stu__fine">After changing it, your other devices are signed out.</p>
        <PasswordForm />
      </section>

      <section className="card stu__card" aria-labelledby="np-h">
        <h2 id="np-h" className="stu__h"><BellRing size={18} aria-hidden="true" />Notification preferences</h2>
        <p className="text-muted stu__fine">Notification preferences can’t be customised yet. All updates appear in your Notifications page.</p>
      </section>

      <section className="card stu__card stu__logout" aria-labelledby="lo-h">
        <div><h2 id="lo-h" className="stu__h">Log out</h2><p className="text-muted stu__fine">End your session on this device.</p></div>
        <button type="button" className="btn btn--secondary" onClick={onLogout} disabled={leaving}>{leaving ? <Loader2 className="spin-icon" size={18} aria-hidden="true" /> : <LogOut size={18} aria-hidden="true" />}Log out</button>
      </section>
    </div>
  );
}
