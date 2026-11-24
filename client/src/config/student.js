// Option lists mirror server/src/utils/validation.js (the server is authoritative).
export const DEGREES = ['B.Tech', 'B.E.', 'BCA', 'MCA', 'B.Sc', 'M.Sc', 'M.Tech', 'M.E.', 'BBA', 'MBA', 'Diploma', 'Other'];
export const ACADEMIC_YEARS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year', 'Graduated'];
export const graduationYearRange = () => { const y = new Date().getFullYear(); return [y - 5, y + 8]; };
