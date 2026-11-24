import { useId, useState } from 'react';
import { Eye, EyeOff, X, Check, ChevronDown } from 'lucide-react';
import { passwordStrength } from '../../lib/validation';

// Every field: visible <label>, error text tied via aria-describedby, aria-invalid, 16px text (no iOS zoom).
function Shell({ id, label, optional, error, hint, icon: Icon, trailing, children }) {
  return (
    <div className={`field ${error ? 'field--error' : ''}`}>
      <label className="field__label" htmlFor={id}>{label}{optional && <span className="field__optional"> (optional)</span>}</label>
      <div className="field__control">
        {Icon && <Icon className="field__icon" size={18} aria-hidden="true" />}
        {children}
        {trailing}
      </div>
      {error ? <p className="field__error" id={`${id}-msg`}>{error}</p> : hint ? <p className="field__hint" id={`${id}-msg`}>{hint}</p> : null}
    </div>
  );
}

export function TextField({ label, name, value, onChange, onBlur, error, hint, icon, optional, type = 'text', ...rest }) {
  const id = useId();
  return (
    <Shell id={id} label={label} optional={optional} error={error} hint={hint} icon={icon}>
      <input id={id} name={name} type={type} value={value} className={icon ? 'has-icon' : ''}
        onChange={(e) => onChange(name, e.target.value)} onBlur={() => onBlur?.(name)}
        aria-invalid={error ? 'true' : undefined} aria-describedby={error || hint ? `${id}-msg` : undefined} {...rest} />
    </Shell>
  );
}

export function PasswordField({ label, name, value, onChange, onBlur, error, hint, icon, showStrength = false, ...rest }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const strength = showStrength ? passwordStrength(value) : null;
  return (
    <div className="field-wrap">
      <Shell id={id} label={label} error={error} hint={hint} icon={icon}
        trailing={(
          <button type="button" className="field__toggle" onClick={() => setShown((s) => !s)}
            aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}>
            {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </button>
        )}>
        <input id={id} name={name} type={shown ? 'text' : 'password'} value={value} className={`${icon ? 'has-icon' : ''} has-trailing`}
          onChange={(e) => onChange(name, e.target.value)} onBlur={() => onBlur?.(name)}
          aria-invalid={error ? 'true' : undefined} aria-describedby={error || hint ? `${id}-msg` : undefined}
          autoCapitalize="none" autoCorrect="off" spellCheck={false} {...rest} />
      </Shell>
      {strength && value && (
        <div className="strength" aria-live="polite">
          <div className="strength__bars" aria-hidden="true">
            {[1, 2, 3, 4].map((n) => <span key={n} className={`strength__bar ${strength.score >= n ? `on s${strength.score}` : ''}`} />)}
          </div>
          <p className={`strength__label s${strength.score}`}>Password strength: <strong>{strength.label}</strong></p>
          <ul className="strength__checks">
            {strength.checks.map((c) => (
              <li key={c.label} className={c.ok ? 'ok' : ''}>{c.ok ? <Check size={13} aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}{c.label}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SelectField({ label, name, value, onChange, onBlur, error, hint, options, placeholder = 'Select…', icon, ...rest }) {
  const id = useId();
  return (
    <Shell id={id} label={label} error={error} hint={hint} icon={icon}
      trailing={<ChevronDown className="field__chevron" size={18} aria-hidden="true" />}>
      <select id={id} name={name} value={value} className={`${icon ? 'has-icon' : ''} has-trailing ${value ? '' : 'is-placeholder'}`}
        onChange={(e) => onChange(name, e.target.value)} onBlur={() => onBlur?.(name)}
        aria-invalid={error ? 'true' : undefined} aria-describedby={error || hint ? `${id}-msg` : undefined} {...rest}>
        <option value="">{placeholder}</option>
        {options.map((o) => { const val = typeof o === 'object' ? o.value : o; const lab = typeof o === 'object' ? o.label : o; return <option key={val} value={val}>{lab}</option>; })}
      </select>
    </Shell>
  );
}

// Type a skill, press Enter or comma to add it; Backspace on an empty box removes the last one.
export function SkillsInput({ label = 'Technical skills', name = 'skills', value, onChange, onBlur, error, hint, optional = true }) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const add = (raw) => {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.some((s) => s.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(name, next); setDraft('');
  };
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); }
    else if (e.key === 'Backspace' && !draft && value.length) onChange(name, value.slice(0, -1));
  };
  return (
    <div className={`field ${error ? 'field--error' : ''}`}>
      <label className="field__label" htmlFor={id}>{label}{optional && <span className="field__optional"> (optional)</span>}</label>
      <div className="field__control field__control--chips">
        {value.map((s) => (
          <span key={s} className="skill-chip">{s}
            <button type="button" aria-label={`Remove ${s}`} onClick={() => onChange(name, value.filter((x) => x !== s))}><X size={13} aria-hidden="true" /></button>
          </span>
        ))}
        <input id={id} name={name} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
          onBlur={() => { add(draft); onBlur?.(name); }} placeholder={value.length ? '' : 'e.g. Python, React, SQL'}
          aria-invalid={error ? 'true' : undefined} aria-describedby={`${id}-msg`} enterKeyHint="done" />
      </div>
      <p className={error ? 'field__error' : 'field__hint'} id={`${id}-msg`}>{error || hint || 'Press Enter or comma after each skill.'}</p>
    </div>
  );
}

// Multi-line text with a live character counter (counts what you typed against the limit).
export function TextAreaField({ label, name, value, onChange, onBlur, error, hint, maxLength, rows = 6, ...rest }) {
  const id = useId();
  return (
    <div className={`field ${error ? 'field--error' : ''}`}>
      <label className="field__label" htmlFor={id}>{label}</label>
      <div className="field__control field__control--area">
        <textarea id={id} name={name} value={value} rows={rows} maxLength={maxLength}
          onChange={(e) => onChange(name, e.target.value)} onBlur={() => onBlur?.(name)}
          aria-invalid={error ? 'true' : undefined} aria-describedby={`${id}-msg`} {...rest} />
      </div>
      <div className="field__foot">
        {error ? <p className="field__error" id={`${id}-msg`}>{error}</p> : <p className="field__hint" id={`${id}-msg`}>{hint}</p>}
        {maxLength ? <span className="field__count" aria-hidden="true">{value.length}/{maxLength}</span> : null}
      </div>
    </div>
  );
}
