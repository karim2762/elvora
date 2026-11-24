import crypto from 'node:crypto';

// Public document IDs look like ELV-DOC-7K3Q9XMD. The ID is only an identifier: access is always checked by owner.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const newDocumentId = () => `ELV-DOC-${Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')}`;
export const DOCUMENT_ID_RE = /^ELV-DOC-[A-HJKMNP-Z2-9]{8}$/;
export const DOCUMENT_TYPES = ['offer_letter', 'certificate'];
export const DOCUMENT_LABELS = { offer_letter: 'Offer Letter', certificate: 'Certificate' };
