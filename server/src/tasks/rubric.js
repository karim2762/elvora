// Stage 09B (Part 2B) — the project evaluation rubric. This file is the ONLY place rubric criteria, weights and the score arithmetic live;
// the database stores a SNAPSHOT of the rubric on every evaluation (so changing a weight here never rewrites an old evaluation), and the
// screens read the rubric from the API instead of repeating it.
//
// Scoring model: every criterion is scored 0..maxScore (steps of 0.5) and contributes  score / maxScore * weight  points to a total out of 100.
// Rounding: arithmetic is done in integer hundredths of a point (no floating-point drift); every contribution AND the total are rounded
// half-up to 2 decimals from the exact value, so a total is never off by an accumulated rounding error.

export const RUBRIC_VERSION = 1;
export const SCORE_MAX = 10; // marks per criterion before weighting
export const SCORE_STEP = 0.5;

const c = (key, label, weight, description) => ({ key, label, weight, maxScore: SCORE_MAX, description });

export const DEFAULT_RUBRIC = Object.freeze({
  key: 'default', name: 'Standard project rubric', version: RUBRIC_VERSION,
  criteria: Object.freeze([
    c('functional', 'Functional requirements', 30, 'The project does what the task asked and its core features work.'),
    c('code_quality', 'Code quality and organization', 20, 'Readable, well-structured code in a sensible folder layout.'),
    c('technical', 'Technical implementation', 20, 'Appropriate technologies and sound technical decisions.'),
    c('testing', 'Testing and error handling', 10, 'Tests where they apply, and graceful handling of bad input and failures.'),
    c('documentation', 'Documentation', 10, 'A clear README with setup, usage and testing instructions.'),
    c('repository', 'GitHub repository quality', 10, 'Tidy repository: sensible commits, .gitignore, no secrets or generated files.'),
  ]),
});

// Category-specific rubrics: only the categories listed here differ from the default. Criterion KEYS stay the same so scores remain comparable;
// weights (and descriptions) may change. Every rubric must total exactly 100 (checked when this file loads).
const CATEGORY_OVERRIDES = {
  'data-science': { name: 'Data project rubric', weights: { functional: 25, code_quality: 15, technical: 25, testing: 10, documentation: 15, repository: 10 },
    describe: { technical: 'Sound data handling, analysis methods and interpretation of the results.', documentation: 'README that explains the dataset, method, findings and how to rerun them.' } },
  'machine-learning': { name: 'Machine learning project rubric', weights: { functional: 25, code_quality: 15, technical: 30, testing: 10, documentation: 10, repository: 10 },
    describe: { technical: 'Sound data preparation, model choice and honest evaluation of the model.' } },
  'ui-ux-design': { name: 'UI/UX project rubric', weights: { functional: 30, code_quality: 10, technical: 20, testing: 10, documentation: 20, repository: 10 },
    describe: { documentation: 'Design rationale, user flows and screenshots or prototypes in the repository.' } },
  'cybersecurity': { name: 'Cybersecurity project rubric', weights: { functional: 25, code_quality: 15, technical: 25, testing: 15, documentation: 10, repository: 10 },
    describe: { testing: 'Security testing, input validation and safe handling of failures.' } },
};

function build(slug, o) {
  return Object.freeze({ key: slug, name: o.name, version: RUBRIC_VERSION, criteria: Object.freeze(DEFAULT_RUBRIC.criteria.map((k) =>
    Object.freeze({ ...k, weight: o.weights[k.key], description: o.describe?.[k.key] ?? k.description }))) });
}
const RUBRICS = new Map([['default', DEFAULT_RUBRIC], ...Object.entries(CATEGORY_OVERRIDES).map(([slug, o]) => [slug, build(slug, o)])]);
for (const r of RUBRICS.values()) {
  const total = r.criteria.reduce((n, k) => n + k.weight, 0);
  if (total !== 100) throw new Error(`Rubric "${r.key}" must total 100%, not ${total}%`);
}

export const rubricFor = (category) => RUBRICS.get(category) ?? DEFAULT_RUBRIC;
export const listRubrics = () => [...RUBRICS.values()];
// A plain, mutable copy: this is what gets stored with an evaluation.
export const snapshotRubric = (rubric) => JSON.parse(JSON.stringify(rubric));

const hundredths = (n) => Math.round(n * 100 + 1e-9);

// Validates a (possibly partial) scores object against a rubric. Returns { scores, errors }. `scores` only holds valid, entered values;
// null / '' / undefined mean "not scored yet". Unknown keys, non-numbers, negatives, values above the maximum and values off the 0.5 step are errors.
export function parseScores(input, rubric) {
  const errors = {}; const scores = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!src) return { scores, errors: { scores: 'Send the scores as an object keyed by criterion' } };
  const keys = new Set(rubric.criteria.map((k) => k.key));
  for (const key of Object.keys(src)) if (!keys.has(key)) errors[key] = 'Unknown rubric criterion';
  for (const k of rubric.criteria) {
    const v = src[k.key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'number' && typeof v !== 'string') { errors[k.key] = 'Enter a number'; continue; }
    const n = typeof v === 'string' ? (/^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN) : v;
    if (!Number.isFinite(n)) errors[k.key] = typeof v === 'string' && /^\s*-/.test(v) ? 'Scores cannot be negative' : 'Enter a number';
    else if (n < 0) errors[k.key] = 'Scores cannot be negative';
    else if (n > k.maxScore) errors[k.key] = `The maximum for ${k.label} is ${k.maxScore}`;
    else if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) errors[k.key] = `Use steps of ${SCORE_STEP} (for example 7 or 7.5)`;
    else scores[k.key] = n;
  }
  return { scores, errors };
}

// Pure calculation. `scores` must already be valid. total is null until every criterion is scored (an incomplete evaluation has no total);
// partialTotal is the points earned so far, for the live display.
export function calculate(rubric, scores) {
  let earned = 0; let scored = 0;
  const rows = rubric.criteria.map((k) => {
    const s = scores?.[k.key];
    const has = typeof s === 'number';
    const exact = has ? (s * k.weight) / k.maxScore : null;
    if (has) { earned += hundredths(exact); scored += 1; }
    return { key: k.key, label: k.label, weight: k.weight, maxScore: k.maxScore, score: has ? s : null, contribution: has ? hundredths(exact) / 100 : null, maxContribution: k.weight };
  });
  const missing = rubric.criteria.filter((k) => typeof scores?.[k.key] !== 'number').map((k) => k.key);
  // Sum the exact contributions once (not the already-rounded ones) so the total is correct to the cent.
  const exactTotal = rubric.criteria.reduce((n, k) => n + (typeof scores?.[k.key] === 'number' ? (scores[k.key] * k.weight) / k.maxScore : 0), 0);
  const partialTotal = hundredths(exactTotal) / 100;
  return { rows, complete: missing.length === 0, missing, scoredCount: scored, partialTotal, total: missing.length === 0 ? partialTotal : null, maxTotal: 100 };
}
