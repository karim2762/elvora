// Stage 07B — the twelve supported internship categories, the four durations and the option lists.
// `slug` is the value stored everywhere (it matches the public site's domains); `prefix` builds the internship ID (ELV-PY-001).
export const CATEGORIES = [
  { slug: 'python-development', label: 'Python', prefix: 'PY' },
  { slug: 'java-development', label: 'Java', prefix: 'JV' },
  { slug: 'web-development', label: 'Web Development', prefix: 'WD' },
  { slug: 'full-stack-development', label: 'Full Stack', prefix: 'FS' },
  { slug: 'artificial-intelligence', label: 'Artificial Intelligence', prefix: 'AI' },
  { slug: 'machine-learning', label: 'Machine Learning', prefix: 'ML' },
  { slug: 'data-science', label: 'Data Science', prefix: 'DS' },
  { slug: 'cybersecurity', label: 'Cybersecurity', prefix: 'CS' },
  { slug: 'cloud-computing', label: 'Cloud Computing', prefix: 'CL' },
  { slug: 'ui-ux-design', label: 'UI/UX', prefix: 'UX' },
  { slug: 'c-programming', label: 'C', prefix: 'C' },
  { slug: 'software-development', label: 'Software Development', prefix: 'SD' },
];
export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug);
export const DURATIONS = [{ days: 7, label: '7 days' }, { days: 30, label: '1 month' }, { days: 60, label: '2 months' }, { days: 90, label: '3 months' }];
export const DURATION_DAYS = DURATIONS.map((d) => d.days);
export const DIFFICULTIES = ['Beginner', 'Intermediate', 'Advanced'];
export const INTERNSHIP_TYPES = ['Project-Based', 'Training + Project', 'Self-Paced'];
export const LISTING_ACTIONS = ['publish', 'unpublish', 'activate', 'deactivate', 'archive', 'restore'];
