import { DEFAULT_TITLES, TEMPLATE_VERSIONS } from './constants.js';
import { checkEligibility } from './eligibility.js';
import { getOrganization } from './organization.js';
import { OFFER_TERMS } from './terms.js';
import { NUMBER_PLACEHOLDER } from './numbering.js';
import { VERIFICATION_PLACEHOLDER, verificationUrl } from './verification.js';
import { qrSvg } from './qr.js';
import { HttpError } from '../utils/errors.js';

// Document data preparation: turns repository records into ONE plain, renderer-independent object. Templates and renderers
// receive only this object, never database rows, so they cannot leak fields (storage key, phone number, student ID ...).
// Pure functions (no I/O), so they are trivial to test and reuse from any host.
const IST_MS = 5.5 * 3600 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function formatDate(v) {
  if (!v) return '';
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date(new Date(v).getTime() + IST_MS).toISOString().slice(0, 10); // stamps → India date
  const [y, m, d] = iso.split('-').map(Number);
  return Number.isFinite(y) ? `${d} ${MONTHS[m - 1]} ${y}` : '';
}
export function formatDuration(days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) return '';
  return n >= 14 && n % 7 === 0 ? `${n / 7} weeks (${n} days)` : `${n} ${n === 1 ? 'day' : 'days'}`;
}
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

function common({ type, enrollment, student, document = null, preview = null, now = new Date(), organization = getOrganization() }) {
  return {
    type,
    title: DEFAULT_TITLES[type],
    templateVersion: TEMPLATE_VERSIONS[type],
    organization,
    preview, // null for issued documents, or 'sample' | 'draft' for watermarked previews
    document: {
      // ONE ID is printed on every document of a journey: the internship's Elvora ID (same as the application ID).
      // The internal document number (numbering.js) stays in the database for audits but is no longer printed.
      number: enrollment.id ?? NUMBER_PLACEHOLDER(type),
      verificationCode: document?.verificationCode ?? VERIFICATION_PLACEHOLDER,
      issuedAt: document?.issuedAt ?? now.toISOString(),
      issueDate: formatDate(document?.issuedAt ?? now.toISOString()),
      // Real documents carry a QR encoding the verification URL; previews keep the dashed placeholder.
      verificationUrl: document?.verificationCode ? verificationUrl(document.verificationCode) : null,
      qrSvg: document?.verificationCode ? qrSvg(verificationUrl(document.verificationCode)) : null,
    },
    student: { fullName: clean(student.fullName), email: clean(student.email) },
    internship: {
      title: clean(enrollment.internship.title), category: clean(enrollment.internship.category),
      durationDays: enrollment.internship.durationDays, duration: formatDuration(enrollment.internship.durationDays),
    },
    dates: { start: formatDate(enrollment.startDate) },
  };
}

export function buildOfferLetterData(args) {
  const { enrollment } = args;
  const base = common({ ...args, type: 'offer_letter' });
  return {
    ...base,
    dates: { ...base.dates, expectedEnd: formatDate(enrollment.expectedEndDate) },
    offer: {
      project: clean(enrollment.assignedProject),
      objectives: (enrollment.learningObjectives ?? []).map(clean).filter(Boolean),
      terms: OFFER_TERMS,
    },
  };
}

// A certificate states that the student COMPLETED the internship, so this refuses unless the backend record confirms it.
export function buildCertificateData(args) {
  const { enrollment } = args;
  if (args.preview !== 'sample') { // only fictional sample data skips the check; real records, drafts included, must be confirmed complete
    const v = checkEligibility({ type: 'certificate', enrollment, strict: true });
    if (!v.eligible) throw new HttpError(409, v.message, { code: v.code });
  }
  const base = common({ ...args, type: 'certificate' });
  return { ...base, dates: { ...base.dates, completion: formatDate(enrollment.completedAt) } };
}

export const buildDocumentData = (type, args) => (type === 'certificate' ? buildCertificateData(args) : buildOfferLetterData(args));

// Fictional data for template previews and layout tests. Never stored, never numbered, always watermarked.
export const SAMPLE = {
  student: { fullName: 'Sample Student Name', email: 'student@example.com' },
  enrollment: {
    id: 'ELV-7K3Q9XMD',
    internship: { id: 'SAMPLE', title: 'Full Stack Web Development Internship', category: 'Web Development', durationDays: 60 },
    startDate: '2027-02-01', expectedEndDate: '2027-04-02', completedAt: '2027-04-02T10:00:00.000Z',
    assignedProject: 'Build and deploy a small web application', learningObjectives: ['Build REST APIs', 'Design a responsive interface', 'Use Git for collaboration'],
  },
};
export const STRESS = {
  student: { fullName: 'Venkata Subrahmanyam Chandrasekharan Ramanathan Iyer-Krishnamurthy', email: 'a.very.long.email.address.for.layout.testing@example-university.ac.in' },
  enrollment: {
    ...SAMPLE.enrollment,
    internship: { id: 'SAMPLE', title: 'Applied Machine Learning, Data Engineering and Cloud-Native Deployment Practices Internship', category: 'Artificial Intelligence and Machine Learning', durationDays: 90 },
    learningObjectives: Array.from({ length: 8 }, (_, i) => `Learning objective ${i + 1}: a deliberately long statement used to confirm that wrapping and page breaks stay clean in print`),
  },
};
