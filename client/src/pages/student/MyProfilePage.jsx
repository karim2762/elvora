import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { User, Pencil, Mail, Phone, Building2, GraduationCap, Layers, CalendarDays, Github, Linkedin, Code2, Loader2, AlertCircle, Save, X, Lock, ShieldCheck, LogOut, CircleDashed } from 'lucide-react';
import { AcademicFields, ProfessionalFields } from '../../components/forms/StudentFields';
import { TextField } from '../../components/forms/Field';
import { LoadError } from '../../components/dashboard/PageStates';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../auth/AuthContext';
import { useForm } from '../../hooks/useForm';
import { useRemote } from '../../hooks/useApplications';
import { useSessionExpiry } from '../../hooks/useSessionExpiry';
import { usePageMeta } from '../../hooks/usePageMeta';
import { PROFILE_FIELDS } from '../../lib/validation';
import { getStudentProfile, patchStudentProfile } from '../../services/studentService';
import { fmtDate, fmtPhone } from '../../lib/format';
import { initials } from '../../lib/names';

const toForm = (u) => ({
  fullName: u.fullName, phone: /^0+$/.test(String(u.phone ?? '')) ? '' : u.phone, college: u.college, degree: u.degree, branch: u.branch,
  academicYear: u.academicYear, graduationYear: String(u.graduationYear), skills: u.skills, github: u.github, linkedin: u.linkedin,
});

const Item = ({ icon: Icon, label, children }) => (
  <div className="info"><dt><Icon size={16} aria-hidden="true" />{label}</dt><dd>{children || <span className="info__empty">Not added</span>}</dd></div>
);

function CompletionRing({ percent }) {
  const r = 34, c = 2 * Math.PI * r;
  return (
    <div className="ring" role="img" aria-label={`Profile ${percent}% complete`}>
      <svg viewBox="0 0 80 80" aria-hidden="true"><circle className="ring__track" cx="40" cy="40" r={r} /><circle className="ring__value" cx="40" cy="40" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - percent / 100)} /></svg>
      <span>{percent}%</span>
    </div>
  );
}

function Editor({ profile, onSaved, onCancel }) {
  const toast = useToast();
  const { setUser } = useAuth();
  const f = useForm(toForm(profile), PROFILE_FIELDS);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const formRef = useRef(null);
  const focusField = (n) => formRef.current?.querySelector(`[name="${n}"]`)?.focus();

  async function onSave(e) {
    e.preventDefault();
    if (saving) return;
    setFormError('');
    const first = f.validateAll();
    if (first) { setFormError('Please fix the highlighted fields.'); focusField(first); return; }
    setSaving(true);
    try {
      const v = f.values;
      // Success is shown only after the server has saved and returned the stored profile.
      const updated = await patchStudentProfile({ ...v, fullName: v.fullName.trim(), college: v.college.trim(), branch: v.branch.trim(), graduationYear: Number(v.graduationYear) });
      setUser(updated);
      onSaved(updated);
      toast.success('Profile updated.');
    } catch (err) {
      if (err.status === 401) { setUser(null); return; }
      const fields = err.data?.error?.fields;
      if (fields) { const f2 = f.setServerErrors(fields); if (f2) focusField(f2); }
      const msg = err.status === 0 ? err.message : (err.message || 'Could not save your changes.');
      setFormError(msg); toast.error(msg);
    } finally { setSaving(false); }
  }

  return (
    <form ref={formRef} className="card stu__form" onSubmit={onSave} noValidate aria-busy={saving}>
      {formError && <div className="form-alert" role="alert"><AlertCircle size={18} aria-hidden="true" />{formError}</div>}
      <fieldset className="form-section">
        <legend>Personal</legend>
        <div className="form-grid">
          <TextField label="Full name" name="fullName" icon={User} autoComplete="name" value={f.values.fullName} onChange={f.setField} onBlur={f.blur} error={f.errors.fullName} />
          <TextField label="Mobile number" name="phone" icon={Phone} type="tel" inputMode="tel" autoComplete="tel-national" value={f.values.phone} onChange={f.setField} onBlur={f.blur} error={f.errors.phone} hint="Indian mobile number. +91 is optional." />
          <div className="form-grid__full"><TextField label="Email address" name="email" icon={Lock} value={profile.email} onChange={() => {}} disabled readOnly hint="Email can’t be changed here." /></div>
        </div>
      </fieldset>
      <fieldset className="form-section"><legend>Academic</legend><AcademicFields f={f} /></fieldset>
      <fieldset className="form-section"><legend>Additional</legend><ProfessionalFields f={f} /></fieldset>
      <div className="form-actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={saving}><X size={18} aria-hidden="true" />Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={saving}>{saving ? <><Loader2 className="spin-icon" size={18} aria-hidden="true" />Saving…</> : <><Save size={18} aria-hidden="true" />Save changes</>}</button>
      </div>
    </form>
  );
}

