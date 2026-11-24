import crypto from 'node:crypto';

// ONE public ID per student journey. A new application gets an ID like ELV-7K3Q9XMD, and that same ID is then used for
// the internship record, the offer letter and the certificate (it is printed on both PDFs). Older records keep the IDs
// they were created with (ELV-APP-XXXXXXXX / ELV-INT-XXXXXXXX), so every pattern below accepts both forms.
// 8 characters from a 31-symbol alphabet (no I, L, O, 0, 1) are easy to read aloud and not guessable. The ID is only an
// identifier: access is always checked by owner, never by knowing the ID.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CORE = '[A-HJKMNP-Z2-9]{8}';
export const newElvoraId = () => `ELV-${Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')}`;
export const ELVORA_ID_RE = new RegExp(`^ELV-${CORE}$`);
export const idMatcher = (legacyPrefix) => new RegExp(`^ELV-(?:${legacyPrefix}-)?${CORE}$`);
// The internship record of an application shares its ID (legacy ELV-APP-X applications map to ELV-X).
export const journeyIdOf = (applicationId) => `ELV-${String(applicationId).slice(-8)}`;
