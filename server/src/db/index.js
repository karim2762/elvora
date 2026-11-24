import fs from 'node:fs';
import path from 'node:path';
import Database from './sqlite.js';
import { config } from '../config/index.js';

// SQL lives only in /db. Repositories (students.js, sessions.js, passwordResets.js) are the data-access
// layer, so moving to another SQL database later means rewriting this folder only.
if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ordered, append-only migrations tracked with PRAGMA user_version.
const migrations = [
  /* 1: Stage 04A — students, sessions, password resets */
  `
  CREATE TABLE students (
    id             TEXT PRIMARY KEY,
    full_name      TEXT NOT NULL,
    email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone          TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    college        TEXT NOT NULL,
    degree         TEXT NOT NULL,
    branch         TEXT NOT NULL,
    academic_year  TEXT NOT NULL,
    graduation_year INTEGER NOT NULL,
    skills         TEXT NOT NULL DEFAULT '[]',
    github_url     TEXT,
    linkedin_url   TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_student ON sessions(student_id);
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);
  CREATE TABLE password_resets (
    token_hash  TEXT PRIMARY KEY,
    student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     TEXT
  );
  CREATE INDEX idx_resets_student ON password_resets(student_id);
  `,
  /* 2: Stage 04B — internship applications.
     The UNIQUE(student_id, internship_id) constraint is the final guard against duplicate applications, even
     under concurrent requests. internship_* and the answer columns are a snapshot taken at submission, so an
     application stays readable if the internship or the student's profile changes later. */
  `
  CREATE TABLE applications (
    id                       TEXT PRIMARY KEY,
    student_id               TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    internship_id            TEXT NOT NULL,
    internship_title         TEXT NOT NULL,
    internship_category      TEXT NOT NULL,
    internship_duration_days INTEGER NOT NULL,
    full_name                TEXT NOT NULL,
    email                    TEXT NOT NULL,
    phone                    TEXT NOT NULL,
    college                  TEXT NOT NULL,
    degree                   TEXT NOT NULL,
    branch                   TEXT NOT NULL,
    academic_year            TEXT NOT NULL,
    skills                   TEXT NOT NULL DEFAULT '[]',
    motivation               TEXT NOT NULL,
    terms_accepted_at        TEXT NOT NULL,
    status                   TEXT NOT NULL DEFAULT 'Submitted'
                             CHECK (status IN ('Submitted', 'Under Review', 'Approved', 'Rejected', 'Cancelled')),
    submitted_at             TEXT NOT NULL,
    updated_at               TEXT NOT NULL,
    UNIQUE (student_id, internship_id)
  );
  CREATE INDEX idx_applications_student ON applications(student_id, submitted_at);
  `,
  /* 3: Stage 05B — status history and internship enrollments.
     application_status_history records WHEN each status was set, so the progress timeline shows real dates.
     Rows that existed before this migration get one "Submitted" entry (submitted_at) and, if their status has
     since changed, one entry for the current status dated updated_at. Earlier intermediate dates were never
     recorded, so they stay unknown (the timeline shows the milestone without a date rather than inventing one).
     enrollments is created ONLY by administrators (see routes/admin.js). It links one approved application to the
     internship record the student sees under "My Internship"; the internship title/category/duration come from the
     application snapshot. certificate_* stay NULL until an official certificate is issued (a later stage). */
  `
  CREATE TABLE application_status_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    status         TEXT NOT NULL CHECK (status IN ('Submitted', 'Under Review', 'Approved', 'Rejected', 'Cancelled')),
    changed_at     TEXT NOT NULL
  );
  CREATE INDEX idx_status_history_app ON application_status_history(application_id, id);
  INSERT INTO application_status_history (application_id, status, changed_at)
    SELECT id, 'Submitted', submitted_at FROM applications;
  INSERT INTO application_status_history (application_id, status, changed_at)
    SELECT id, status, updated_at FROM applications WHERE status <> 'Submitted';

  CREATE TABLE enrollments (
    id                    TEXT PRIMARY KEY,
    application_id        TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
    student_id            TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    status                TEXT NOT NULL DEFAULT 'Awaiting Start'
                          CHECK (status IN ('Awaiting Start', 'Active', 'Completed', 'Suspended', 'Cancelled')),
    start_date            TEXT,
    expected_end_date     TEXT,
    assigned_project      TEXT,
    learning_objectives   TEXT NOT NULL DEFAULT '[]',
    instructions          TEXT,
    created_at            TEXT NOT NULL,
    activated_at          TEXT,
    completed_at          TEXT,
    suspended_at          TEXT,
    cancelled_at          TEXT,
    certificate_id        TEXT,
    certificate_issued_at TEXT,
    updated_at            TEXT NOT NULL
  );
  CREATE INDEX idx_enrollments_student ON enrollments(student_id, created_at);
  `,
  /* 4: Stage 05C — official documents and notifications.
     documents rows are created ONLY by administrators (routes/admin.js) when they upload an officially issued PDF.
     Nothing in the platform generates documents (PDF generation is Stage 06). The file itself lives in private storage
     (config.documentsDir) under a random storage_key; the key is never sent to the browser.
     One official document of each type per internship (UNIQUE). notifications are written by backend events only. */
  `
  CREATE TABLE documents (
    id            TEXT PRIMARY KEY,
    student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    type          TEXT NOT NULL CHECK (type IN ('offer_letter', 'certificate')),
    title         TEXT NOT NULL,
    storage_key   TEXT NOT NULL UNIQUE,
    file_name     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    issued_at     TEXT NOT NULL,
    UNIQUE (enrollment_id, type)
  );
  CREATE INDEX idx_documents_student ON documents(student_id, issued_at);
  CREATE TABLE notifications (
    id            TEXT PRIMARY KEY,
    student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    type          TEXT NOT NULL,
    title         TEXT NOT NULL,
    message       TEXT NOT NULL,
    application_id TEXT,
    enrollment_id TEXT,
    document_id   TEXT,
    created_at    TEXT NOT NULL,
    read_at       TEXT
  );
  CREATE INDEX idx_notifications_student ON notifications(student_id, created_at);
  `,
  /* 5: Stage 06A — document system foundation.
     documents is rebuilt (SQLite cannot relax NOT NULL in place) so a record can exist as a Draft before any file does:
     storage_key, file_name, size_bytes, sha256 and issued_at are now nullable and filled when a document is issued.
     New columns: status (Draft | Issued | Revoked), document_number (unique, allocated only at issuance from
     document_sequences), verification_code (unique, printed on the document), application_id / internship_id (references),
     template_version, issued_by, snapshot (the exact data printed, frozen at issuance), created_at, revoked_*.
     Rows from Stage 05C (uploaded PDFs) become Issued with template_version 'uploaded' and no number or verification code.
     The old UNIQUE(enrollment_id, type) becomes a partial unique index that ignores Revoked rows, so a revoked document
     can be replaced while two live documents of one type per internship remain impossible. */
  `
  CREATE TABLE documents_new (
    id                TEXT PRIMARY KEY,
    student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    enrollment_id     TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    application_id    TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    internship_id     TEXT NOT NULL,
    type              TEXT NOT NULL CHECK (type IN ('offer_letter', 'certificate')),
    status            TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Issued', 'Revoked')),
    title             TEXT NOT NULL,
    document_number   TEXT UNIQUE,
    verification_code TEXT UNIQUE,
    template_version  TEXT NOT NULL,
    snapshot          TEXT,
    storage_key       TEXT UNIQUE,
    file_name         TEXT,
    size_bytes        INTEGER,
    sha256            TEXT,
    issued_by         TEXT,
    created_at        TEXT NOT NULL,
    issued_at         TEXT,
    revoked_at        TEXT,
    revoked_reason    TEXT,
    CHECK (status <> 'Issued' OR (issued_at IS NOT NULL AND storage_key IS NOT NULL AND sha256 IS NOT NULL))
  );
  INSERT INTO documents_new (id, student_id, enrollment_id, application_id, internship_id, type, status, title, template_version,
      storage_key, file_name, size_bytes, sha256, issued_by, created_at, issued_at)
    SELECT d.id, d.student_id, d.enrollment_id, e.application_id, a.internship_id, d.type, 'Issued', d.title, 'uploaded',
      d.storage_key, d.file_name, d.size_bytes, d.sha256, 'admin', d.issued_at, d.issued_at
    FROM documents d JOIN enrollments e ON e.id = d.enrollment_id JOIN applications a ON a.id = e.application_id;
  DROP TABLE documents;
  ALTER TABLE documents_new RENAME TO documents;
  CREATE UNIQUE INDEX idx_documents_live ON documents(enrollment_id, type) WHERE status <> 'Revoked';
  CREATE INDEX idx_documents_student ON documents(student_id, issued_at);
  CREATE INDEX idx_documents_status ON documents(status, type);
  CREATE TABLE document_sequences (
    type       TEXT NOT NULL CHECK (type IN ('offer_letter', 'certificate')),
    year       INTEGER NOT NULL,
    last_value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (type, year)
  );
  `,
  /* 6: Stage 06B — PDF issuance audit trail.
     documents.revoked_by records who revoked. document_events is an append-only audit log (created, issued, revoked,
     issue_failed). It has no foreign key on purpose, so the audit trail survives even if a student account is deleted.
     actor is the self-declared administrator name; actor_key is a short fingerprint of the ADMIN_API_KEY that was used
     (the platform has one shared key, so the fingerprint is the only thing that cannot be typed in by the caller). */
  `
  ALTER TABLE documents ADD COLUMN revoked_by TEXT;
  CREATE TABLE document_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    event       TEXT NOT NULL CHECK (event IN ('created', 'issued', 'revoked', 'issue_failed')),
    actor       TEXT,
    actor_key   TEXT,
    detail      TEXT,
    at          TEXT NOT NULL
  );
  CREATE INDEX idx_document_events_doc ON document_events(document_id, id);
  `,
  /* 7: Stage 07 — certificate approval + document automation.
     enrollments.certificate_decision is the administrator's per-intern decision on whether a completion certificate may be
     issued: Pending (nobody decided yet, default), Approved or Declined. A certificate is generated only for Approved.
     automation_state remembers, per internship and document type, how many automatic attempts were made, the last error,
     when to retry, and whether the document e-mail went out, so the background worker never issues or e-mails twice. */
  `
  ALTER TABLE enrollments ADD COLUMN certificate_decision TEXT NOT NULL DEFAULT 'Pending'
    CHECK (certificate_decision IN ('Pending', 'Approved', 'Declined'));
  ALTER TABLE enrollments ADD COLUMN certificate_decided_at TEXT;
  ALTER TABLE enrollments ADD COLUMN certificate_decided_by TEXT;
  ALTER TABLE enrollments ADD COLUMN certificate_decision_note TEXT;
  CREATE TABLE automation_state (
    enrollment_id   TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK (type IN ('offer_letter', 'certificate')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    last_attempt_at TEXT,
    next_attempt_at TEXT,
    emailed_at      TEXT,
    email_attempts  INTEGER NOT NULL DEFAULT 0,
    email_error     TEXT,
    PRIMARY KEY (enrollment_id, type)
  );
  `,
  /* 8: Stage 07A — administrator role.
     students.role is 'student' (default) or 'admin'. It is written ONLY by the server-side script scripts/create-admin.mjs
     (no HTTP route and no request field can set it), so an administrator is an ordinary account that an operator authorized.
     Admin accounts are excluded from every student count, list and announcement. */
  `
  ALTER TABLE students ADD COLUMN role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin'));
  CREATE INDEX idx_students_role ON students(role);
  `,
  /* 9: Stage 07B — internship listings + application review trail.
     internship_listings is the administrator-managed catalogue (title, category, duration, skills, eligibility, outcomes, type,
     difficulty, seats, deadline). is_published controls public visibility, is_active controls whether applications are accepted,
     archived_at hides a listing everywhere but keeps it. applications keep their own snapshot of title/category/duration, so
     editing, archiving or (when no application exists) deleting a listing never rewrites application history.
     application_status_history gains who/why: from_status, changed_by (admin id), changed_by_name, note. Rows written before
     this migration keep NULL there (never invented). application_notes is append-only internal review notes. */
  `
  CREATE TABLE internship_listings (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    category      TEXT NOT NULL,
    description   TEXT NOT NULL,
    duration_days INTEGER NOT NULL CHECK (duration_days IN (7, 30, 60, 90)),
    skills        TEXT NOT NULL DEFAULT '[]',
    eligibility   TEXT NOT NULL DEFAULT '{}',
    outcomes      TEXT NOT NULL DEFAULT '[]',
    type          TEXT NOT NULL,
    difficulty    TEXT NOT NULL,
    seats         INTEGER CHECK (seats IS NULL OR seats > 0),
    deadline      TEXT,
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upcoming')),
    is_published  INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    is_featured   INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
    archived_at   TEXT,
    extra         TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    created_by    TEXT,
    updated_by    TEXT
  );
  CREATE INDEX idx_listings_visible ON internship_listings(is_published, is_active, archived_at);
  ALTER TABLE application_status_history ADD COLUMN from_status TEXT;
  ALTER TABLE application_status_history ADD COLUMN changed_by TEXT;
  ALTER TABLE application_status_history ADD COLUMN changed_by_name TEXT;
  ALTER TABLE application_status_history ADD COLUMN note TEXT;
  CREATE TABLE application_notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    admin_id       TEXT,
    admin_name     TEXT NOT NULL,
    note           TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX idx_app_notes_app ON application_notes(application_id, id);
  `,
  /* 10: Stage 07B — one-time import of the EXISTING catalogue (server/src/data/internshipCatalog.json, generated from the
     internships that were already on the public site) into internship_listings, as published and active. Runs once, so
     a listing an administrator later deletes is never resurrected. Nothing is invented: only existing records are imported. */
  () => {
    const now = new Date().toISOString();
    const file = new URL('../data/internshipCatalog.json', import.meta.url);
    if (!fs.existsSync(file)) return;
    const ins = db.prepare(`INSERT OR IGNORE INTO internship_listings (id, title, category, description, duration_days, skills, eligibility, outcomes,
        type, difficulty, seats, deadline, status, is_published, is_active, is_featured, extra, created_at, updated_at, created_by)
      VALUES (@id, @title, @category, @description, @days, @skills, @eligibility, @outcomes, @type, @difficulty, @seats, @deadline, @status, 1, 1, @featured, @extra, @now, @now, 'catalog-import')`);
    for (const i of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      ins.run({
        id: i.id, title: i.title, category: i.category, description: i.description, days: i.durationDays,
        skills: JSON.stringify(i.skills ?? []), eligibility: JSON.stringify(i.eligibility ?? {}), outcomes: JSON.stringify(i.outcomes ?? []),
        type: i.type ?? 'Project-Based', difficulty: i.difficulty ?? 'Beginner', seats: i.seats ?? null, deadline: i.deadline ?? null,
        status: i.status === 'upcoming' ? 'upcoming' : 'open', featured: i.featured ? 1 : 0, now,
        extra: JSON.stringify({ overview: i.overview, technologies: i.technologies, keywords: i.keywords, structure: i.structure, certificate: i.certificate, postedAt: i.postedAt }),
      });
    }
  },
  /* 11: Stage 07B (part 2) — student account status + internship lifecycle record.
     students.account_status ('active' | 'suspended') is changed only through the administrator API; role is never touched there.
     student_account_history is append-only (who, when, why). enrollments.progress_percent is NULL until an administrator records it.
     enrollment_events is the append-only internship history (activation, progress, suspension, completion, cancellation, details). */
  `
  ALTER TABLE students ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended'));
  CREATE INDEX idx_students_account_status ON students(account_status);
  CREATE TABLE student_account_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    from_status     TEXT NOT NULL,
    to_status       TEXT NOT NULL,
    reason          TEXT,
    changed_by      TEXT,
    changed_by_name TEXT NOT NULL,
    changed_at      TEXT NOT NULL
  );
  CREATE INDEX idx_account_history_student ON student_account_history(student_id, id);
  ALTER TABLE enrollments ADD COLUMN progress_percent INTEGER CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100));
  CREATE TABLE enrollment_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    enrollment_id TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    from_status   TEXT,
    to_status     TEXT,
    detail        TEXT,
    actor_id      TEXT,
    actor_name    TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_enrollment_events_enr ON enrollment_events(enrollment_id, id);
  `,
  /* 12: Stage 07C (part 1) — audit log, platform settings, announcement history.
     audit_logs is append-only: triggers make UPDATE and DELETE fail for every caller (including administrators), so history can only
     be added to. It has no foreign keys, so it survives deletion of any account or record. admin_id is the administrator's account ID
     (or 'key:<fingerprint>' for the shared admin key, or NULL for the automation worker); no e-mail, password or token is ever stored.
     platform_settings holds ONLY administrator overrides of non-secret organization/branding/notification values (secrets stay in the environment).
     announcements keeps one row per sent announcement (audience, recipient count, withdrawal), while the notifications rows that students see
     carry announcement_id so delivery can be counted from real rows and a withdrawal removes exactly those rows. */
  `
  CREATE TABLE audit_logs (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    admin_id    TEXT,
    admin_name  TEXT NOT NULL,
    actor_type  TEXT NOT NULL CHECK (actor_type IN ('admin', 'key', 'system')),
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    result      TEXT NOT NULL CHECK (result IN ('success', 'failure')),
    reason      TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_audit_created ON audit_logs(created_at);
  CREATE INDEX idx_audit_action ON audit_logs(action, created_at);
  CREATE INDEX idx_audit_admin ON audit_logs(admin_id, created_at);
  CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);
  CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
  CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
  CREATE TABLE platform_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE announcements (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    message           TEXT NOT NULL,
    category          TEXT NOT NULL CHECK (category IN ('general', 'important', 'application', 'internship', 'document')),
    audience          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'Sent' CHECK (status IN ('Sent', 'Withdrawn')),
    recipient_count   INTEGER NOT NULL,
    created_by        TEXT,
    created_by_name   TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    sent_at           TEXT NOT NULL,
    withdrawn_at      TEXT,
    withdrawn_by_name TEXT,
    withdraw_reason   TEXT
  );
  CREATE INDEX idx_announcements_sent ON announcements(sent_at);
  ALTER TABLE notifications ADD COLUMN announcement_id TEXT;
  CREATE INDEX idx_notifications_announcement ON notifications(announcement_id);
  `,
  /* 13: Stage 08A — indexes only (no table, column or data change; IF NOT EXISTS so it is safe on any copy of the database).
     - applications(internship_id): the listing screens COUNT applications per listing and the delete guard looks them up; the existing
       UNIQUE (student_id, internship_id) index leads with student_id so it cannot serve that lookup.
     - applications(status, submitted_at): the admin application list filters by status and sorts newest-first.
     - enrollments(status, created_at): lifecycle/automation/admin queries filter by status. */
  `
  CREATE INDEX IF NOT EXISTS idx_applications_internship ON applications(internship_id);
  CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status, submitted_at);
  CREATE INDEX IF NOT EXISTS idx_enrollments_status ON enrollments(status, created_at);
  `,
  /* 14: Stage 09A — internship task management, completion criteria and application evaluation. PURELY ADDITIVE: no existing table,
     column or row is altered (applications.status keeps its five values on purpose; see README, Stage 09A).
     task_templates     reusable, category-level task library (content an administrator writes once).
     internship_tasks   the tasks of ONE internship listing. Content is COPIED from a template when attached, so editing a template never
                        rewrites a live internship; every edit of a live task appends a snapshot to internship_task_revisions.
     student_tasks      one row per (internship record, task): a student's assignment and its review state. UNIQUE(enrollment_id, task_id)
                        is the final guard against duplicate assignment, even under concurrent requests. is_required is a SNAPSHOT taken at
                        assignment, so a later configuration change never silently changes what an enrolled student must finish.
                        task_id is ON DELETE RESTRICT: a task that students have been given can never be deleted (unpublish it instead).
     task_submissions   append-only submission history (version 1, 2, ...). task_reviews is the append-only admin review history.
                        Triggers reject UPDATE on both, so history can only be added to.
     internship_criteria  per-listing configurable criteria, kind 'application' (eligibility checks) or 'completion' (what finishing needs).
     application_evaluations / application_evaluation_reviews  append-only: each evaluation run (criterion-by-criterion results and a
                        RECOMMENDATION that is never a decision) and each administrator's response to it (accepted / overridden / info requested). */
  `
  CREATE TABLE task_templates (
    id                  TEXT PRIMARY KEY,
    category            TEXT NOT NULL,
    title               TEXT NOT NULL,
    short_description   TEXT NOT NULL,
    content             TEXT NOT NULL DEFAULT '{}',
    difficulty          TEXT NOT NULL CHECK (difficulty IN ('Beginner', 'Easy', 'Intermediate')),
    task_type           TEXT NOT NULL CHECK (task_type IN ('Practical Assignment', 'Mini Project', 'Final Project')),
    estimated_hours     INTEGER CHECK (estimated_hours IS NULL OR (estimated_hours >= 1 AND estimated_hours <= 80)),
    min_duration_days   INTEGER CHECK (min_duration_days IS NULL OR min_duration_days IN (7, 30, 60, 90)),
    learning_objectives TEXT NOT NULL DEFAULT '[]',
    required_skills     TEXT NOT NULL DEFAULT '[]',
    deliverables        TEXT NOT NULL DEFAULT '[]',
    evaluation_criteria TEXT NOT NULL DEFAULT '[]',
    resources           TEXT NOT NULL DEFAULT '[]',
    submission_type     TEXT NOT NULL CHECK (submission_type IN ('text', 'repository', 'live_url', 'repository_and_live_url')),
    is_published        INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
    archived_at         TEXT,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    created_by          TEXT,
    updated_by          TEXT
  );
  CREATE INDEX idx_task_templates_category ON task_templates(category, is_published, archived_at);

  CREATE TABLE internship_tasks (
    id                  TEXT PRIMARY KEY,
    internship_id       TEXT NOT NULL REFERENCES internship_listings(id) ON DELETE CASCADE,
    template_id         TEXT REFERENCES task_templates(id) ON DELETE SET NULL,
    title               TEXT NOT NULL,
    short_description   TEXT NOT NULL,
    content             TEXT NOT NULL DEFAULT '{}',
    difficulty          TEXT NOT NULL CHECK (difficulty IN ('Beginner', 'Easy', 'Intermediate')),
    task_type           TEXT NOT NULL CHECK (task_type IN ('Practical Assignment', 'Mini Project', 'Final Project')),
    estimated_hours     INTEGER CHECK (estimated_hours IS NULL OR (estimated_hours >= 1 AND estimated_hours <= 80)),
    learning_objectives TEXT NOT NULL DEFAULT '[]',
    required_skills     TEXT NOT NULL DEFAULT '[]',
    deliverables        TEXT NOT NULL DEFAULT '[]',
    evaluation_criteria TEXT NOT NULL DEFAULT '[]',
    resources           TEXT NOT NULL DEFAULT '[]',
    submission_type     TEXT NOT NULL CHECK (submission_type IN ('text', 'repository', 'live_url', 'repository_and_live_url')),
    sequence            INTEGER NOT NULL CHECK (sequence >= 1),
    is_required         INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0, 1)),
    is_published        INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
    due_after_days      INTEGER CHECK (due_after_days IS NULL OR (due_after_days >= 1 AND due_after_days <= 365)),
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    created_by          TEXT,
    updated_by          TEXT
  );
  CREATE INDEX idx_internship_tasks_listing ON internship_tasks(internship_id, sequence);
  CREATE UNIQUE INDEX idx_internship_tasks_template ON internship_tasks(internship_id, template_id) WHERE template_id IS NOT NULL;
  CREATE TABLE internship_task_revisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    version    INTEGER NOT NULL,
    snapshot   TEXT NOT NULL,
    note       TEXT,
    changed_by TEXT,
    changed_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_task_revisions_task ON internship_task_revisions(task_id, id);
  CREATE TRIGGER task_revisions_no_update BEFORE UPDATE ON internship_task_revisions BEGIN SELECT RAISE(ABORT, 'internship_task_revisions is append-only'); END;

  CREATE TABLE student_tasks (
    id              TEXT PRIMARY KEY,
    enrollment_id   TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    task_id         TEXT NOT NULL REFERENCES internship_tasks(id) ON DELETE RESTRICT,
    status          TEXT NOT NULL DEFAULT 'Assigned' CHECK (status IN ('Assigned', 'In Progress', 'Submitted', 'Changes Requested', 'Approved')),
    review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('Approved', 'Changes Requested')),
    is_required     INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0, 1)),
    task_version    INTEGER NOT NULL DEFAULT 1,
    assigned_at     TEXT NOT NULL,
    due_date        TEXT,
    started_at      TEXT,
    submitted_at    TEXT,
    reviewed_at     TEXT,
    reviewer_id     TEXT,
    reviewer_name   TEXT,
    feedback        TEXT,
    updated_at      TEXT NOT NULL,
    UNIQUE (enrollment_id, task_id)
  );
  CREATE INDEX idx_student_tasks_student ON student_tasks(student_id, status);
  CREATE INDEX idx_student_tasks_enrollment ON student_tasks(enrollment_id, is_required, status);
  CREATE INDEX idx_student_tasks_task ON student_tasks(task_id);
  CREATE TABLE task_submissions (
    id              TEXT PRIMARY KEY,
    student_task_id TEXT NOT NULL REFERENCES student_tasks(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL CHECK (version >= 1),
    description     TEXT NOT NULL,
    repository_url  TEXT,
    live_url        TEXT,
    attachments     TEXT NOT NULL DEFAULT '[]',
    submitted_at    TEXT NOT NULL,
    UNIQUE (student_task_id, version)
  );
  CREATE TRIGGER task_submissions_no_update BEFORE UPDATE ON task_submissions BEGIN SELECT RAISE(ABORT, 'task_submissions is append-only'); END;
  CREATE TABLE task_reviews (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    student_task_id    TEXT NOT NULL REFERENCES student_tasks(id) ON DELETE CASCADE,
    submission_id      TEXT NOT NULL,
    submission_version INTEGER NOT NULL,
    decision           TEXT NOT NULL CHECK (decision IN ('Approved', 'Changes Requested')),
    feedback           TEXT,
    reviewer_id        TEXT,
    reviewer_name      TEXT NOT NULL,
    reviewed_at        TEXT NOT NULL
  );
  CREATE INDEX idx_task_reviews_task ON task_reviews(student_task_id, id);
  CREATE TRIGGER task_reviews_no_update BEFORE UPDATE ON task_reviews BEGIN SELECT RAISE(ABORT, 'task_reviews is append-only'); END;

  CREATE TABLE internship_criteria (
    internship_id TEXT NOT NULL REFERENCES internship_listings(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('application', 'completion')),
    config        TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    updated_by    TEXT,
    PRIMARY KEY (internship_id, kind)
  );

  CREATE TABLE application_evaluations (
    id                TEXT PRIMARY KEY,
    application_id    TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    status_at_time    TEXT NOT NULL,
    recommendation    TEXT NOT NULL CHECK (recommendation IN ('recommend_approval', 'needs_review')),
    criteria          TEXT NOT NULL,
    config            TEXT NOT NULL,
    evaluated_by      TEXT,
    evaluated_by_name TEXT NOT NULL,
    evaluated_at      TEXT NOT NULL
  );
  CREATE INDEX idx_evaluations_app ON application_evaluations(application_id, evaluated_at);
  CREATE TRIGGER evaluations_no_update BEFORE UPDATE ON application_evaluations BEGIN SELECT RAISE(ABORT, 'application_evaluations is append-only'); END;
  CREATE TABLE application_evaluation_reviews (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id  TEXT NOT NULL REFERENCES application_evaluations(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL,
    action         TEXT NOT NULL CHECK (action IN ('accepted', 'overridden', 'information_requested')),
    reason         TEXT,
    admin_id       TEXT,
    admin_name     TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX idx_evaluation_reviews_app ON application_evaluation_reviews(application_id, id);
  CREATE TRIGGER evaluation_reviews_no_update BEFORE UPDATE ON application_evaluation_reviews BEGIN SELECT RAISE(ABORT, 'application_evaluation_reviews is append-only'); END;
  `,
  /* 15: Stage 09B Part 2A — GitHub project submissions. PURELY ADDITIVE: only nullable columns are added, so every existing
     submission and review row keeps its data and keeps working (old rows simply read NULL for the new fields).
     task_submissions  repository_description (what the repository contains), documentation_url (accessible docs link),
                       submission_notes (anything the student wants the reviewer to know). repository_url / live_url already exist.
     task_reviews      score (0-100) and score_breakdown (JSON) are reserved for the administrator evaluation system (Part 2B);
                       nothing in 2A writes them, and no student route can. decision / feedback already hold the admin decision and feedback.
     Both tables stay append-only (their UPDATE triggers are untouched). Submission status is derived from student_tasks.status. */
  `
  ALTER TABLE task_submissions ADD COLUMN repository_description TEXT;
  ALTER TABLE task_submissions ADD COLUMN documentation_url TEXT;
  ALTER TABLE task_submissions ADD COLUMN submission_notes TEXT;
  ALTER TABLE task_reviews ADD COLUMN score INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100));
  ALTER TABLE task_reviews ADD COLUMN score_breakdown TEXT;
  CREATE INDEX idx_task_submissions_repo ON task_submissions(repository_url) WHERE repository_url IS NOT NULL;
  `,
  /* 16: Stage 09B Part 2B — administrator project evaluation. PURELY ADDITIVE.
     student_tasks.project_status  refines the stored status without touching its five Stage 09A values: NULL (normal), 'Under Review'
                       (status stays 'Submitted') or 'Rejected' (status stays 'Changes Requested', which no completion rule counts as done).
                       The seven student-facing statuses are derived from (status, project_status, submission count) in tasks/githubSubmission.js.
     project_evaluations  one row per evaluation of ONE submission version: the rubric SNAPSHOT used, the scores, the weighted total, feedback and
                       the explicit decision. A 'Draft' can be edited; saving never changes a 'Final' row: a trigger rejects every UPDATE of a finalized
                       evaluation, so decisions are only ever added to. 'Superseded' marks a draft that an older-style review made obsolete.
                       Unique partial indexes allow one open draft per task and one final decision per submission, even under concurrent requests. */
  `
  ALTER TABLE student_tasks ADD COLUMN project_status TEXT CHECK (project_status IS NULL OR project_status IN ('Under Review', 'Rejected'));
  CREATE TABLE project_evaluations (
    id                 TEXT PRIMARY KEY,
    student_task_id    TEXT NOT NULL REFERENCES student_tasks(id) ON DELETE CASCADE,
    submission_id      TEXT NOT NULL REFERENCES task_submissions(id),
    submission_version INTEGER NOT NULL,
    rubric_key         TEXT NOT NULL,
    rubric_version     INTEGER NOT NULL,
    rubric             TEXT NOT NULL,
    scores             TEXT NOT NULL DEFAULT '{}',
    weighted_total     REAL CHECK (weighted_total IS NULL OR (weighted_total >= 0 AND weighted_total <= 100)),
    feedback           TEXT,
    status             TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Final', 'Superseded')),
    decision           TEXT CHECK (decision IS NULL OR decision IN ('Approved', 'Changes Requested', 'Rejected')),
    admin_id           TEXT NOT NULL,
    admin_name         TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    decided_at         TEXT,
    CHECK ((status = 'Final' AND decision IS NOT NULL AND decided_at IS NOT NULL AND weighted_total IS NOT NULL) OR (status <> 'Final' AND decision IS NULL AND decided_at IS NULL))
  );
  CREATE INDEX idx_project_evaluations_task ON project_evaluations(student_task_id, created_at);
  CREATE UNIQUE INDEX idx_project_evaluations_one_draft ON project_evaluations(student_task_id) WHERE status = 'Draft';
  CREATE UNIQUE INDEX idx_project_evaluations_one_final ON project_evaluations(submission_id) WHERE status = 'Final';
  CREATE TRIGGER project_evaluations_final_immutable BEFORE UPDATE ON project_evaluations WHEN OLD.status = 'Final'
    BEGIN SELECT RAISE(ABORT, 'a finalized project evaluation is immutable'); END;
  `,
  /* 17: Stage 09C Part 1 — GitHub integration. PURELY ADDITIVE (no existing table is changed).
     github_accounts      one verified GitHub identity per ELVORA student (and one student per GitHub account: github_user_id is UNIQUE).
                          Tokens are stored ENCRYPTED (AES-256-GCM) and never leave the server.
     github_oauth_states  single-use, 10-minute OAuth state + PKCE verifier (state itself is stored only as a hash).
     github_repositories  the repository of ONE student task: created in the ELVORA organisation, or linked (student-owned / manual URL).
                          Partial unique indexes: one live repository per task, and one live link per GitHub repository (case-insensitive).
     github_repository_snapshots  append-only inspection evidence (what GitHub reported, and when).
     github_webhook_events  one row per delivery id (deduplication + outcome); signatures are verified before anything is stored. */
  `
  CREATE TABLE github_accounts (
    student_id          TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    github_user_id      INTEGER NOT NULL UNIQUE,
    login               TEXT NOT NULL,
    account_type        TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('verified', 'revoked')),
    access_token_enc    TEXT,
    refresh_token_enc   TEXT,
    token_expires_at    TEXT,
    verified_at         TEXT NOT NULL,
    connected_at        TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
  CREATE TABLE github_oauth_states (
    state_hash   TEXT PRIMARY KEY,
    student_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    verifier_enc TEXT NOT NULL,
    expires_at   INTEGER NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE github_repositories (
    id                    TEXT PRIMARY KEY,
    student_task_id       TEXT NOT NULL REFERENCES student_tasks(id) ON DELETE CASCADE,
    student_id            TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    enrollment_id         TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    internship_id         TEXT NOT NULL,
    source                TEXT NOT NULL CHECK (source IN ('organization', 'student_owned', 'manual_url')),
    github_repo_id        INTEGER,
    owner                 TEXT NOT NULL,
    name                  TEXT NOT NULL,
    url                   TEXT NOT NULL,
    visibility            TEXT,
    state                 TEXT NOT NULL CHECK (state IN ('creating', 'active', 'failed', 'unavailable', 'unlinked')),
    setup_error           TEXT,
    ownership_status      TEXT NOT NULL DEFAULT 'unverified' CHECK (ownership_status IN ('unverified', 'verified', 'not_owner')),
    ownership_verified_at TEXT,
    created_by            TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_github_repos_task ON github_repositories(student_task_id) WHERE state <> 'unlinked';
  CREATE UNIQUE INDEX idx_github_repos_full_name ON github_repositories(lower(owner), lower(name)) WHERE state <> 'unlinked';
  CREATE INDEX idx_github_repos_student ON github_repositories(student_id);
  CREATE TABLE github_repository_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id TEXT NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'access_denied', 'rate_limited', 'error')),
    data          TEXT NOT NULL DEFAULT '{}',
    requested_by  TEXT,
    inspected_at  TEXT NOT NULL
  );
  CREATE INDEX idx_github_snapshots_repo ON github_repository_snapshots(repository_id, id);
  CREATE TRIGGER github_snapshots_no_update BEFORE UPDATE ON github_repository_snapshots BEGIN SELECT RAISE(ABORT, 'github_repository_snapshots is append-only'); END;
  CREATE TABLE github_webhook_events (
    delivery_id          TEXT PRIMARY KEY,
    event                TEXT NOT NULL,
    action               TEXT,
    repository_full_name TEXT,
    outcome              TEXT NOT NULL,
    received_at          TEXT NOT NULL
  );
  `,
  /* 18: Stage 09C Part 2A — GitHub project submissions and evidence review. PURELY ADDITIVE.
     task_submissions  implemented_features, testing_performed, challenges_encountered (the student's own words; the table stays append-only,
                       ADD COLUMN is not an UPDATE, so every earlier version is untouched).
     github_submission_checks  what the server could confirm about the repository AT THE MOMENT a version was submitted (one row per version,
                       append-only). 'pending_verification' means GitHub could not be asked (not set up, outage, rate limit). It never means approved.
     project_review_notes  INTERNAL administrator notes on a project. Append-only; no student route reads this table. */
  `
  ALTER TABLE task_submissions ADD COLUMN implemented_features TEXT;
  ALTER TABLE task_submissions ADD COLUMN testing_performed TEXT;
  ALTER TABLE task_submissions ADD COLUMN challenges_encountered TEXT;
  CREATE TABLE github_submission_checks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id    TEXT NOT NULL UNIQUE REFERENCES task_submissions(id) ON DELETE CASCADE,
    student_task_id  TEXT NOT NULL REFERENCES student_tasks(id) ON DELETE CASCADE,
    repository_id    TEXT,
    repository_url   TEXT NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('verified', 'pending_verification')),
    reason           TEXT,
    ownership_status TEXT,
    visibility       TEXT,
    checked_at       TEXT NOT NULL
  );
  CREATE TRIGGER github_submission_checks_no_update BEFORE UPDATE ON github_submission_checks BEGIN SELECT RAISE(ABORT, 'github_submission_checks is append-only'); END;
  CREATE TABLE project_review_notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_task_id TEXT NOT NULL REFERENCES student_tasks(id) ON DELETE CASCADE,
    submission_id   TEXT,
    submission_version INTEGER,
    admin_id        TEXT,
    admin_name      TEXT NOT NULL,
    note            TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX idx_project_review_notes_task ON project_review_notes(student_task_id, id);
  CREATE TRIGGER project_review_notes_no_update BEFORE UPDATE ON project_review_notes BEGIN SELECT RAISE(ABORT, 'project_review_notes is append-only'); END;
  `,
  /* 19: Stage 09C Part 2B — notification links and idempotency, and push-driven evidence invalidation. PURELY ADDITIVE.
     notifications.student_task_id  the task a notification is about (so the app can open it).
     notifications.dedupe_key       idempotency key: a retried request or a re-delivered webhook cannot create the same notification twice
                                    (partial unique index; rows without a key, i.e. every pre-09C notification, are unaffected).
     github_repositories.evidence_stale_at  set by a push/visibility/installation event; evidence older than this is 'outdated' until re-inspected
                                    (no GitHub call is made by the event itself). */
  `
  ALTER TABLE notifications ADD COLUMN student_task_id TEXT;
  ALTER TABLE notifications ADD COLUMN dedupe_key TEXT;
  CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(student_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
  ALTER TABLE github_repositories ADD COLUMN evidence_stale_at TEXT;
  `,
  /* 20: Stage 09D audit — two missing indexes found with EXPLAIN QUERY PLAN. PURELY ADDITIVE (no table, column or row changes).
     idx_github_repos_github_id         every webhook delivery looks repositories up by GitHub's numeric id; this was a full table scan.
     idx_github_checks_student_task     the per-task submission checks are read on every student history and admin evidence view; was a full scan. */
  `
  CREATE INDEX IF NOT EXISTS idx_github_repos_github_id ON github_repositories(github_repo_id) WHERE github_repo_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_github_checks_student_task ON github_submission_checks(student_task_id);
  `,
  /* 21: Stage 10A Part 1 — private Priority Certificate Processing. PURELY ADDITIVE (new tables only; no existing table or row changes).
     priority_pricing           server-side price list. A price is never edited in place: a new row replaces the active one (partial unique index),
                                so earlier requests keep the price they were shown. Amounts are integer paise. No payment is taken in this stage.
     priority_invitations       private access. Only an HMAC of the token is stored. Optionally bound to one student; expires; revocable; max_uses.
     priority_requests          one request per internship record while open (partial unique index). Carries a frozen price snapshot.
                                Payment statuses are placeholders for Stage 10B; nothing in this stage moves a request into them.
     priority_eligibility_checks append-only record of what the backend concluded each time (audit trail; never trusted as input).
     priority_request_history   append-only status history. */
  `
  CREATE TABLE priority_pricing (
    id            TEXT PRIMARY KEY,
    duration_days INTEGER NOT NULL CHECK (duration_days IN (30, 60, 90)),
    months        INTEGER NOT NULL CHECK (months IN (1, 2, 3)),
    amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),
    currency      TEXT NOT NULL DEFAULT 'INR',
    tax_note      TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at    TEXT NOT NULL,
    retired_at    TEXT
  );
  CREATE UNIQUE INDEX idx_priority_pricing_active ON priority_pricing(duration_days) WHERE active = 1;
  INSERT INTO priority_pricing (id, duration_days, months, amount_paise, currency, tax_note, active, created_at) VALUES
    ('PRC-30-V1', 30, 1, 4900, 'INR', 'Proposed GST-inclusive customer price, subject to confirmation of GST registration and tax treatment.', 1, '2026-01-01T00:00:00.000Z'),
    ('PRC-60-V1', 60, 2, 9900, 'INR', 'Proposed GST-inclusive customer price, subject to confirmation of GST registration and tax treatment.', 1, '2026-01-01T00:00:00.000Z'),
    ('PRC-90-V1', 90, 3, 19900, 'INR', 'Proposed GST-inclusive customer price, subject to confirmation of GST registration and tax treatment.', 1, '2026-01-01T00:00:00.000Z');

  CREATE TABLE priority_invitations (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    student_id  TEXT REFERENCES students(id) ON DELETE CASCADE,
    max_uses    INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
    use_count   INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    redeemed_by TEXT REFERENCES students(id) ON DELETE CASCADE,
    redeemed_at TEXT,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_priority_invitations_student ON priority_invitations(redeemed_by);

  CREATE TABLE priority_requests (
    id                  TEXT PRIMARY KEY,
    student_id          TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    application_id      TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    enrollment_id       TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Eligibility Check', 'Awaiting Payment', 'Payment Pending', 'Payment Verified',
                          'Under Review', 'Approved for Issuance', 'Certificate Issued', 'Rejected', 'Correction Required', 'Cancelled', 'Refunded')),
    duration_days       INTEGER NOT NULL,
    price_id            TEXT NOT NULL REFERENCES priority_pricing(id),
    amount_paise        INTEGER NOT NULL,
    currency            TEXT NOT NULL,
    tax_note            TEXT NOT NULL,
    personal_confirmed_at TEXT,
    academic_confirmed_at TEXT,
    last_check_id       TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
  CREATE INDEX idx_priority_requests_student ON priority_requests(student_id, created_at);
  CREATE UNIQUE INDEX idx_priority_requests_open ON priority_requests(enrollment_id)
    WHERE status NOT IN ('Rejected', 'Cancelled', 'Refunded', 'Certificate Issued');

  CREATE TABLE priority_eligibility_checks (
    id            TEXT PRIMARY KEY,
    student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL,
    enrollment_id TEXT,
    state         TEXT NOT NULL,
    eligible      INTEGER NOT NULL CHECK (eligible IN (0, 1)),
    reasons       TEXT NOT NULL,
    checks        TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_priority_checks_student ON priority_eligibility_checks(student_id, created_at);

  CREATE TABLE priority_request_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  TEXT NOT NULL REFERENCES priority_requests(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status   TEXT NOT NULL,
    note        TEXT,
    actor       TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_priority_history_request ON priority_request_history(request_id, id);
  CREATE TRIGGER priority_history_no_update BEFORE UPDATE ON priority_request_history BEGIN SELECT RAISE(ABORT, 'priority_request_history is append-only'); END;
  CREATE TRIGGER priority_history_no_delete BEFORE DELETE ON priority_request_history BEGIN SELECT RAISE(ABORT, 'priority_request_history is append-only'); END;
  CREATE TRIGGER priority_checks_no_update BEFORE UPDATE ON priority_eligibility_checks BEGIN SELECT RAISE(ABORT, 'priority_eligibility_checks is append-only'); END;
  `,
  /* 22: Stage 10A Part 2 — admin priority request management + free administrative corrections. PURELY ADDITIVE (new tables, two nullable columns).
     priority_requests.document_id        the certificate a request ended in (set only when an administrator issues through the Stage 06 service).
     priority_request_notes               internal admin notes (append-only; never shown to students).
     free_corrections                     one row per free correction of an ELVORA error. fee_paise is CHECKed to 0: a correction can never carry a fee.
                                          original_values / corrected_values / original_snapshot / new_snapshot are frozen JSON, so the original is never lost.
     free_correction_history              append-only status history of a correction.
     document_replacements                old document -> replacement document. The old document stays in `documents` (status Revoked, reason 'Superseded');
                                          this row is what lets verification show it as Superseded and point at the replacement. Append-only.
     Existing document statuses are NOT changed (no rebuild of `documents`): "Superseded" is Revoked + a replacement link. */
  `
  ALTER TABLE priority_requests ADD COLUMN document_id TEXT;
  CREATE INDEX idx_priority_requests_status ON priority_requests(status, created_at);
  CREATE INDEX idx_priority_requests_application ON priority_requests(application_id);

  CREATE TABLE priority_request_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  TEXT NOT NULL REFERENCES priority_requests(id) ON DELETE CASCADE,
    admin_id    TEXT,
    admin_name  TEXT NOT NULL,
    note        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_priority_notes_request ON priority_request_notes(request_id, id);
  CREATE TRIGGER priority_notes_no_update BEFORE UPDATE ON priority_request_notes BEGIN SELECT RAISE(ABORT, 'priority_request_notes is append-only'); END;
  CREATE TRIGGER priority_notes_no_delete BEFORE DELETE ON priority_request_notes BEGIN SELECT RAISE(ABORT, 'priority_request_notes is append-only'); END;

  CREATE TABLE free_corrections (
    id                   TEXT PRIMARY KEY,
    student_id           TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    enrollment_id        TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    document_id          TEXT NOT NULL REFERENCES documents(id),
    category             TEXT NOT NULL CHECK (category IN ('student_name', 'internship_dates', 'academic_info', 'wrong_application', 'document_service_error', 'certificate_details')),
    status               TEXT NOT NULL DEFAULT 'Pending Approval' CHECK (status IN ('Pending Approval', 'Processing', 'Reissued', 'Failed', 'Cancelled')),
    fee_paise            INTEGER NOT NULL DEFAULT 0 CHECK (fee_paise = 0),
    reason               TEXT NOT NULL,
    evidence             TEXT NOT NULL,
    original_values      TEXT NOT NULL,
    corrected_values     TEXT NOT NULL,
    original_snapshot    TEXT,
    new_snapshot         TEXT,
    replacement_document_id TEXT REFERENCES documents(id),
    reserved_number      TEXT,
    reserved_code        TEXT,
    failure_code         TEXT,
    created_by           TEXT,
    created_by_name      TEXT NOT NULL,
    approved_by          TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    resolved_at          TEXT
  );
  CREATE INDEX idx_free_corrections_student ON free_corrections(student_id, created_at);
  CREATE INDEX idx_free_corrections_status ON free_corrections(status, created_at);
  CREATE UNIQUE INDEX idx_free_corrections_open ON free_corrections(document_id) WHERE status IN ('Pending Approval', 'Processing', 'Failed');

  CREATE TABLE free_correction_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    correction_id  TEXT NOT NULL REFERENCES free_corrections(id) ON DELETE CASCADE,
    from_status    TEXT,
    to_status      TEXT NOT NULL,
    note           TEXT,
    actor          TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX idx_free_correction_history ON free_correction_history(correction_id, id);
  CREATE TRIGGER free_correction_history_no_update BEFORE UPDATE ON free_correction_history BEGIN SELECT RAISE(ABORT, 'free_correction_history is append-only'); END;
  CREATE TRIGGER free_correction_history_no_delete BEFORE DELETE ON free_correction_history BEGIN SELECT RAISE(ABORT, 'free_correction_history is append-only'); END;

  CREATE TABLE document_replacements (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    old_document_id    TEXT NOT NULL UNIQUE REFERENCES documents(id),
    new_document_id    TEXT NOT NULL UNIQUE REFERENCES documents(id),
    correction_id      TEXT NOT NULL REFERENCES free_corrections(id),
    created_at         TEXT NOT NULL,
    CHECK (old_document_id <> new_document_id)
  );
  CREATE TRIGGER document_replacements_no_update BEFORE UPDATE ON document_replacements BEGIN SELECT RAISE(ABORT, 'document_replacements is append-only'); END;
  CREATE TRIGGER document_replacements_no_delete BEFORE DELETE ON document_replacements BEGIN SELECT RAISE(ABORT, 'document_replacements is append-only'); END;
  `,
  /* 23: Stage 10B Part 1 — manual UPI payment foundation. ADDITIVE (new tables + one column on priority_pricing; existing request statuses are reused).
     admin_permissions        who may change pricing / UPI configuration / review payments (role 'admin' alone is not enough).
     payment_config           single row: official UPI ID, payee, instructions, support contact, verification target, enable switches. No secrets.
     priority_pricing.version + priority_pricing_versions + priority_pricing_changes   versioned prices; every change is recorded (append-only). Old rows are kept,
                              so a request/payment that snapshotted a price never changes when pricing is edited.
     priority_payments        one payment order per request attempt: frozen amount, pricing version and payee snapshot.
     priority_payment_submissions  the student's UTR submission (append-only, UTR globally unique): the original is never edited or deleted.
     priority_payment_proofs  private proof files (staged by the student, linked when the UTR is submitted).
     priority_payment_events  append-only timeline. */
  `
  CREATE TABLE admin_permissions (
    admin_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('pricing.manage', 'payment.configure', 'payment.review')),
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (admin_id, permission)
  );
  CREATE TABLE payment_config (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    upi_id               TEXT,
    payee_name           TEXT,
    instructions         TEXT,
    support_contact      TEXT,
    verification_hours   INTEGER NOT NULL DEFAULT 24 CHECK (verification_hours BETWEEN 1 AND 168),
    manual_enabled       INTEGER NOT NULL DEFAULT 0 CHECK (manual_enabled IN (0, 1)),
    submissions_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (submissions_enabled IN (0, 1)),
    updated_at           TEXT,
    updated_by           TEXT,
    updated_by_name      TEXT
  );
  INSERT INTO payment_config (id) VALUES (1);

  ALTER TABLE priority_pricing ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE priority_pricing_versions (
    version         INTEGER PRIMARY KEY,
    created_at      TEXT NOT NULL,
    created_by      TEXT,
    created_by_name TEXT NOT NULL
  );
  INSERT INTO priority_pricing_versions (version, created_at, created_by, created_by_name) VALUES (1, '2026-01-01T00:00:00.000Z', NULL, 'Initial pricing');
  CREATE TABLE priority_pricing_changes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    version        INTEGER NOT NULL REFERENCES priority_pricing_versions(version),
    duration_days  INTEGER NOT NULL,
    previous_paise INTEGER NOT NULL,
    new_paise      INTEGER NOT NULL,
    admin_id       TEXT,
    admin_name     TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  CREATE TRIGGER pricing_changes_no_update BEFORE UPDATE ON priority_pricing_changes BEGIN SELECT RAISE(ABORT, 'priority_pricing_changes is append-only'); END;
  CREATE TRIGGER pricing_changes_no_delete BEFORE DELETE ON priority_pricing_changes BEGIN SELECT RAISE(ABORT, 'priority_pricing_changes is append-only'); END;

  CREATE TABLE priority_payments (
    id                    TEXT PRIMARY KEY,
    internal_reference    TEXT UNIQUE,
    request_id            TEXT NOT NULL REFERENCES priority_requests(id) ON DELETE CASCADE,
    student_id            TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    application_id        TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    enrollment_id         TEXT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    duration_days         INTEGER NOT NULL CHECK (duration_days IN (30, 60, 90)),
    expected_paise        INTEGER NOT NULL CHECK (expected_paise > 0),
    currency              TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    price_id              TEXT NOT NULL REFERENCES priority_pricing(id),
    pricing_version       INTEGER NOT NULL,
    payee_upi_id          TEXT NOT NULL,
    payee_name            TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT' CHECK (status IN ('NOT_STARTED', 'AWAITING_PAYMENT', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED')),
    created_at            TEXT NOT NULL,
    expires_at            TEXT NOT NULL,
    submitted_at          TEXT,
    verification_deadline TEXT,
    updated_at            TEXT NOT NULL
  );
  CREATE INDEX idx_priority_payments_student ON priority_payments(student_id, created_at);
  CREATE INDEX idx_priority_payments_request ON priority_payments(request_id);
  CREATE INDEX idx_priority_payments_status ON priority_payments(status, verification_deadline);
  CREATE UNIQUE INDEX idx_priority_payments_live ON priority_payments(request_id)
    WHERE status IN ('NOT_STARTED', 'AWAITING_PAYMENT', 'PENDING_VERIFICATION', 'VERIFIED', 'REFUND_PENDING');

  CREATE TABLE priority_payment_proofs (
    id          TEXT PRIMARY KEY,
    payment_id  TEXT NOT NULL REFERENCES priority_payments(id) ON DELETE CASCADE,
    student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    file_name   TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    linked      INTEGER NOT NULL DEFAULT 0 CHECK (linked IN (0, 1)),
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_priority_proofs_payment ON priority_payment_proofs(payment_id);

  CREATE TABLE priority_payment_submissions (
    id            TEXT PRIMARY KEY,
    payment_id    TEXT NOT NULL UNIQUE REFERENCES priority_payments(id) ON DELETE CASCADE,
    student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    utr           TEXT NOT NULL UNIQUE,
    amount_paise  INTEGER NOT NULL,
    payment_date  TEXT NOT NULL,
    payment_time  TEXT NOT NULL,
    upi_app       TEXT,
    note          TEXT,
    proof_id      TEXT REFERENCES priority_payment_proofs(id),
    submitted_at  TEXT NOT NULL
  );
  CREATE INDEX idx_priority_submissions_student ON priority_payment_submissions(student_id);
  CREATE TRIGGER payment_submissions_no_update BEFORE UPDATE ON priority_payment_submissions BEGIN SELECT RAISE(ABORT, 'priority_payment_submissions is append-only'); END;
  CREATE TRIGGER payment_submissions_no_delete BEFORE DELETE ON priority_payment_submissions BEGIN SELECT RAISE(ABORT, 'priority_payment_submissions is append-only'); END;

  CREATE TABLE priority_payment_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id  TEXT NOT NULL REFERENCES priority_payments(id) ON DELETE CASCADE,
    event       TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    actor       TEXT NOT NULL,
    note        TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_priority_payment_events ON priority_payment_events(payment_id, id);
  CREATE TRIGGER payment_events_no_update BEFORE UPDATE ON priority_payment_events BEGIN SELECT RAISE(ABORT, 'priority_payment_events is append-only'); END;
  CREATE TRIGGER payment_events_no_delete BEFORE DELETE ON priority_payment_events BEGIN SELECT RAISE(ABORT, 'priority_payment_events is append-only'); END;
  `,
  /* 24: Stage 10B Part 2A — administrator verification, duplicate protection, audited resubmission. ADDITIVE except that priority_payment_submissions is rebuilt
     (SQLite cannot drop a UNIQUE constraint) so a payment can hold several append-only REVISIONS, each linked to the one it replaces. All rows are copied unchanged.
     priority_payment_reviews    one append-only admin decision per submission (UNIQUE submission_id: a submission can be decided only once).
     confirmed_payment_utrs      one row per CONFIRMED transaction reference: PRIMARY KEY(utr) is the database guarantee that a UTR backs at most one confirmed payment.
     priority_payments.*         verification / rejection summary columns; triggers freeze amount/owner and stop a VERIFIED payment from being edited or re-submitted. */
  `
  CREATE TABLE priority_payment_submissions_v2 (
    id                     TEXT PRIMARY KEY,
    payment_id             TEXT NOT NULL REFERENCES priority_payments(id) ON DELETE CASCADE,
    student_id             TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    utr                    TEXT NOT NULL,
    amount_paise           INTEGER NOT NULL,
    payment_date           TEXT NOT NULL,
    payment_time           TEXT NOT NULL,
    upi_app                TEXT,
    note                   TEXT,
    proof_id               TEXT REFERENCES priority_payment_proofs(id),
    submitted_at           TEXT NOT NULL,
    revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    previous_submission_id TEXT REFERENCES priority_payment_submissions_v2(id),
    replacement_reason     TEXT,
    UNIQUE (payment_id, revision),
    CHECK ((revision = 1 AND previous_submission_id IS NULL) OR (revision > 1 AND previous_submission_id IS NOT NULL AND replacement_reason IS NOT NULL))
  );
  INSERT INTO priority_payment_submissions_v2 (id, payment_id, student_id, utr, amount_paise, payment_date, payment_time, upi_app, note, proof_id, submitted_at)
    SELECT id, payment_id, student_id, utr, amount_paise, payment_date, payment_time, upi_app, note, proof_id, submitted_at FROM priority_payment_submissions;
  DROP TABLE priority_payment_submissions;
  ALTER TABLE priority_payment_submissions_v2 RENAME TO priority_payment_submissions;
  CREATE INDEX idx_priority_submissions_student ON priority_payment_submissions(student_id);
  CREATE INDEX idx_priority_submissions_utr ON priority_payment_submissions(utr);
  CREATE INDEX idx_priority_submissions_payment ON priority_payment_submissions(payment_id, revision);
  CREATE TRIGGER payment_submissions_no_update BEFORE UPDATE ON priority_payment_submissions BEGIN SELECT RAISE(ABORT, 'priority_payment_submissions is append-only'); END;
  CREATE TRIGGER payment_submissions_no_delete BEFORE DELETE ON priority_payment_submissions BEGIN SELECT RAISE(ABORT, 'priority_payment_submissions is append-only'); END;
  CREATE TRIGGER payment_submissions_not_when_verified BEFORE INSERT ON priority_payment_submissions
    WHEN (SELECT status FROM priority_payments WHERE id = NEW.payment_id) IN ('VERIFIED', 'REFUND_PENDING', 'REFUNDED')
    BEGIN SELECT RAISE(ABORT, 'a verified payment cannot receive a new submission'); END;

  CREATE TABLE priority_payment_reviews (
    id            TEXT PRIMARY KEY,
    payment_id    TEXT NOT NULL REFERENCES priority_payments(id) ON DELETE CASCADE,
    submission_id TEXT NOT NULL UNIQUE REFERENCES priority_payment_submissions(id),
    decision      TEXT NOT NULL CHECK (decision IN ('VERIFIED', 'REJECTED')),
    reason_code   TEXT,
    note          TEXT,
    acknowledgements TEXT,
    admin_id      TEXT NOT NULL,
    admin_name    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    CHECK (decision = 'VERIFIED' OR reason_code IS NOT NULL)
  );
  CREATE INDEX idx_priority_reviews_payment ON priority_payment_reviews(payment_id, created_at);
  CREATE TRIGGER payment_reviews_no_update BEFORE UPDATE ON priority_payment_reviews BEGIN SELECT RAISE(ABORT, 'priority_payment_reviews is append-only'); END;
  CREATE TRIGGER payment_reviews_no_delete BEFORE DELETE ON priority_payment_reviews BEGIN SELECT RAISE(ABORT, 'priority_payment_reviews is append-only'); END;

  CREATE TABLE confirmed_payment_utrs (
    utr           TEXT PRIMARY KEY,
    payment_id    TEXT NOT NULL UNIQUE REFERENCES priority_payments(id),
    submission_id TEXT NOT NULL UNIQUE REFERENCES priority_payment_submissions(id),
    admin_id      TEXT NOT NULL,
    confirmed_at  TEXT NOT NULL
  );
  CREATE TRIGGER confirmed_utrs_no_update BEFORE UPDATE ON confirmed_payment_utrs BEGIN SELECT RAISE(ABORT, 'confirmed_payment_utrs is append-only'); END;
  CREATE TRIGGER confirmed_utrs_no_delete BEFORE DELETE ON confirmed_payment_utrs BEGIN SELECT RAISE(ABORT, 'confirmed_payment_utrs is append-only'); END;

  ALTER TABLE priority_payments ADD COLUMN verified_at TEXT;
  ALTER TABLE priority_payments ADD COLUMN verified_by TEXT;
  ALTER TABLE priority_payments ADD COLUMN verified_by_name TEXT;
  ALTER TABLE priority_payments ADD COLUMN rejection_code TEXT;
  ALTER TABLE priority_payments ADD COLUMN rejection_note TEXT;
  ALTER TABLE priority_payments ADD COLUMN reviewed_at TEXT;
  ALTER TABLE priority_payments ADD COLUMN reviewed_by TEXT;
  CREATE INDEX idx_priority_payments_submitted ON priority_payments(submitted_at);
  CREATE TRIGGER payments_frozen_fields BEFORE UPDATE OF expected_paise, student_id, request_id, application_id, enrollment_id, price_id ON priority_payments
    BEGIN SELECT RAISE(ABORT, 'the amount and owner of a payment order cannot be changed'); END;
  CREATE TRIGGER payments_verified_locked BEFORE UPDATE OF status ON priority_payments
    WHEN OLD.status IN ('VERIFIED', 'REFUND_PENDING', 'REFUNDED') AND NEW.status NOT IN ('VERIFIED', 'REFUND_PENDING', 'REFUNDED')
    BEGIN SELECT RAISE(ABORT, 'a verified payment cannot be changed back'); END;
  CREATE TRIGGER payments_verified_needs_confirmed_utr BEFORE UPDATE OF status ON priority_payments
    WHEN NEW.status = 'VERIFIED' AND OLD.status <> 'VERIFIED' AND NOT EXISTS (SELECT 1 FROM confirmed_payment_utrs WHERE payment_id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'record the confirmed reference before marking a payment verified'); END;
  `,
  /* 25: Stage 10B Part 2B — manual refunds, QR image setting, refund permission. ADDITIVE except that admin_permissions is rebuilt (SQLite cannot widen a CHECK) with every row copied.
     payment_refunds        one row per refund; the CONFIRMED payment row is never touched. Refund UTR is unique when present; triggers cap the SUM of live refunds at the confirmed amount
                            (rejected refunds free their share), allow only forward status moves, and freeze amount/owner/payment. REFUNDED requires a reference (CHECK).
     payment_refund_events  append-only refund history.
     payment_config.qr_file private QR image name (random, server-chosen). */
  `
  CREATE TABLE admin_permissions_v2 (
    admin_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('pricing.manage', 'payment.configure', 'payment.review', 'payment.refund')),
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (admin_id, permission)
  );
  INSERT INTO admin_permissions_v2 (admin_id, permission, granted_by, granted_at) SELECT admin_id, permission, granted_by, granted_at FROM admin_permissions;
  DROP TABLE admin_permissions;
  ALTER TABLE admin_permissions_v2 RENAME TO admin_permissions;

  ALTER TABLE payment_config ADD COLUMN qr_file TEXT;
  ALTER TABLE payment_config ADD COLUMN qr_updated_at TEXT;

  CREATE TABLE payment_refunds (
    id               TEXT PRIMARY KEY,
    payment_id       TEXT NOT NULL REFERENCES priority_payments(id),
    student_id       TEXT NOT NULL REFERENCES students(id),
    amount_paise     INTEGER NOT NULL CHECK (amount_paise > 0),
    reason           TEXT NOT NULL,
    destination      TEXT NOT NULL,
    notes            TEXT,
    status           TEXT NOT NULL DEFAULT 'REFUND_REQUESTED' CHECK (status IN ('REFUND_REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_REJECTED')),
    refund_utr       TEXT,
    refund_date      TEXT,
    rejection_reason TEXT,
    requested_by     TEXT NOT NULL,
    requested_by_name TEXT NOT NULL,
    requested_at     TEXT NOT NULL,
    pending_at       TEXT,
    completed_by     TEXT,
    completed_by_name TEXT,
    completed_at     TEXT,
    rejected_by      TEXT,
    rejected_by_name TEXT,
    rejected_at      TEXT,
    updated_at       TEXT NOT NULL,
    CHECK (status <> 'REFUNDED' OR (refund_utr IS NOT NULL AND completed_at IS NOT NULL AND completed_by IS NOT NULL)),
    CHECK (status <> 'REFUND_REJECTED' OR (rejection_reason IS NOT NULL AND rejected_at IS NOT NULL))
  );
  CREATE UNIQUE INDEX uq_payment_refunds_utr ON payment_refunds(refund_utr) WHERE refund_utr IS NOT NULL;
  CREATE INDEX idx_payment_refunds_payment ON payment_refunds(payment_id, requested_at);
  CREATE INDEX idx_payment_refunds_status ON payment_refunds(status, requested_at);
  CREATE INDEX idx_payment_refunds_student ON payment_refunds(student_id);
  CREATE TRIGGER payment_refunds_only_verified BEFORE INSERT ON payment_refunds
    WHEN (SELECT status FROM priority_payments WHERE id = NEW.payment_id) NOT IN ('VERIFIED', 'REFUND_PENDING', 'REFUNDED') OR NEW.status <> 'REFUND_REQUESTED'
    BEGIN SELECT RAISE(ABORT, 'a refund can only be requested for a verified payment'); END;
  CREATE TRIGGER payment_refunds_cap_insert BEFORE INSERT ON payment_refunds
    WHEN COALESCE((SELECT SUM(amount_paise) FROM payment_refunds WHERE payment_id = NEW.payment_id AND status <> 'REFUND_REJECTED'), 0) + NEW.amount_paise
         > (SELECT expected_paise FROM priority_payments WHERE id = NEW.payment_id)
    BEGIN SELECT RAISE(ABORT, 'refunds cannot exceed the confirmed payment amount'); END;
  CREATE TRIGGER payment_refunds_frozen BEFORE UPDATE OF payment_id, student_id, amount_paise, requested_by, requested_at ON payment_refunds
    BEGIN SELECT RAISE(ABORT, 'the payment, owner and amount of a refund cannot be changed'); END;
  CREATE TRIGGER payment_refunds_forward_only BEFORE UPDATE OF status ON payment_refunds
    WHEN NOT ((OLD.status = 'REFUND_REQUESTED' AND NEW.status IN ('REFUND_PENDING', 'REFUND_REJECTED')) OR (OLD.status = 'REFUND_PENDING' AND NEW.status IN ('REFUNDED', 'REFUND_REJECTED')) OR OLD.status = NEW.status)
    BEGIN SELECT RAISE(ABORT, 'invalid refund status change'); END;
  CREATE TRIGGER payment_refunds_final_locked BEFORE UPDATE ON payment_refunds
    WHEN OLD.status IN ('REFUNDED', 'REFUND_REJECTED')
    BEGIN SELECT RAISE(ABORT, 'a completed or rejected refund cannot be changed'); END;
  CREATE TRIGGER payment_refunds_no_delete BEFORE DELETE ON payment_refunds BEGIN SELECT RAISE(ABORT, 'payment_refunds cannot be deleted'); END;

  CREATE TABLE payment_refund_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    refund_id  TEXT NOT NULL REFERENCES payment_refunds(id),
    payment_id TEXT NOT NULL REFERENCES priority_payments(id),
    event      TEXT NOT NULL,
    from_status TEXT,
    to_status  TEXT,
    actor      TEXT NOT NULL,
    actor_name TEXT,
    note       TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_payment_refund_events ON payment_refund_events(refund_id, id);
  CREATE TRIGGER payment_refund_events_no_update BEFORE UPDATE ON payment_refund_events BEGIN SELECT RAISE(ABORT, 'payment_refund_events is append-only'); END;
  CREATE TRIGGER payment_refund_events_no_delete BEFORE DELETE ON payment_refund_events BEGIN SELECT RAISE(ABORT, 'payment_refund_events is append-only'); END;
  `,
  /* 26: Stage 10C Part 1 — financial records. ADDITIVE except that admin_permissions is rebuilt (SQLite cannot widen a CHECK) with every row copied.
     payment_transactions   ONE internal transaction record per CONFIRMED payment: unique transaction id, student, payment request, confirmed amount, confirmed UTR,
                            verifying administrator and time. UNIQUE(payment_id), UNIQUE(confirmed_utr), append-only (no UPDATE/DELETE), and a trigger refuses a row whose
                            amount, UTR, student or request disagrees with the payment order and its confirmed-UTR row. Existing VERIFIED payments are backfilled below.
                            Pending, rejected, expired and free-correction records never get a row, so this table is the only source of "revenue".
     admin_permissions      gains 'payment.report' (financial summary and CSV export); every existing 'payment.review' holder keeps seeing amounts, so they receive it too. */
  `
  CREATE TABLE admin_permissions_v3 (
    admin_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('pricing.manage', 'payment.configure', 'payment.review', 'payment.refund', 'payment.report')),
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (admin_id, permission)
  );
  INSERT INTO admin_permissions_v3 (admin_id, permission, granted_by, granted_at) SELECT admin_id, permission, granted_by, granted_at FROM admin_permissions WHERE permission IN ('pricing.manage', 'payment.configure', 'payment.review', 'payment.refund', 'payment.report');
  INSERT OR IGNORE INTO admin_permissions_v3 (admin_id, permission, granted_by, granted_at) SELECT admin_id, 'payment.report', 'migration 26', granted_at FROM admin_permissions WHERE permission = 'payment.review';
  DROP TABLE admin_permissions;
  ALTER TABLE admin_permissions_v3 RENAME TO admin_permissions;

  CREATE TABLE payment_transactions (
    id                     TEXT PRIMARY KEY,
    payment_id             TEXT NOT NULL UNIQUE REFERENCES priority_payments(id),
    request_id             TEXT NOT NULL REFERENCES priority_requests(id),
    student_id             TEXT NOT NULL REFERENCES students(id),
    submission_id          TEXT NOT NULL UNIQUE REFERENCES priority_payment_submissions(id),
    confirmed_amount_paise INTEGER NOT NULL CHECK (confirmed_amount_paise > 0),
    currency               TEXT NOT NULL DEFAULT 'INR',
    confirmed_utr          TEXT NOT NULL UNIQUE,
    verified_by            TEXT NOT NULL,
    verified_by_name       TEXT NOT NULL,
    verified_at            TEXT NOT NULL,
    created_at             TEXT NOT NULL
  );
  CREATE INDEX idx_payment_transactions_verified ON payment_transactions(verified_at);
  CREATE INDEX idx_payment_transactions_student ON payment_transactions(student_id);
  CREATE TRIGGER payment_transactions_no_update BEFORE UPDATE ON payment_transactions BEGIN SELECT RAISE(ABORT, 'payment_transactions is append-only'); END;
  CREATE TRIGGER payment_transactions_no_delete BEFORE DELETE ON payment_transactions BEGIN SELECT RAISE(ABORT, 'payment_transactions is append-only'); END;
  CREATE TRIGGER payment_transactions_consistent BEFORE INSERT ON payment_transactions
    WHEN NOT EXISTS (SELECT 1 FROM priority_payments p JOIN confirmed_payment_utrs c ON c.payment_id = p.id
                     WHERE p.id = NEW.payment_id AND p.student_id = NEW.student_id AND p.request_id = NEW.request_id
                       AND p.expected_paise = NEW.confirmed_amount_paise AND c.utr = NEW.confirmed_utr AND c.submission_id = NEW.submission_id)
    BEGIN SELECT RAISE(ABORT, 'a transaction record must match the confirmed payment'); END;

  INSERT INTO payment_transactions (id, payment_id, request_id, student_id, submission_id, confirmed_amount_paise, currency, confirmed_utr, verified_by, verified_by_name, verified_at, created_at)
    SELECT 'TXN-' || upper(hex(randomblob(6))), p.id, p.request_id, p.student_id, c.submission_id, p.expected_paise, p.currency, c.utr,
           COALESCE(p.verified_by, c.admin_id), COALESCE(p.verified_by_name, 'Administrator'), COALESCE(p.verified_at, c.confirmed_at), c.confirmed_at
    FROM priority_payments p JOIN confirmed_payment_utrs c ON c.payment_id = p.id
    WHERE p.status IN ('VERIFIED', 'REFUND_PENDING', 'REFUNDED');
  `,
  /* 27: Stage 10C Part 2 — certificate corrections: their own permission and separation of duties. BACKWARD-COMPATIBLE, no data is removed.
     admin_permissions      rebuilt (SQLite cannot widen a CHECK) with every row copied, and 'certificate.correct' added to the allowed list. Every EXISTING administrator receives it
                            ('migration 27') so nobody who could correct a certificate yesterday is locked out today; later administrators receive nothing until it is granted.
     free_corrections       gains nullable approved_at and approved_by_name (who approved, and when); rows from before this migration keep NULL there. created_by / created_at already exist.
     A correction can no longer be approved by the administrator who created it: that rule is enforced in the service layer (it needs the signed-in administrator). */
  () => {
    db.exec(`
  CREATE TABLE admin_permissions_v4 (
    admin_id   TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('pricing.manage', 'payment.configure', 'payment.review', 'payment.refund', 'payment.report', 'certificate.correct')),
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (admin_id, permission)
  );
  INSERT INTO admin_permissions_v4 (admin_id, permission, granted_by, granted_at) SELECT admin_id, permission, granted_by, granted_at FROM admin_permissions;
  INSERT OR IGNORE INTO admin_permissions_v4 (admin_id, permission, granted_by, granted_at)
    SELECT id, 'certificate.correct', 'migration 27', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM students WHERE role = 'admin';
  DROP TABLE admin_permissions;
  ALTER TABLE admin_permissions_v4 RENAME TO admin_permissions;
  `);
    // ADD COLUMN is not repeatable, so it only runs when the column is missing (migrations can be replayed on a restored or hand-edited database).
    const have = new Set(db.prepare('PRAGMA table_info(free_corrections)').all().map((c) => c.name));
    if (!have.has('approved_at')) db.exec('ALTER TABLE free_corrections ADD COLUMN approved_at TEXT');
    if (!have.has('approved_by_name')) db.exec('ALTER TABLE free_corrections ADD COLUMN approved_by_name TEXT');
  },
  /* 28: Instant-certificate plans (1, 2 or 3 months). ADDITIVE: one flag on priority_requests. A request with instant = 1 was created from a paid plan
     (services/instantCertificate.js): once an administrator verifies the payment, the certificate is issued automatically. Existing requests keep instant = 0. */
  () => {
    const have = new Set(db.prepare('PRAGMA table_info(priority_requests)').all().map((c) => c.name));
    if (!have.has('instant')) db.exec('ALTER TABLE priority_requests ADD COLUMN instant INTEGER NOT NULL DEFAULT 0');
  },
];

export function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      if (typeof migrations[v] === 'function') migrations[v](); else db.exec(migrations[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
migrate();
