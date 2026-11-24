// Stage 09C — the starter repository for one practical project. It is BUILT FROM THE ASSIGNMENT (title, objectives, deliverables,
// criteria) and contains structure and instructions only: no solution code, no secrets, no student personal data. Files are plain text.
const list = (items, fallback) => (Array.isArray(items) && items.length ? items : [fallback]).map((i) => `- ${String(typeof i === 'string' ? i : i?.title ?? i?.name ?? i?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)}`).filter((l) => l !== '- ').join('\n');
const clean = (s, n = 600) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const GITIGNORE = `# Dependencies and build output
node_modules/
__pycache__/
*.pyc
.venv/
venv/
dist/
build/
target/
*.class

# Local configuration and secrets (never commit these)
.env
.env.*
!.env.example
*.pem
*.key
*.sqlite
*.db

# Editors and operating systems
.vscode/
.idea/
.DS_Store
Thumbs.db
`;

export function buildStarterFiles({ task, repoName }) {
  const title = clean(task.title, 120) || 'ELVORA Internship Project';
  const readme = `# ${title}

> **ELVORA internship assignment.** This repository was created for an ELVORA internship project. It contains the structure and the
> instructions only. The solution is yours to design and build.

## Project objectives
${list(task.learningObjectives, 'Complete the project described below and explain your work in this README.')}

## About this project
${clean(task.shortDescription, 800) || 'See your task page on ELVORA for the full instructions.'}

## Required features and deliverables
${list(task.deliverables, 'Everything listed on your ELVORA task page.')}

## Acceptance criteria
Your work is reviewed against:
${list(task.evaluationCriteria, 'The evaluation criteria on your ELVORA task page.')}

## Repository layout
| Path | Purpose |
| --- | --- |
| \`src/\` | Your source code |
| \`tests/\` | Your tests |
| \`docs/\` | Notes, diagrams and design decisions |
| \`config.example.env\` | Example settings with placeholder values only |

## Installation and running
Replace this section with the exact steps to install, configure and run **your** solution (language version, dependency command, how to run
the program, how to run the tests). Someone who has never seen your project should be able to follow it.

## Rules
- Do not commit API keys, passwords, tokens, \`.env\` files or databases. Copy \`config.example.env\` to \`.env\` locally; \`.env\` is git-ignored.
- Do not put personal information (e-mail, phone number) in code, commits or documentation.
- Commit regularly with clear messages that describe real changes.
- Keep this repository for this project only.

_Repository: \`${repoName}\`_
`;
  return [
    { path: 'README.md', content: readme },
    { path: '.gitignore', content: GITIGNORE },
    { path: 'config.example.env', content: '# Copy to .env and fill in your own values. Never commit .env.\n# EXAMPLE_SETTING=replace-me\n' },
    { path: 'src/README.md', content: '# src\n\nPut your source code here.\n' },
    { path: 'tests/README.md', content: '# tests\n\nPut your tests here and describe how to run them in the main README.\n' },
    { path: 'docs/README.md', content: '# docs\n\nPut design notes, diagrams and screenshots here.\n' },
  ];
}
