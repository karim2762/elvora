// Display helpers for dates and phone numbers (India locale, matching the rest of the app).
// "2026-12-01" (a calendar date) is shown as that day in every timezone; full ISO timestamps are shown in local time.
const toDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v));
export const fmtDate = (iso) => toDate(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
export const fmtDateTime = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtPhone = (p) => (/^\d{10}$/.test(p) ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : p);
