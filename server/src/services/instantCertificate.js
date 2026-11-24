import { db } from '../db/index.js';
import * as P from '../db/priority.js';
import * as Pay from '../db/payments.js';
import * as A from '../db/priorityAdmin.js';
import * as applications from '../db/applications.js';
import * as enrollments from '../db/enrollments.js';
import * as listingRepo from '../db/internshipListings.js';
import * as documentsDb from '../db/documents.js';
import { record as audit } from '../db/audit.js';
import { insert as notify } from '../db/notifications.js';
import { createListing } from './internshipListings.js';
import { createEnrollment, changeEnrollmentStatus } from './enrollments.js';
import { decideCertificate } from './certificateApproval.js';
import { issueGenerated } from '../documents/issuance.js';
import { parseEnrollmentDetails } from '../utils/validation.js';
import { HttpError, badRequest } from '../utils/errors.js';
import { getRequest } from './priorityCertificate.js';
import { taskGate } from './completionEligibility.js';
import { todayIST } from '../utils/dates.js';

// Instant-certificate plans: a student picks 1, 2 or 3 months, pays by UPI, and the certificate is issued the moment an administrator verifies the payment.
//   - There is no 7-day plan. Only 30, 60 and 90 days (1, 2, 3 months) exist, and the price always comes from the server price list.
//   - Any signed-in student who can open the page can choose a plan; no earlier application or completed internship is needed.
//   - Nothing here trusts the browser: the months value is validated, the fee is read from the price list, and a certificate is issued only for a
//     request whose payment is VERIFIED by an administrator (Stage 10B Part 2A). The ordinary Stage 06 issuance service writes the document.
const SYSTEM = { id: null, fullName: 'Automation' };
const conflict = (message, code, details) => new HttpError(409, message, { code, details });
export const PLAN_MONTHS = Object.freeze([1, 2, 3]);
export const PLAN_NOTICE = 'Pay for a 1, 2 or 3 month plan. As soon as ELVORA verifies your payment, your offer letter is issued and appears under Documents. Your certificate follows when your plan period is completed.';

const planTitle = (months) => `ELVORA ${months}-Month Internship Programme`;

// One private (unpublished) listing per length, created on first use. It never appears on the public site.
function listingFor(months) {
  const durationDays = months * 30; const title = planTitle(months);
  const same = listingRepo.findDuplicate({ title, durationDays });
  if (same) return same;
  return createListing({
    title, category: 'software-development', durationDays, description: `A ${months}-month ELVORA internship programme with an instant certificate.`,
    skills: ['Software Development'], outcomes: ['Certificate of internship completion'],
    eligibility: { who: 'Any ELVORA student', academic: '', knowledge: [] },
    type: 'Project-Based', difficulty: 'Beginner', seats: null, deadline: null, status: 'open',
  }, SYSTEM);
}

const hasIssuedCertificate = (enrollmentId) => documentsDb.findByEnrollmentAndType(enrollmentId, 'certificate')?.status === 'Issued';

// What the page shows: the three plans with their server prices, and the student's own plan requests.
export function plans(student) {
  const prices = P.activePrices().filter((p) => PLAN_MONTHS.includes(p.months) && p.durationDays === p.months * 30);
  const mine = P.instantRequestsForStudent(student.id);
  return {
    notice: PLAN_NOTICE,
    plans: prices.map((p) => {
      const r = mine.find((x) => x.durationDays === p.durationDays && !['Rejected', 'Cancelled', 'Refunded'].includes(x.status)) ?? null;
      return { months: p.months, durationDays: p.durationDays, priceId: p.priceId, amountPaise: p.amountPaise, currency: p.currency, request: r ? { id: r.id, status: r.status, applicationId: r.applicationId } : null };
    }),
  };
}

