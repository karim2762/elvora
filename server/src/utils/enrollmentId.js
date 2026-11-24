import { idMatcher, journeyIdOf } from './elvoraId.js';

// An internship record uses the SAME ID as its application (see elvoraId.js), so a student, an admin and a printed
// document all quote one number. Legacy internship IDs (ELV-INT-7K3Q9XMD) still work.
export const newEnrollmentId = (applicationId) => journeyIdOf(applicationId);
export const ENROLLMENT_ID_RE = idMatcher('INT');
