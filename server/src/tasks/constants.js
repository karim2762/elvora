// Stage 09A — shared vocabulary of the task system. Values here are mirrored by CHECK constraints in migration 14.
// Difficulty is deliberately limited to beginner-to-intermediate work that an ordinary college student can finish while learning.
// (Internship LISTINGS may still say "Advanced"; TASKS may not.)
export const TASK_DIFFICULTIES = ['Beginner', 'Easy', 'Intermediate'];
export const TASK_TYPES = ['Practical Assignment', 'Mini Project', 'Final Project'];
// Attachments are not supported yet (no upload route for task work), so a submission is text and/or links only.
export const SUBMISSION_TYPES = ['text', 'repository', 'live_url', 'repository_and_live_url'];
export const STUDENT_TASK_STATUSES = ['Assigned', 'In Progress', 'Submitted', 'Changes Requested', 'Approved'];
export const REVIEW_DECISIONS = ['Approved', 'Changes Requested'];
export const MAX_ESTIMATED_HOURS = 80;
export const TASK_ID_RE = /^TSK-[0-9A-F]{8}$/;
export const TEMPLATE_ID_RE = /^TPL-[0-9A-F]{8}$/;
export const STUDENT_TASK_ID_RE = /^STK-[0-9A-F]{8}$/;
export const EVALUATION_ID_RE = /^EVL-[0-9A-F]{8}$/;
export const LISTING_ID_RE = /^[A-Za-z0-9-]{1,40}$/;

// Stage 09B — the three progressive learning stages. A stage is DERIVED from the task type unless stated, so every Stage 09A task keeps working.
export const LEARNING_STAGES = ['Beginner Foundation', 'Intermediate Implementation', 'Practical Internship Project'];
export const STAGE_BY_TYPE = { 'Practical Assignment': LEARNING_STAGES[0], 'Mini Project': LEARNING_STAGES[1], 'Final Project': LEARNING_STAGES[2] };
export const stageOf = (t) => t?.content?.learningStage ?? STAGE_BY_TYPE[t?.taskType] ?? LEARNING_STAGES[0];
