import { GraduationCap, Building2, Layers, CalendarDays, Github, Linkedin, User, Phone } from 'lucide-react';
import { TextField, SelectField, SkillsInput } from './Field';
import { DEGREES, ACADEMIC_YEARS, graduationYearRange } from '../../config/student';

// Shared by Signup and Profile edit so both screens validate and behave identically.
export function AcademicFields({ f, omitGraduationYear = false }) {
  const [min, max] = graduationYearRange();
  const p = (name) => ({ name, value: f.values[name], onChange: f.setField, onBlur: f.blur, error: f.errors[name] });
  return (
    <div className="form-grid">
      <div className="form-grid__full"><TextField label="College / University" icon={Building2} autoComplete="organization" placeholder="e.g. Anna University" {...p('college')} /></div>
      <SelectField label="Degree" icon={GraduationCap} options={DEGREES} placeholder="Select degree" {...p('degree')} />
      <TextField label="Branch / Department" icon={Layers} placeholder="e.g. Computer Science" {...p('branch')} />
      <SelectField label="Current academic year" icon={CalendarDays} options={ACADEMIC_YEARS} placeholder="Select year" {...p('academicYear')} />
      {!omitGraduationYear && <TextField label="Graduation year" icon={CalendarDays} inputMode="numeric" maxLength={4} placeholder={String(min + 5)} hint={`Between ${min} and ${max}`} {...p('graduationYear')} />}
    </div>
  );
}

export function ProfessionalFields({ f }) {
  const p = (name) => ({ name, value: f.values[name], onChange: f.setField, onBlur: f.blur, error: f.errors[name] });
  return (
    <div className="form-grid">
      <div className="form-grid__full"><SkillsInput {...p('skills')} /></div>
      <TextField label="GitHub profile" icon={Github} optional type="url" inputMode="url" autoCapitalize="none" placeholder="github.com/username" {...p('github')} />
      <TextField label="LinkedIn profile" icon={Linkedin} optional type="url" inputMode="url" autoCapitalize="none" placeholder="linkedin.com/in/username" {...p('linkedin')} />
    </div>
  );
}

export function NamePhoneFields({ f }) {
  const p = (name) => ({ name, value: f.values[name], onChange: f.setField, onBlur: f.blur, error: f.errors[name] });
  return (
    <>
      <TextField label="Full name" icon={User} autoComplete="name" placeholder="As on your college ID" {...p('fullName')} />
      <TextField label="Mobile number" icon={Phone} type="tel" inputMode="tel" autoComplete="tel-national" placeholder="98765 43210" hint="Indian mobile number. +91 is optional." {...p('phone')} />
    </>
  );
}