// Student chooses a plan: creates (or returns) the draft request. Nothing is charged; the payment order is the next, separate step.
export function choosePlan(student, body) {
  const months = Number(body?.months);
  if (!PLAN_MONTHS.includes(months)) throw badRequest('Choose a 1, 2 or 3 month plan.', { months: 'Choose 1, 2 or 3 months' });
  const personal = body?.confirmPersonal === true; const academic = body?.confirmAcademic === true;
  if (!personal || !academic) throw badRequest('Please confirm your personal and academic information.', { confirmPersonal: personal ? undefined : 'Required', confirmAcademic: academic ? undefined : 'Required' });
  const days = months * 30;
  if (student.accountStatus && student.accountStatus !== 'active') throw conflict('Your account is not active.', 'STUDENT_INACTIVE');
  const price = P.activePriceFor(days);
  if (!price) throw conflict('This plan is not available right now.', 'NO_PAID_OPTION');
  return db.transaction(() => {
    const listing = listingFor(months);
    let app = applications.findByStudentAndInternship(student.id, listing.id);
    if (!app) app = applications.createByAdmin({ student, internship: { id: listing.id, title: listing.title, category: listing.category, durationDays: listing.durationDays }, note: 'Created automatically for a paid certificate plan.' });
    if (app.status !== 'Approved') {
      if (['Cancelled', 'Rejected'].includes(app.status)) throw conflict('This plan can’t be started for your account. Please contact support.', 'APPLICATION_CLOSED');
      applications.changeStatus(app.id, 'Approved', { admin: SYSTEM, note: 'Approved automatically for a paid certificate plan.' });
    }
    // The internship record starts WITHOUT dates; they are set when the certificate is issued, so the background worker leaves it alone until then.
    let enrollment = enrollments.findByApplication(app.id);
    if (!enrollment) enrollment = createEnrollment(app.id, parseEnrollmentDetails({}));
    if (enrollment.status === 'Cancelled') throw conflict('This plan was cancelled. Please contact support.', 'ENROLLMENT_CLOSED');
    if (hasIssuedCertificate(enrollment.id) || enrollment.certificate) throw conflict(`You already have your ${months}-month certificate. Find it under Documents.`, 'CERTIFICATE_EXISTS');
    const open = P.openRequestForEnrollment(enrollment.id, student.id);
    if (open) return { created: false, request: getRequest(student, open.id) };
    const id = P.insertDraft({ studentId: student.id, application: { applicationId: app.id }, enrollmentId: enrollment.id, price, checkId: null, personal, academic, instant: true });
    audit({ admin: null, action: 'priority.plan_choose', targetType: 'priority', targetId: id, reason: `${months}-month plan`, actorName: 'Student (plan)' });
    notify({ studentId: student.id, type: 'priority_received', title: 'Plan selected', message: `You chose the ${months}-month plan. Nothing has been charged yet. Create a payment order to continue.`, applicationId: app.id, enrollmentId: enrollment.id, dedupeKey: `prio:${id}:received` });
    return { created: true, request: getRequest(student, id) };
  })();
}

