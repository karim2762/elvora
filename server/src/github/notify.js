import { insertSafe } from '../db/notifications.js';
import { db } from '../db/index.js';

// Stage 09C Part 2B — GitHub notifications. They go through the existing notifications table (db/notifications.js); this file only holds the wording
// and the idempotency keys. Every call is best-effort: it never throws, so a notification problem cannot undo a submission, link or review.
// Wording is about the REPOSITORY and the workflow; a notification never says a project is approved unless a reviewer decided that (those are written by the review code).
const day = () => new Date().toISOString().slice(0, 10);
const TEXT = {
  github_connected: (c) => ['GitHub account connected', `Your GitHub account${c.login ? ` (${c.login})` : ''} is now connected to ELVORA.`],
  github_repo_created: (c) => ['Repository created', `Your repository for “${c.title}” is ready. Accept the GitHub invitation if you receive one, then start pushing your work.`],
  github_repo_failed: (c) => ['Repository could not be created', `We could not create the repository for “${c.title}”. You can try again, or link a repository you already own.`],
  github_repo_linked: (c) => ['Repository linked', `${c.repo} is now linked to “${c.title}”.`],
  github_verification_failed: (c) => ['Repository verification failed', c.detail ?? `We could not confirm that the repository for “${c.title}” is yours. Link a repository you own.`],
  github_verification_pending: (c) => ['Repository verification pending', c.detail ?? `We have not been able to confirm the repository for “${c.title}” yet. You can check again later.`],
  project_submitted: (c) => ['Project submitted', `Your project “${c.title}” was submitted (version ${c.version}) and is waiting for review.`],
  submission_verified: (c) => ['Submission verification completed', `The repository you submitted for “${c.title}” was verified. A reviewer will now evaluate your work.`],
};
export const GITHUB_NOTIFICATION_TYPES = Object.keys(TEXT);

// kind: a key of TEXT. key: what makes this event unique (a retry produces the same key, so no second row).
export function notifyGithub(kind, { studentId, studentTaskId, key, ...ctx }) {
  try {
    if (!studentId || !TEXT[kind]) return false;
    let enrollmentId = null; let title = ctx.title;
    if (studentTaskId) {
      const r = db.prepare('SELECT st.enrollment_id, t.title FROM student_tasks st JOIN internship_tasks t ON t.id = st.task_id WHERE st.id = ? AND st.student_id = ?').get(studentTaskId, studentId);
      if (!r) return false; // never link a notification to a task that is not this student's
      enrollmentId = r.enrollment_id; title = title ?? r.title;
    }
    const [t, message] = TEXT[kind]({ ...ctx, title });
    return insertSafe({ studentId, type: kind, title: t, message, enrollmentId, studentTaskId: studentTaskId ?? null, dedupeKey: `gh:${kind}:${key ?? `${studentTaskId ?? ''}:${day()}`}` });
  } catch { return false; }
}
