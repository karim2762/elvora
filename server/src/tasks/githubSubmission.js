import { stageOf } from './constants.js';

// Stage 09B (Part 2A) — everything a student is told about a GitHub project submission, kept in ONE place so the screen, the
// server and the tests can never disagree. Nothing here talks to GitHub.

// The exact notice required by the specification. Shown beside every repository link; never reworded.
export const VERIFICATION_NOTICE = 'GitHub repository ownership, repository contents and commit history will be verified after GitHub integration is implemented in Stage 09C.';

// The seven submission statuses. Since Part 2B all of them are reachable: "Under Review" and "Rejected" come from the administrator evaluation workflow.
export const SUBMISSION_STATUSES = ['Not Submitted', 'Submitted', 'Under Review', 'Changes Requested', 'Resubmitted', 'Approved', 'Rejected'];

// student_tasks.status keeps its Stage 09A values (existing data and rules are untouched); the student-facing status is derived from it plus
// project_status (Part 2B refinement: 'Under Review' | 'Rejected') and the number of submitted versions.
export function submissionStatusOf(studentTask, versionCount) {
  const refined = studentTask.projectStatus ?? null;
  if (refined === 'Rejected') return 'Rejected';
  if (refined === 'Under Review' && studentTask.status === 'Submitted') return 'Under Review';
  switch (studentTask.status) {
    case 'Submitted': return versionCount > 1 ? 'Resubmitted' : 'Submitted';
    case 'Changes Requested': case 'Approved': return studentTask.status;
    case 'Under Review': case 'Rejected': return studentTask.status;
    default: return 'Not Submitted'; // Assigned, In Progress
  }
}

// The ONLY legal moves between the seven statuses. Everything that changes a status goes through assertTransition().
export const STATUS_TRANSITIONS = Object.freeze({
  'Not Submitted': ['Submitted'],
  'Submitted': ['Under Review'],
  'Resubmitted': ['Under Review'],
  'Under Review': ['Approved', 'Changes Requested', 'Rejected'],
  'Changes Requested': ['Resubmitted'],
  'Approved': [],
  'Rejected': [],
});
export const canTransition = (from, to) => (STATUS_TRANSITIONS[from] ?? []).includes(to);
// A student may (re)submit only from these derived statuses.
export const STUDENT_CAN_SUBMIT = Object.freeze(['Not Submitted', 'Changes Requested']);

// Every Mini Project and Final Project needs a repository, whatever its stored submission type says (older tasks may say "text").
export const requiresRepository = (task) => ['repository', 'repository_and_live_url'].includes(task.submissionType) || ['Mini Project', 'Final Project'].includes(task.taskType);
export const requiresLiveUrl = (task) => ['live_url', 'repository_and_live_url'].includes(task.submissionType);

export const REQUIRED_CONTENT = [
  'README.md', 'Complete source code', 'Organised project folders', 'Configuration examples (for example .env.example, with no real secrets)',
  'Screenshots, where they apply', 'Sample datasets, where they are appropriate', 'Installation instructions', 'Execution instructions',
  'Project features', 'Technologies used', 'Testing instructions', 'Learning outcomes', 'An appropriate .gitignore',
];
export const SECURITY_WARNING = {
  title: 'Never commit private information',
  intro: 'Anyone who can open your repository can read everything in its history, even files you delete later. Do not commit:',
  items: ['Passwords', 'API keys', 'Secret credentials', '.env files that contain secrets', 'Private student information', 'Unnecessary generated files (for example node_modules, build output, caches)', 'Databases that contain private information'],
  advice: 'Commit a .env.example with placeholder values instead, and list real .env files in .gitignore. If you commit a secret by mistake, treat it as leaked and replace it.',
};
export const COMMIT_MILESTONES = ['Initial project setup', 'Core structure implementation', 'Main feature development', 'Database or API integration, where applicable', 'Testing and bug fixes', 'Documentation and final improvements'];

// Guidance scales with the project; it is advice, not a rule the server can check (commit history is read in Stage 09C).
const COMMIT_RANGE = { 'Practical Assignment': 'a few focused commits', 'Mini Project': 'roughly 5 to 10 meaningful commits', 'Final Project': 'roughly 8 to 20 meaningful commits' };
export const commitGuidance = (task) => ({
  why: 'Meaningful commits show how your project grew, make mistakes easy to undo and let a reviewer follow your thinking. Write short messages that say what changed and why.',
  expectation: `For this ${task.taskType?.toLowerCase() ?? 'task'}, expect ${COMMIT_RANGE[task.taskType] ?? 'several meaningful commits'}. The number is a guide, not a target: it depends on the size of your project.`,
  milestones: COMMIT_MILESTONES,
  notQualifying: 'An empty repository, or one that contains only a README.md, is not a completed practical project.',
});

// Suggested name: elvora-internship-[student-identifier]-[project-name]. The identifier is the internship record ID (not an email,
// phone number or name). The name is advice only: it is not enforced, because nothing can check it until Stage 09C.
const slug = (s, max) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
export const suggestRepositoryName = (enrollmentId, title) => {
  const who = slug(String(enrollmentId ?? '').replace(/^ELV-(?:APP-|INT-)?/i, ''), 12);
  return ['elvora', 'internship', who, slug(title, 40)].filter(Boolean).join('-');
};

export function submissionGuide(task, studentTask) {
  return {
    requiresRepository: requiresRepository(task), requiresLiveUrl: requiresLiveUrl(task),
    verificationNotice: VERIFICATION_NOTICE,
    suggestedRepositoryName: suggestRepositoryName(studentTask.enrollmentId, task.title),
    repositoryNamingNote: 'Repository names must not contain email addresses, phone numbers or other private information.',
    requiredContent: REQUIRED_CONTENT, securityWarning: SECURITY_WARNING, commits: commitGuidance({ ...task, learningStage: stageOf(task) }),
  };
}