export default function MyProfilePage() {
  usePageMeta('My Profile');
  const { status, data, error, reload } = useRemote(getStudentProfile, []);
  const expired = useSessionExpiry(status, error);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(null); // the profile as returned by the last successful save
  const { logout } = useAuth();
  const toast = useToast();
  async function onLogout() {
    try { await logout(); toast.success('You’ve been logged out.'); } catch { toast.error('Could not log out. Please try again.'); }
  }
  if (expired) return null;
  if (status === 'loading') return <div className="stu" aria-busy="true" aria-label="Loading your profile"><div className="card stu__card" aria-hidden="true"><i className="sk sk--title" /><i className="sk sk--line" /><i className="sk sk--line sk--short" /></div></div>;
  if (status === 'error') return <div className="stu"><LoadError title="We couldn’t load your profile" error={error} onRetry={reload} /></div>;

  const p = saved ?? data;
  return (
    <div className="stu">
      <header className="card stu__id">
        <div className="avatar" aria-hidden="true">{initials(p.fullName)}</div>
        <div className="stu__idtext"><span className="eyebrow">Student profile</span><h1>{p.fullName}</h1><p className="text-muted">{p.email} · Member since {fmtDate(p.createdAt)}</p></div>
        <div className="stu__actions">
          {!editing && <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing(true)}><Pencil size={16} aria-hidden="true" />Edit profile</button>}
          <button type="button" className="btn btn--secondary btn--sm" onClick={onLogout}><LogOut size={16} aria-hidden="true" />Log out</button>
        </div>
      </header>

      <aside className="card completion stu__completion">
        <CompletionRing percent={p.profileCompletion.percent} />
        <div>
          <h2 className="completion__title">Profile completion</h2>
          {p.profileCompletion.percent === 100 ? <p className="text-muted">Your profile is complete.</p> : <p className="text-muted">Add {p.profileCompletion.missing.join(', ')} to reach 100%.</p>}
        </div>
      </aside>

      {editing ? <Editor profile={p} onSaved={(u) => { setSaved(u); setEditing(false); }} onCancel={() => setEditing(false)} /> : (
        <>
          <section className="card stu__card" aria-labelledby="pp-h"><h2 id="pp-h" className="stu__h">Personal details</h2>
            <dl className="info-grid"><Item icon={User} label="Full name">{p.fullName}</Item><Item icon={Mail} label="Email">{p.email}</Item><Item icon={Phone} label="Mobile number">{fmtPhone(p.phone)}</Item></dl></section>
          <section className="card stu__card" aria-labelledby="pa-h"><h2 id="pa-h" className="stu__h">Academic details</h2>
            <dl className="info-grid"><Item icon={Building2} label="College / University">{p.college}</Item><Item icon={GraduationCap} label="Degree">{p.degree}</Item><Item icon={Layers} label="Branch / Department">{p.branch}</Item><Item icon={CalendarDays} label="Academic year">{p.academicYear}</Item><Item icon={CalendarDays} label="Graduation year">{p.graduationYear}</Item></dl></section>
          <section className="card stu__card" aria-labelledby="pd-h"><h2 id="pd-h" className="stu__h">Additional details</h2>
            <dl className="info-grid">
              <div className="info info--full"><dt><Code2 size={16} aria-hidden="true" />Skills</dt><dd>{p.skills.length ? <ul className="chips">{p.skills.map((s) => <li key={s} className="skill-chip">{s}</li>)}</ul> : <span className="info__empty">Not added</span>}</dd></div>
              <Item icon={Github} label="GitHub">{p.github && <a className="link" href={p.github} target="_blank" rel="noopener noreferrer">{p.github.replace('https://', '')}</a>}</Item>
              <Item icon={Linkedin} label="LinkedIn">{p.linkedin && <a className="link" href={p.linkedin} target="_blank" rel="noopener noreferrer">{p.linkedin.replace('https://www.', '')}</a>}</Item>
            </dl></section>
          <p className="form-note"><CircleDashed size={14} aria-hidden="true" /> Looking for internships? <Link className="link" to="/internships">Browse listings</Link> or <Link className="link" to="/student/applications">view your applications</Link>.</p>
          <p className="track__note"><ShieldCheck size={14} aria-hidden="true" />ELVORA never asks for Aadhaar or bank details.</p>
        </>
      )}
    </div>
  );
}
