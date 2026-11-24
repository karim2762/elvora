// Single place where the client reads configuration.
export const env = {
  apiUrl: import.meta.env.VITE_API_URL || '/api/v1',
  // Stage 07B: internships come from the REST API (administrator-managed). Set VITE_USE_DEMO_DATA=true to use the bundled demo records offline.
  useDemoData: import.meta.env.VITE_USE_DEMO_DATA === 'true',
};
