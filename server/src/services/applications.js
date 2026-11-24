import { HttpError, notFound } from '../utils/errors.js';
import { parseApplication } from '../utils/validation.js';
import { getInternship, effectiveStatus } from '../internships/catalog.js';
import * as applications from '../db/applications.js';

const duplicate = (existing) => new HttpError(409, 'You have already applied for this internship.', {
  code: 'ALREADY_APPLIED', details: { applicationId: existing?.id ?? null },
});

// The whole submission pipeline. `student` is the server-side record from the session, never from the request body.
// Returns the saved application only after the database write has succeeded.
export function submitApplication(student, body) {
  const { internshipId, responses } = parseApplication(body, student); // 1. server-side validation (400)

  const internship = getInternship(internshipId); // 2. the internship must exist (404)
  if (!internship) throw notFound('We couldn’t find that internship.', 'INTERNSHIP_NOT_FOUND');
  if (effectiveStatus(internship) !== 'open') { // 3. applications must be open (409)
    throw new HttpError(409, 'This internship is not accepting applications right now.', { code: 'APPLICATIONS_CLOSED' });
  }

  const existing = applications.findByStudentAndInternship(student.id, internship.id); // 4. friendly duplicate check
  if (existing) throw duplicate(existing);

  try { // 5. save (unique ID, student + internship link, status "Submitted"); the DB constraint also stops races
    return applications.createApplication({ student, internship, responses });
  } catch (err) {
    if (err instanceof applications.DuplicateApplicationError) throw duplicate(applications.findByStudentAndInternship(student.id, internship.id));
    throw err;
  }
}
