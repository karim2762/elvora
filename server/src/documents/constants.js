// Shared document-system constants. Types and statuses mirror the CHECK constraints in db/index.js (migration 5).
export const DOCUMENT_TYPES = ['offer_letter', 'certificate'];
export const DOCUMENT_STATUSES = ['Draft', 'Issued', 'Revoked'];
export const TEMPLATE_VERSIONS = { offer_letter: 'offer-letter@1', certificate: 'certificate@1' };
export const NUMBER_PREFIX = { offer_letter: 'OL', certificate: 'CRT' };
export const DEFAULT_TITLES = { offer_letter: 'Internship Offer Letter', certificate: 'Internship Completion Certificate' };
