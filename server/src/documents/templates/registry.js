import { offerLetterTemplate } from './offerLetter.js';
import { certificateTemplate } from './certificate.js';

// Template management: one entry per document type, each with a version string stored on the document record
// (documents.template_version). To change a layout, add offer-letter@2 and bump the entry; issued documents keep the version
// they were made with, so they can always be re-rendered identically.
const templates = { offer_letter: { current: offerLetterTemplate }, certificate: { current: certificateTemplate } };
export const getTemplate = (type) => templates[type]?.current ?? null;
export const listTemplates = () => Object.values(templates).map(({ current: t }) => ({ type: t.type, version: t.version, paper: t.paper }));
