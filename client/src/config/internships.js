// Option lists for filters/sorting and labels. UI components read from here.
export const difficultyLevels = ['Beginner', 'Intermediate', 'Advanced'];
export const internshipTypes = ['Project-Based', 'Training + Project', 'Self-Paced'];
export const DEFAULT_SORT = 'newest';
export const sortOptions = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'shortest', label: 'Shortest duration' },
  { value: 'longest', label: 'Longest duration' },
  { value: 'az', label: 'Alphabetical (A–Z)' },
];
export const statusInfo = {
  open: { label: 'Applications open', tone: 'ok' },
  upcoming: { label: 'Opens soon', tone: 'soon' },
  closed: { label: 'Applications closed', tone: 'off' },
};
