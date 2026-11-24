import { db } from '../db/index.js';
import * as repo from '../db/tasks.js';
import { TASK_LIBRARY } from '../tasks/library/index.js';
import { parseTaskFields } from '../utils/taskValidation.js';

// Stage 09B — loads the built-in task library into task_templates. Idempotent: every library task has a fixed ID derived from its key, and a template
// that already exists (even if an administrator edited, unpublished or archived it) is left exactly as it is. Each task is run through the same
// validator as administrator input, so a mistake in the library fails loudly instead of storing bad content.
export function seedTaskLibrary({ published = true } = {}) {
  return db.transaction(() => {
    let inserted = 0; let existing = 0;
    for (const t of TASK_LIBRARY) {
      const v = parseTaskFields(t, { template: true });
      if (repo.insertSeedTemplate({ ...v, id: t.id }, { published })) inserted += 1; else existing += 1;
    }
    return { inserted, existing, total: TASK_LIBRARY.length };
  })();
}
