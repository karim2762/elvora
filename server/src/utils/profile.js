// Public shape of a student. The password hash never leaves the server.
const FIELDS = [
  ['fullName', 'Full name'], ['email', 'Email'], ['phone', 'Mobile number'], ['college', 'College'],
  ['degree', 'Degree'], ['branch', 'Branch'], ['academicYear', 'Academic year'], ['graduationYear', 'Graduation year'],
  ['skills', 'Technical skills'], ['github', 'GitHub profile'], ['linkedin', 'LinkedIn profile'],
];
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v !== '' && v !== null && v !== undefined);

export function profileCompletion(s) {
  const missing = FIELDS.filter(([k]) => !filled(s[k])).map(([, label]) => label);
  return { percent: Math.round(((FIELDS.length - missing.length) / FIELDS.length) * 100), missing };
}

export function toPublicStudent(s) {
  return {
    id: s.id, role: s.role === 'admin' ? 'admin' : 'student', fullName: s.fullName, email: s.email, phone: s.phone, college: s.college, degree: s.degree,
    branch: s.branch, academicYear: s.academicYear, graduationYear: s.graduationYear, skills: s.skills,
    github: s.github, linkedin: s.linkedin, createdAt: s.createdAt, updatedAt: s.updatedAt,
    profileCompletion: profileCompletion(s),
  };
}
