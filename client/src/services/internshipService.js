import { env } from '../config/env';
import { api } from './apiClient';
import { demoInternships } from '../data/internships.demo';

// The only place the app obtains internships. Switch data source with VITE_USE_DEMO_DATA.
// API: GET /internships -> { internships: Internship[] } and GET /internships/:id -> { internship: Internship }. (`data` is a deprecated alias of the same content.)
export const isDemoData = env.useDemoData;

export async function listInternships() {
  if (env.useDemoData) return demoInternships;
  const res = await api.get('/internships');
  return res?.internships ?? res?.data ?? res;
}

export async function getInternship(id) {
  if (env.useDemoData) return demoInternships.find((i) => i.id === id) ?? null;
  try {
    const res = await api.get(`/internships/${encodeURIComponent(id)}`);
    return res?.internship ?? res?.data ?? res;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
