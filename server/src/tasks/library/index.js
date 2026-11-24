import { buildCategory } from './build.js';
import { python, java, c } from './programming.js';
import { web, fullstack, cloud, uiux, software } from './web.js';
import { ai, ml, ds, cyber } from './data.js';

// Stage 09B — the full task library: for every category, one Beginner Foundation exercise, three Intermediate Implementation assignments and one
// Practical Internship Project (the final project). Built into plain template objects; seeding is in services/taskLibrarySeed.js.
export const CATEGORY_DEFS = [python, java, c, web, fullstack, ai, ml, ds, cyber, cloud, uiux, software];
export const TASK_LIBRARY = CATEGORY_DEFS.flatMap((cat) => buildCategory(cat, cat.tasks));
