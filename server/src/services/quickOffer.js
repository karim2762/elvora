import { HttpError, notFound } from '../utils/errors.js';
import { todayIST, addDays, isValidDate } from '../utils/dates.js';
import { parseEnrollmentDetails } from '../utils/validation.js';
import { CATEGORIES, DURATION_DAYS, DIFFICULTIES, INTERNSHIP_TYPES } from '../internships/categories.js';
import * as students from '../db/students.js';
import * as applications from '../db/applications.js';
import * as enrollments from '../db/enrollments.js';
import * as listingRepo from '../db/internshipListings.js';
import * as docs from '../db/documents.js';
import { createListing } from './internshipListings.js';
import { createEnrollment } from './enrollments.js';
import { issueGenerated, toAdminDocument } from '../documents/issuance.js';
import { record as audit } from '../db/audit.js';

// "Instant offer letter" (administrator only). When a student can't wait for the automatic offer letter, an administrator can in
// ONE step: pick the student, pick (or create) the internship, and get the signed, numbered, verifiable PDF immediately.
// Everything goes through the same services the normal flow uses (application approval, internship record, document issuance), so
// the student sees an ordinary approved application, internship and offer letter, all under one Elvora ID.
const conflict = (message, code, details) => new HttpError(409, message, { code, details });
const bad = (fields) => new HttpError(400, 'Please check the highlighted fields.', { code: 'VALIDATION', fields });
const LISTING_ID_RE = /^ELV-[A-Z]{1,3}-\d{3,}$/;
const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

// A new internship needs only a title, a field and a length: the other listing fields get sensible defaults. It is created UNPUBLISHED,
// so it never appears on the public site unless an administrator publishes it later.
function newListingBody(n) {
  const category = CATEGORIES.find((c) => c.slug === n.category);
  const errors = {};
  const title = text(n.title);
  if (title.length < 3) errors.title = 'Enter the internship title (at least 3 characters)';
  if (!category) errors.category = 'Choose a field';
  const durationDays = Number(n.durationDays);
  if (!DURATION_DAYS.includes(durationDays)) errors.durationDays = 'Choose a duration';
  if (Object.keys(errors).length) throw bad({ newInternship: errors });
  const label = category.label;
  const description = text(n.description) || `${title}: a practical, project-based internship in ${label} with ELVORA.`;
  return {
    title, category: category.slug, durationDays, description,
    skills: [label], outcomes: [`Complete a hands-on project in ${label}`],
    eligibility: { who: `Students and graduates interested in ${label}`, academic: '', knowledge: [] },
    type: INTERNSHIP_TYPES.includes(n.type) ? n.type : 'Project-Based', difficulty: DIFFICULTIES.includes(n.difficulty) ? n.difficulty : 'Beginner',
    seats: null, deadline: null, status: 'open',
  };
}

function resolveListing(body, admin) {
  if (body.newInternship && typeof body.newInternship === 'object') {
    const v = newListingBody(body.newInternship);
    const same = listingRepo.findDuplicate({ title: v.title, durationDays: v.durationDays }); // same title + length already exists: reuse it, don't fail
    return { listing: same ?? createListing(v, admin), created: !same };
  }
  const id = typeof body.internshipId === 'string' ? body.internshipId.trim() : '';
  if (!LISTING_ID_RE.test(id)) throw bad({ internshipId: 'Choose an internship' });
  const listing = listingRepo.findById(id);
  if (!listing || listing.archivedAt) throw notFound('That internship does not exist or is archived.', 'LISTING_NOT_FOUND');
  return { listing, created: false };
}

export async function issueInstantOffer(body, admin) {
  const b = body && typeof body === 'object' ? body : {};
  const studentId = typeof b.studentId === 'string' ? b.studentId.trim() : '';
  if (!studentId) throw bad({ studentId: 'Choose a student' });
  const student = students.findById(studentId);
  if (!student || student.role === 'admin') throw notFound('Student not found', 'STUDENT_NOT_FOUND');
  if (student.accountStatus && student.accountStatus !== 'active') throw conflict('This student account is not active.', 'STUDENT_INACTIVE');

  const startDate = b.startDate ? String(b.startDate) : todayIST();
  if (!isValidDate(startDate)) throw bad({ startDate: 'Use a valid date' });
  if (startDate < addDays(todayIST(), -7)) throw bad({ startDate: 'The start date can’t be more than a week in the past' });
  const details = parseEnrollmentDetails({ startDate, assignedProject: b.assignedProject, learningObjectives: b.learningObjectives });

  const { listing, created } = resolveListing(b, admin);
  const internship = { id: listing.id, title: listing.title, category: listing.category, durationDays: listing.durationDays };

  // 1. application (reuse the student's own if they already applied) → Approved
  let app = applications.findByStudentAndInternship(student.id, internship.id);
  const createdApplication = !app;
  if (!app) app = applications.createByAdmin({ student, internship, note: 'Added by an administrator through Instant offer letter.' });
  if (app.status !== 'Approved') {
    if (app.status === 'Cancelled') throw conflict('This student’s application for that internship was cancelled and can’t be reopened. Choose another internship.', 'APPLICATION_CANCELLED');
    if (app.status === 'Rejected') applications.changeStatus(app.id, 'Under Review', { admin, note: 'Reopened for an instant offer letter' }); // a rejection can only go back through review
    applications.changeStatus(app.id, 'Approved', { admin, note: 'Approved with an instant offer letter' });
  }

  // 2. internship record (the same ID as the application), created synchronously right after approval so the background worker can't interleave
  let enrollment = enrollments.findByApplication(app.id);
  if (!enrollment) enrollment = createEnrollment(app.id, { ...details, expectedEndDate: addDays(details.startDate, listing.durationDays) });
  else if (!enrollment.startDate || !enrollment.expectedEndDate) throw conflict('This internship record has no dates yet. Set them first, then issue the letter.', 'ENROLLMENT_DATES_MISSING');
  if (enrollment.status === 'Cancelled') throw conflict('This student’s internship was cancelled.', 'ENROLLMENT_CLOSED');

  // 3. the offer letter, now
  let document; let alreadyIssued = false;
  try {
    document = await issueGenerated({ type: 'offer_letter', enrollmentId: enrollment.id, issuedBy: admin?.fullName ?? 'Administrator', admin });
  } catch (err) {
    if (err?.code !== 'DOCUMENT_EXISTS') throw err; // already issued (by this admin earlier, or by the automatic run a moment ago): hand back that one
    document = docs.findByEnrollmentAndType(enrollment.id, 'offer_letter'); alreadyIssued = true;
  }
  audit({ admin, action: 'offer_letter.instant', targetType: 'internship', targetId: enrollment.id, reason: `${student.fullName} · ${listing.title}${created ? ' (new internship)' : ''}` });

  return {
    elvoraId: enrollment.id, alreadyIssued, createdInternship: created, createdApplication,
    student: { id: student.id, fullName: student.fullName, email: student.email },
    internship: { id: listing.id, title: listing.title, durationDays: listing.durationDays },
    startDate: enrollment.startDate, expectedEndDate: enrollment.expectedEndDate,
    document: toAdminDocument(document, { events: false }),
  };
}

// Internships an administrator can pick: every live (non-archived) listing, published or not.
export const pickableListings = () => listingRepo.pageForAdmin({ limit: 500, offset: 0 }).rows
  .map((l) => ({ id: l.id, title: l.title, category: l.category, durationDays: l.durationDays, published: l.published }));
