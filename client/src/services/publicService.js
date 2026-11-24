import { api } from './apiClient';

// Public document verification (no login). Resolves to { result, document? } for every answer the API gives:
// valid / revoked (200), invalid (400), not_found (404). Anything else (network, 429, 5xx) rejects, and the page says so
// instead of pretending the document is fine or fake.
export async function verifyDocument(reference) {
  try {
    return await api.get(`/public/documents/verify/${encodeURIComponent(reference)}`);
  } catch (err) {
    const result = err?.data?.result;
    if ((err.status === 400 && result === 'invalid') || (err.status === 404 && result === 'not_found')) return { result, message: err.data.message };
    throw err;
  }
}