// ---------------- issuing ----------------
// Runs only for an instant request whose payment an administrator has VERIFIED. Every step is idempotent, so a retry after any failure (for example the
// organisation details were incomplete) simply carries on from where it stopped. Concurrent callers share one run.
const inflight = new Map(); const offerAudited = new Set();
export function fulfil(requestId) {
  if (!inflight.has(requestId)) inflight.set(requestId, fulfilOnce(requestId).finally(() => inflight.delete(requestId)));
  return inflight.get(requestId);
}
async function fulfilOnce(requestId) {
  const r = P.requestById(requestId);
  if (!r || !r.instant) return { issued: false, skipped: true };
  if (r.status === 'Certificate Issued') return { issued: true, documentId: r.documentId };
  if (r.status !== 'Payment Verified') return { issued: false, skipped: true };
  const pay = Pay.liveForRequest(r.id);
  if (!pay || pay.status !== 'VERIFIED') return { issued: false, skipped: true }; // never without a verified payment
  let e = enrollments.findById(r.enrollmentId);
  if (!e || e.studentId !== r.studentId || e.applicationId !== r.applicationId) throw conflict('The internship record could not be verified.', 'RECORD_MISMATCH');
  if (e.status === 'Cancelled' || e.status === 'Suspended') throw conflict(`The internship is ${e.status.toLowerCase()}.`, 'ENROLLMENT_CLOSED');
  const now = new Date(); const today = todayIST(now);

  // Step 1 (right after the administrator approves the payment): the plan period STARTS today, the offer letter is issued now, and the
  // certificate is pre-approved so it is issued automatically once the period is over. Every part is idempotent.
  // The student never picks dates: an administrator sets them (Admin → Internships → Set dates, at most 90 days back). Until then nothing starts.
  if (e.status === 'Awaiting Start') {
    if (!e.startDate) return { issued: false, awaitingSchedule: true };
    if (e.startDate > today) return { issued: false, awaitingStart: true, startsOn: e.startDate };
    e = changeEnrollmentStatus(e.id, { status: 'Active', startDate: e.startDate, expectedEndDate: e.expectedEndDate }, now, SYSTEM);
  }
  e = enrollments.findById(e.id);
  if (e.status === 'Active' && e.certificateReview?.decision !== 'Approved') decideCertificate(e.id, { decision: 'Approved', note: 'Approved automatically after a verified payment. Issued when the plan period is completed.', decidedBy: 'Automation' });
  let offer;
  try { offer = await issueGenerated({ type: 'offer_letter', enrollmentId: e.id, issuedBy: 'ELVORA (automatic)', admin: null }); }
  catch (err) { if (err?.code !== 'DOCUMENT_EXISTS') throw err; offer = documentsDb.findByEnrollmentAndType(e.id, 'offer_letter'); }
  if (!offer) throw conflict('The offer letter could not be found after issuing.', 'OFFER_MISSING');
  const months = Math.round(r.durationDays / 30);
  const certificateOn = e.expectedEndDate;
  notify({ studentId: r.studentId, type: 'offer_letter_issued', title: 'Your offer letter is ready', message: `Your ${months}-month plan has started. Your offer letter is under Documents. Your completion certificate will be issued on or after ${certificateOn}.`, applicationId: r.applicationId, enrollmentId: e.id, dedupeKey: `prio:${r.id}:offer` });
  if (!offerAudited.has(r.id)) { offerAudited.add(r.id); audit({ admin: null, action: 'priority.plan_offer', targetType: 'priority', targetId: r.id, reason: `offer letter ${offer.id}; certificate due ${certificateOn}`, actorName: 'Automation' }); }

  // Step 2 (only once the plan period is over, and the required tasks, if any, are approved): complete the internship and issue the certificate.
  if (e.status === 'Active') {
    if (!e.expectedEndDate || today < e.expectedEndDate) return { issued: false, offerLetterIssued: true, offerDocumentId: offer.id, certificateOn };
    const gate = taskGate(e);
    if (gate.blocking) return { issued: false, offerLetterIssued: true, offerDocumentId: offer.id, certificateOn, waitingFor: 'tasks', message: gate.message ?? 'Required tasks are not all approved yet.' };
    if (e.progressPercent !== 100) enrollments.setProgress(e.id, 100, { actor: SYSTEM, note: 'Plan period completed', previous: e.progressPercent });
    e = changeEnrollmentStatus(e.id, { status: 'Completed', reason: 'Plan period completed' }, now, SYSTEM);
  }
  e = enrollments.findById(e.id);
  if (e.status !== 'Completed') return { issued: false, offerLetterIssued: true, offerDocumentId: offer.id, certificateOn };
  let doc;
  try { doc = await issueGenerated({ type: 'certificate', enrollmentId: e.id, issuedBy: 'ELVORA (automatic)', admin: null }); }
  catch (err) { if (err?.code !== 'DOCUMENT_EXISTS') throw err; doc = documentsDb.findByEnrollmentAndType(e.id, 'certificate'); } // the background worker got there first
  if (!doc) throw conflict('The certificate could not be found after issuing.', 'CERTIFICATE_MISSING');
  A.setStatus(r.id, { from: 'Payment Verified', to: 'Certificate Issued', note: 'Plan period completed; certificate issued.', actor: 'system', documentId: doc.id });
  audit({ admin: null, action: 'priority.plan_issue', targetType: 'priority', targetId: r.id, reason: `certificate ${doc.id}`, actorName: 'Automation' });
  return { issued: true, documentId: doc.id };
}
// Never throws: the verification itself has already succeeded and must not be undone by an issuing problem. The student's page retries.
export async function fulfilSafely(requestId) {
  try { return await fulfil(requestId); } catch (err) {
    console.error('[instant-certificate] could not issue yet:', err?.code ?? '', err?.message);
    return { issued: false, retry: true, code: err?.code ?? 'ERROR', message: err?.message ?? 'The certificate could not be issued yet.' };
  }
}
export async function fulfilForPayment(paymentId) {
  const p = Pay.paymentById(paymentId); const r = p && P.requestById(p.requestId);
  if (!r?.instant) return null;
  return fulfilSafely(r.id);
}
// Called by the background worker every cycle: gives every paid plan its next step (offer letter now, certificate when the period ends).
// Called right after an administrator sets the dates, so the offer letter does not wait for the next background cycle.
export async function fulfilForEnrollment(enrollmentId) {
  for (const r of P.instantVerifiedAll()) if (r.enrollmentId === enrollmentId) await fulfilSafely(r.id);
}
export async function fulfilAllDue() {
  for (const r of P.instantVerifiedAll()) await fulfilSafely(r.id);
}
export async function fulfilPending(student) {
  for (const r of P.instantVerifiedForStudent(student.id)) await fulfilSafely(r.id);
}
