import crypto from 'node:crypto';
import { LEARNING_STAGES } from '../constants.js';

// Stage 09B — turns the compact, hand-written task definitions (tasks/library/*.js) into full task-library templates.
// What is written per task: the specifics (problem, concepts, features, steps ...). What is derived: deliverables, checklist, rubric, submission text.
// A category supplies what its tasks share: free tools, official resources, skills, and the recommended folder layout.
const [S1, S2, S3] = LEARNING_STAGES;
const STAGE = { 1: { stage: S1, type: 'Practical Assignment', difficulty: 'Beginner' }, 2: { stage: S2, type: 'Mini Project', difficulty: 'Easy' }, 3: { stage: S3, type: 'Final Project', difficulty: 'Intermediate' } };

// Stable ID from a key, so seeding is idempotent and never overwrites an administrator's edits (TEMPLATE_ID_RE: TPL-XXXXXXXX).
export const templateIdFor = (key) => `TPL-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8).toUpperCase()}`;

const RUBRIC = {
  1: [['Works as described', 50, 'The exercise runs and produces the expected result.'], ['Understanding of the concept', 30, 'Code or notes show the student understands why it works.'], ['Clarity and tidiness', 20, 'Readable names, comments where useful, simple layout.']],
  2: [['Required features', 35, 'Every required feature works as described.'], ['Code quality and structure', 20, 'Logical files/functions, clear names, no duplicated code.'], ['Error handling', 15, 'Bad input and missing data are handled with clear messages.'], ['Testing', 15, 'Test steps were followed and results are recorded.'], ['Documentation', 15, 'README explains setup, usage and design choices.']],
  3: [['Working application', 30, 'The app runs from the README steps and every required feature works.'], ['Code organisation and maintainability', 20, 'Modular code that follows the recommended structure.'], ['Error handling and robustness', 15, 'Invalid input and failures never crash the application.'], ['Testing', 15, 'Tests or a written test plan with results covers the main features.'], ['Documentation', 10, 'README, setup, usage, screenshots and known limitations.'], ['Demonstration and portfolio quality', 10, 'Clear demo (screenshots, short walkthrough or live link) suitable for a portfolio.']],
};

export function buildTemplate(cat, t) {
  const st = STAGE[t.stage]; const full = t.stage > 1;
  const submissionType = t.sub ?? (t.stage === 3 ? cat.finalSubmission ?? 'repository' : 'repository');
  const content = {
    learningStage: st.stage, objective: t.objective, background: t.background ?? t.problem, problemStatement: full ? t.problem : '', concepts: t.concepts, steps: t.steps,
    expectedOutput: t.expected ?? t.behavior, tools: [...(t.tools ?? []), ...cat.tools],
    submissionRequirements: `Submit a link to your repository${submissionType.includes('live') ? ' and your live project link' : ''}. In the description, say what you built, how to run it, and anything that does not work yet.${full ? ' Include a README with setup and usage steps.' : ''}`,
  };
  if (full) Object.assign(content, {
    features: t.features, technicalRequirements: [...t.tech, ...cat.tech], folderStructure: cat.tree(t.dir), expectedBehavior: t.behavior, testingRequirements: t.tests, acceptanceCriteria: t.accept,
    completionChecklist: [...t.features.slice(0, 4).map((f) => `Feature done: ${f.split(/[.:—-]/)[0].trim()}`.slice(0, 190)), 'Tested with valid, invalid and empty input', 'README with setup and usage steps added', t.stage === 3 ? 'Demo screenshots or walkthrough added' : 'Code committed with clear messages'],
    rubric: RUBRIC[t.stage].map(([criterion, weight, description]) => ({ criterion, weight, description })),
  });
  else content.acceptanceCriteria = t.accept;
  return {
    key: `${cat.slug}:${t.dir}`, id: templateIdFor(`${cat.slug}:${t.dir}`), category: cat.slug, title: t.title, shortDescription: t.short, difficulty: st.difficulty, taskType: st.type,
    estimatedHours: t.hours, minDurationDays: t.min ?? null, submissionType, content, learningObjectives: t.outcomes, requiredSkills: t.skills ?? cat.skills,
    deliverables: t.stage === 1 ? ['Your solution files', 'A short note on what you learned'] : ['Source code repository', 'README with setup and usage steps', 'Test results or test plan', ...(t.stage === 3 ? ['Demo screenshots or short walkthrough'] : [])],
    evaluationCriteria: full ? RUBRIC[t.stage].map(([c]) => c) : RUBRIC[1].map(([c]) => c), resources: cat.resources,
  };
}
export const buildCategory = (cat, tasks) => tasks.map((t) => buildTemplate(cat, t));
