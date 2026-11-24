# ELVORA — Elevate Your Skills. Build Your Future.

Platform-independent internship portal. React + Vite client, Node/Express REST API.

## Run
```bash
cp .env.example .env
npm install
npm run dev        # client :5173, API :4000
```
Requires **Node.js 22.13+ (or 23.4+)** (the API uses the built-in `node:sqlite` module: it first appeared in 22.5 and works without a flag from 22.13). `npm install` refuses older versions through `engines`, and `npm start` prints a clear message instead of a crash. Build: `npm run build` → `client/dist` (static, host anywhere).

## Layout
- `client/` UI: `styles/` design tokens, `components/ui|layout`, `services/` API client, `config/`
- `server/src/` `routes/`, `auth/`, `db/`, `documents/`, `config/`, `utils/`

## Stage 02 — Landing page
- Content lives in `client/src/config/site.js` (domains, services availability, durations, stats, MSME, testimonials, FAQ, contact, socials).
- Routing: `react-router-dom`. Routes: `/`, `/internships?category=<slug>`, `/login`, `/signup`, `/privacy`, `/terms`.
- Host note: single-page app, so configure your host to serve `index.html` for unknown paths.

## Stage 03 — Internships
- Demo data: `client/src/data/internships.demo.js` (only place internships live). Read through `services/internshipService.js`; since Stage 07B the app calls `GET /internships` (administrator-managed listings in the database, seeded once from this file); set `VITE_USE_DEMO_DATA=true` to use these demo records offline.
- Filters/sort live in the URL (`/internships?q=python&category=web-development&duration=30&difficulty=Beginner&type=Self-Paced&sort=az`).
- Apply flow: `/apply/:id` requires sign-in; signed-out users go to `/login?redirect=/apply/:id`. Auth is real as of Stage 04A (below).

## Stage 04A — Student authentication and profile
- **Pages:** `/signup`, `/login`, `/forgot-password`, `/reset-password?token=…`, `/profile` (private).
- **API** (`/api/v1`): `POST /auth/register`, `/auth/login`, `/auth/logout`, `GET /auth/me`, `POST /auth/forgot-password`, `/auth/reset-password`, `GET|PUT /students/me`.
- **Database:** SQLite via `better-sqlite3` (`DATABASE_URL`, default `server/data/elevora.db`). Tables `students`, `sessions`, `password_resets` are created automatically on start (migrations in `server/src/db/index.js`). All SQL lives in `server/src/db/`.
- **Security:** scrypt password hashes; random session tokens in an `httpOnly` `SameSite=Lax` cookie (only an HMAC of the token is stored, so sessions can be revoked); reset tokens are 256-bit, hashed at rest, expire (30 min) and are single-use; a reset signs the student out everywhere; per-IP and per-account login rate limits; Origin check on writes; server-side validation of every field; students can only reach `/students/me`.
- **Email:** reset emails go out only when `SMTP_HOST` and `MAIL_FROM` are set. Otherwise the API and UI say no email was sent. For local testing set `DEV_LOG_RESET_LINKS=true` to print links to the server console (ignored in production).
- **Production:** set `NODE_ENV=production`, a 32+ char `SESSION_SECRET`, `CORS_ORIGIN`, `CLIENT_URL`, and `TRUST_PROXY` if behind a proxy. Serve the client and API from the same site (e.g. proxy `/api`) so the cookie stays first-party.
- **Tests:** `npm test -w server` (API: registration, duplicates, login, logout, profile isolation, reset flow, rate limits).

## Stage 04B — Internship applications and enrollment
- **Pages:** `/apply/:id` (details → review → submit), `/applications/:id/submitted` (success), `/applications` (my applications), `/applications/:id` (one application). `/dashboard` is a placeholder until Stage 05.
- **Apply Now** (listing cards and details page) goes through `ApplyButton`: signed out → `/login?redirect=/apply/<id>` (also for signup) and back to that internship after sign-in; signed in → the form opens directly.
- **API** (`/api/v1`, all need a signed-in student): `POST /applications`, `GET /applications/my`, `GET /applications/:id`. Admin only: `PATCH /admin/applications/:id/status` with header `X-Admin-Key` (see `ADMIN_API_KEY` in `.env.example`; off when unset).
- **Database:** table `applications` (migration 2, created automatically). `UNIQUE(student_id, internship_id)` blocks duplicates, `CHECK` restricts status to Submitted / Under Review / Approved / Rejected / Cancelled. The internship and the student's answers are stored as a snapshot.
- **Server-side checks on submit:** validation → student from the session cookie (a student ID in the body is ignored) → internship exists in `server/src/data/internshipCatalog.json` → applications open (deadline end of day, India time) → no duplicate → save in one transaction (also saves the profile fields filled in the form). The success page loads the saved record from the API.
- **Internship catalogue:** internships still live in `client/src/data/internships.demo.js`; the API keeps a generated copy so it never trusts the browser. After editing the demo data run `npm run catalog:sync` (a test fails if they drift).
- **Security:** someone else's application returns the same 404 as a missing one; students have no route that writes status; submissions are rate limited per student (`RATE_LIMIT_APPLY_MAX`, default 10/hour); admin key compared in constant time and failed attempts are rate limited.
- **Tests:** `npm test -w server` now also covers applications, admin status updates, rate limits and the catalogue.

## Stage 05A — Student dashboard foundation
- **Pages:** `/student/dashboard` (Overview). Sidebar also links to `/student/internship`, `/student/documents`, `/student/notifications`, `/student/settings` (placeholders inside the dashboard shell) and, for now, to the existing `/profile` and `/applications`. `/dashboard` redirects to `/student/dashboard`. Nav lives in `client/src/config/dashboard.js`.
- **API:** `GET /api/v1/student/dashboard` (student session required, no parameters). Returns `stats` (total, approved) and the 5 most recent applications, all computed from the signed-in student's rows.
- **Internship counts:** reported as `null` with `internshipsTracked: false` until enrolment records existed; as of Stage 05B they are real counts (see below).
- **Database:** no changes.
- **Tests:** `server/test/dashboard.test.js` (part of `npm test -w server`).

## Stage 05B — My Applications, My Internship and progress timeline
- **Pages (inside the dashboard):** `/student/applications` (table on desktop, cards on phones; filter chips All / Submitted / Under Review / Approved / Rejected / Cancelled with counts; pagination; filter and page live in the URL), `/student/applications/:id` (details + timeline), `/student/internship` (My Internship). The old `/applications` and `/applications/:id` URLs redirect there.
- **API (student, session required, no student ID anywhere):**
  - `GET /applications/my?status=&page=&pageSize=` (reused, now paged: returns `applications`, `pagination`, `counts`; unknown status/page values are a 400).
  - `GET /applications/:id` (reused; now also returns `timeline`). Someone else's application is the same 404 as a missing one.
  - `GET /student/internships` (new): the student's own internships, each with its `timeline`. Only enrollments whose application is currently **Approved** are returned.
- **Who changes what:** students have no write route for application or internship status. Administrators (header `X-Admin-Key`, as in 04B):
  - `PATCH /admin/applications/:id/status` (existing). An application that already has an internship can't be moved off Approved (409).
  - `POST /admin/applications/:id/internship` creates the internship record for an **Approved** application, starting as *Awaiting Start*. Body (all optional): `startDate`, `expectedEndDate`, `assignedProject`, `learningObjectives[]`, `instructions`.
  - `PATCH /admin/internships/:id` edits those details (not once Completed/Cancelled).
  - `PATCH /admin/internships/:id/status` with `{ "status": "Active", "startDate": "YYYY-MM-DD" }`. Allowed moves: Awaiting Start → Active | Cancelled; Active → Completed | Suspended | Cancelled; Suspended → Active | Cancelled. Completed and Cancelled are final. Activation sets the start date (default: today, India time) and an expected end date of start + duration days unless one was set.
- **Database (migration 3, automatic):** `application_status_history` (when each status was set; existing rows are back-filled with their Submitted date and the date of their current status, earlier steps stay "date not recorded") and `enrollments` (ID `ELV-INT-XXXXXXXX`, one per application, status, dates, assigned project, objectives, instructions, activation/completion/suspension/cancellation timestamps, and `certificate_id` / `certificate_issued_at`, which stay empty until a later stage issues official certificates).
- **Timeline** (`server/src/services/progress.js`): Application Submitted → Under Review → Approved → Internship Activated → In Progress → Completed → Certificate Issued. States are completed / current / pending / stopped, decided only from stored records. Certificate Issued is completed only when a certificate record exists; otherwise it stays Pending with no date. Rejected or cancelled applications show where the process stopped.
- **Tests:** `server/test/progress.test.js` (database + timeline rules, no HTTP) and `server/test/internships.test.js` (HTTP: listing, filters, pagination, ownership, internship visibility and admin-only transitions); `dashboard.test.js` updated for real internship counts.

## Admin console

Administrators are not student accounts. The recommended way in is an **administrator account** (`npm run admin:create`, sign in at **/admin/login**): every change is then tied to a named person in the audit log. The legacy console at **/admin** still accepts the shared `ADMIN_API_KEY` from `.env` (32+ characters), but since Stage 08A that key is **read-only** (see *Admin API key* below).

1. Make sure `.env` (project root) contains `ADMIN_API_KEY=<your key>`. Create a new one any time with `npm run admin:key`, then restart the server.
2. Run `npm run dev` and open **http://localhost:5173/admin**.
3. Paste the key (read-only access; to change data sign in at **/admin/login** instead). It is kept only for that browser tab (sessionStorage) and is cleared by **Lock** or when the tab closes.

What you can do there:
- **Applications**: search and filter every student's applications, change a status (the student is notified), and **Set up internship** for an approved application.
- **Internships**: activate, suspend, resume, complete or cancel; attach the officially issued offer letter or certificate (PDF).
- **Announce**: send a notification to every student, or to one student by ID.

The same actions are available as API calls under `/api/v1/admin/*`. **Since Stage 08A the `X-Admin-Key` header is read-only**: it can list and read, but anything that changes data (statuses, notes, internships, documents, listings, certificate decisions, automation) needs a signed-in administrator session (see *Admin API key* below). After 10 wrong keys from one IP in 15 minutes the API answers 429 for a while. If `ADMIN_API_KEY` is missing or too short, the admin API is switched off and the page says so. Use a different, secret key in production and never commit `.env`.

## Stage 06A — Document system foundation (offer letter + completion certificate)
No PDF is generated and nothing is verified yet (Stage 06B). Administrators can preview both templates and check eligibility.
- **Code:** `server/src/documents/` — `organization.js` (config), `data.js` (data preparation), `eligibility.js`, `numbering.js`, `verification.js`, `storage.js`, `templates/` (components, styles, offerLetter, certificate, registry), `renderers/` (HTML now, PDF slot for 06B), `service.js`.
- **Admin API (X-Admin-Key):** `GET /admin/document-templates`, `GET /admin/document-templates/:type/preview[?stress=1]` (sample data), `GET /admin/internships/:id/documents/:type/eligibility`, `GET /admin/internships/:id/documents/:type/preview` (watermarked draft; refused unless eligible). `:type` is `offer_letter` or `certificate`.
- **Database:** migration 5 rebuilds `documents` (status Draft/Issued/Revoked, number, verification code, template version, snapshot, references) and adds `document_sequences`. Stage 05C uploads are kept as Issued.
- **Rules:** offer letter needs an admin-approved application; certificate needs an internship the admin moved to Completed (with a completion stamp, after the start date). Students have no document write route.
- **Review before real use:** default offer terms in `documents/terms.js` are neutral placeholders, not legal advice. Set the `ORG_*` values in `.env.example`.

## Stage 06B — PDF generation and issuance
- **Engine:** `pdfkit` (pure JS, no browser or native binary) in `server/src/documents/renderers/pdfRenderer.js`, drawing the same data object as the HTML previews. Noto Sans/Serif are embedded (Latin only: other scripts are refused with `UNSUPPORTED_CHARACTERS`, never printed as boxes). QR codes (`qrcode`) encode `CLIENT_URL/verify/<code>`; that page is not built yet (Stage 06C).
- **Admin API (X-Admin-Key):** `POST /admin/documents/offer-letter` and `/certificate` with `{ "internshipId": "ELV-INT-…", "issuedBy": "optional name" }` (generates and issues; student data is read from the database only), `GET /admin/documents[?type=&status=&internshipId=]`, `GET /admin/documents/:id` (with audit events), `GET /admin/documents/:id/file[?download=1]`, `PATCH /admin/documents/:id/revoke` with `{ "reason": "…" }`.
- **Rules:** see Stage 06A. Issuance also needs `ORG_ADDRESS`, `ORG_EMAIL`, `ORG_SIGNATORY_NAME`, `ORG_SIGNATORY_TITLE`. Numbers are allocated only after a dry-run render succeeds. A revoked document disappears from the student's list and download, and a replacement can be issued.
- **Database:** migration 6 (`documents.revoked_by`, append-only `document_events`).
- **Audit identity:** the platform has one shared admin key, so `issuedBy` / `revokedBy` are self-declared labels; each event also stores a short fingerprint of the key used.

## Stage 06C — QR verification, public verification page, student integration
- **Public page:** `/verify/:reference` (no login, read-only, `noindex`). Results: Valid, Revoked, Invalid reference, Document not found. Shows only document type, number, student name as printed, internship, duration, issue date, organization and status.
- **API:** `GET /api/v1/public/documents/verify/:reference` → 200 `valid|revoked`, 400 `invalid`, 404 `not_found` (unknown reference and never-issued Draft look identical). Rate limits per IP: `RATE_LIMIT_PUBLIC_VERIFY_MAX` (60) and `RATE_LIMIT_PUBLIC_VERIFY_MISS_MAX` (15, lookups that find nothing). Set `TRUST_PROXY` behind a proxy.
- **PDFs:** QR encodes `CLIENT_URL/verify/<reference>`; the PDF also prints the address, an instruction, the document number and the reference. QR codes on issued PDFs keep the domain used at issue time.
- **Production:** `CLIENT_URL` must be `https://` (localhost excepted). Serve `index.html` for `/verify/*`.
- **Student Documents page:** number, internship, completion date (certificates), issue date, Preview, Download, Verify authenticity. Revoked documents stay visible, marked Revoked; their file returns 410 (changed from 06B, where they disappeared).
- **Database:** no migration. **Tests:** `npm test -w server` (114 tests).

## Stage 07 — Automation, CEO digital signature, certificate approval
- **Digital signature:** the signatory (`ORG_SIGNATORY_NAME` = Gowtham, `ORG_SIGNATORY_TITLE` = CEO) is drawn as black-ink vector artwork (tall spiky script, long strike-through line and a tall slash), plus “Digitally signed · date”, on offer letters and certificates (PDF and HTML preview). It is a visual signature; the QR code, the verification page and the stored SHA-256 are what prove a document is genuine. `ORG_SIGNATURE_ENABLED=false` switches it off.
- **Offer letter, automatic (target within 24 h):** approving an application (admin console, as before) is the only manual step. The server then creates the internship record (start = approval day + `AUTO_START_DELAY_DAYS`, end = start + duration), generates and issues the offer letter, notifies the student and e-mails the PDF. A background worker (`server/src/automation/worker.js`, every `AUTOMATION_INTERVAL_MINUTES`, also kicked immediately by the approval) retries failures with a back-off (5, 10, 20, 40, 60 min …) and flags anything later than `OFFER_SLA_HOURS` as overdue.
- **Certificate, only after admin approval:** **Admin → Certificates** lists every running or finished internship. For each intern the admin chooses **Approve** or **Decline** (a reason is required). Nothing is generated while a decision is *Pending* or *Declined*. After **Approve**, the certificate is generated as soon as the internship is Completed (the worker also completes an approved internship on its end date), shown in the student's Documents, notified and e-mailed. The rule is enforced again at issuance, so the manual `POST /admin/documents/certificate` also refuses an unapproved intern (`CERTIFICATE_NOT_APPROVED`). Once issued, the decision is locked; revoke the certificate to withdraw it. A revoked document is never re-created automatically.
- **Lifecycle:** Approved → internship created (Awaiting Start) → Active on the start date → Completed (admin, or automatically on the end date once the certificate is approved) → certificate.
- **API (X-Admin-Key):** `GET /admin/certificate-approvals`, `PATCH /admin/internships/:id/certificate-decision` `{ "decision": "Approved|Declined|Pending", "note": "…", "decidedBy": "…" }`, `GET /admin/automation` (status, waiting counts, unresolved problems), `POST /admin/automation/run`.
- **Database:** migration 7 adds `enrollments.certificate_decision / _decided_at / _decided_by / _decision_note` and `automation_state` (attempts, last error, next retry, e-mailed).
- **E-mail:** needs `SMTP_HOST` and `MAIL_FROM`; without them the student still sees the document in the dashboard and the admin card says e-mail is off. Each document is e-mailed once.
- **Tests:** `npm test -w server` (125 tests, including `automation.test.js`).


## Stage 07A — Admin dashboard foundation

**Admin accounts.** An administrator is a normal account whose `role` (database column `students.role`, migration 8) is `admin`.
There is no sign-up page, API route or request field that can set it. Authorize someone on the server:

```bash
npm run admin:create -- --email you@example.com --name "Your Name"   # new admin; asks for the password (hidden, 12+ chars)
npm run admin:create -- --email existing@student.com                  # promote an existing account (password unchanged)
npm run admin:create -- --email you@example.com --revoke              # back to student (the last admin cannot be removed)
```

Sign in at **/admin/login** (same password hashing, cookie session and rate limits as student login; a student's correct password is refused
with the same generic message). Then open **/admin/dashboard**.

**Access rules.** `GET /api/v1/admin/dashboard` needs a signed-in administrator session: no session → 401, student → 403, the shared
`ADMIN_API_KEY` alone → 401. The role is read from the database on every request. The existing console API (`/api/v1/admin/*`) now also
accepts an administrator session. `ADMIN_API_KEY` access is read-only since Stage 08A (writes need a session unless the temporary `ADMIN_API_KEY_ALLOW_WRITES=true` bridge is set; see *Admin API key*). The existing console stays at **/admin**.

**Built:** sign-in, protected layout (sidebar, header, profile menu, mobile drawer), Overview (8 live statistics, recent activity, application
pipeline, quick actions). Internships, Applications, Students, Documents, Notifications, Audit Logs and Settings are labelled placeholders for
Stage 07B/07C. Header search is switched off until then.

## Stage 07B (part 1) — internship + application management
- Admin pages: `/admin/internships` (create, edit, publish/unpublish, activate/deactivate, archive/restore, safe delete) and `/admin/applications` (search, status filter, details, validated status changes, history, internal notes).
- New API (admin only): `/admin/internship-listings[/:id[/state]]`, `/admin/internship-listings/options`, `GET /admin/applications/:id`, `POST /admin/applications/:id/notes`; `PATCH /admin/applications/:id/status` now enforces transitions and accepts an optional `note`. Public: `GET /internships` → `{ internships }`, `GET /internships/:id` → `{ internship }` (published only; Stage 08A: the old `{ data }` key is still returned as a deprecated alias of the same content).
- `/admin/internships` (existing) still means a student's internship *record*; catalogue listings use `/admin/internship-listings`.
- Migrations 9–10 add `internship_listings` (seeded once from `server/src/data/internshipCatalog.json`), history columns (`from_status`, `changed_by`, `changed_by_name`, `note`) and `application_notes`.

## Stage 07B (part 2) — students + internship lifecycle
- **Students** (`/admin/students`): search (name, email, ID, college), filters (account status, degree, academic year), pagination, profile with applications, internship history, issued documents and account history. Mobile number appears only in the profile. Suspend / reactivate with a confirmation dialog; a reason is required to suspend.
- **Lifecycle** (inside an application's details and a student's internship list): Activate (start date, optional expected end), Update progress (0–100), Mark completed, Suspend, Cancel, Resume. Every action is validated on the server, notifies the student and is saved in the internship history with the administrator's name.
- **Completion rules:** the application must still be Approved, the internship Active, the start date reached, progress 100%, and the administrator must tick the review confirmation. Otherwise `409 COMPLETION_CHECKS_FAILED` lists what is missing.
- **API (administrator session only; the shared `ADMIN_API_KEY` is refused):** `GET /admin/students`, `GET /admin/students/:id`, `PATCH /admin/students/:id/status` `{status: active|suspended, reason}`, `GET /admin/internships/:id/lifecycle`, `PATCH /admin/internships/:id/{activate|progress|suspend|cancel|complete}`. For a signed-in administrator, `PATCH /admin/internships/:id/status` goes through the same strict rules; the legacy API-key console keeps its old behaviour.
- **Suspension:** revokes every session at once, blocks sign-in (`403 ACCOUNT_SUSPENDED`, only after a correct password) and is stored in `student_account_history`. Administrator accounts cannot be suspended here and no request field can change a role.
- **Database (migration 11):** `students.account_status`, `student_account_history`, `enrollments.progress_percent`, `enrollment_events` (append-only).
- **Tests:** `test/stage07b2.test.js` (service level, no Express) and `test/admin.stage07b2.test.js` (HTTP; needs `npm install`).

## Stage 07C — documents, notifications, audit logs, settings
- **Admin pages:** `/admin/documents`, `/admin/notifications`, `/admin/audit-logs`, `/admin/settings` (all behind `AdminRoute`; the server re-checks the administrator session on every call).
- **Notifications:** compose → server counts recipients → confirmation dialog → send with `confirm:true` + `confirmRecipientCount`. Delivery is the count read back from the database (in-app inboxes only; announcements are not e-mailed). Withdraw needs a reason; records are kept.
- **Audit logs:** read-only page with filters (action, administrator, result, dates) and pagination. Rows are written by the backend in the same transaction as the action; the database rejects UPDATE/DELETE.
- **Settings:** whitelisted fields only (organization, contact, website, address, signatory, footer, colours, signature/e-mail toggles, PNG/JPEG logo). Secrets and registration claims stay in environment variables.
- **API:** `/admin/announcements[/preview|/:id|/:id/withdraw]`, `/admin/audit-logs`, `/admin/settings[/logo]`, plus the document routes from 07C part 1. **Database:** no new migration in this part.
- **Stage 07C (complete):** the Documents page now has an *Issue document* action (offer letter / certificate, server-side eligibility and duplicate checks). `test/stage07c.e2e.test.js` runs the 17-step admin workflow over HTTP. `npm test -w server` = 197 tests.


## Admin API key (Stage 08A)

- **Read-only by default.** `X-Admin-Key` can call `GET` routes under `/api/v1/admin/*` only. Every `POST`/`PATCH`/`PUT`/`DELETE` answers `403 ADMIN_SESSION_REQUIRED` unless the caller is a signed-in administrator (create one with `npm run admin:create`, sign in at `/admin/login`). Each refused attempt is written to the audit log as `admin.access_denied` with the key's 8-character fingerprint, never the key.
- **Legacy bridge (off by default).** Scripts that still change data with the key can be kept working temporarily with `ADMIN_API_KEY_ALLOW_WRITES=true`. The server prints a warning at start-up, and those writes are audited as "Admin API key" with the fingerprint, which cannot name a person. This is the only remaining way the shared key can issue/revoke documents or change statuses.
- **Migration path:** (1) create administrator accounts, (2) move scripts to a session cookie from `POST /api/v1/auth/admin/login`, (3) remove `ADMIN_API_KEY_ALLOW_WRITES`, (4) rotate the key with `npm run admin:key`.
- The older console at `/admin` still unlocks with the key for reading; to change data from it, also sign in at `/admin/login` in the same browser.

## Database checks (Stage 08A)

`npm run db:check` runs `PRAGMA integrity_check`, `PRAGMA foreign_key_check` and relationship checks (applications ↔ students, internships ↔ applications, documents ↔ internships/students, notifications ↔ students) against the database in `DATABASE_URL`. Importing the database module applies any pending migrations, as at server start.

## API response conventions (Stage 08A)

- Authenticated and admin endpoints return **named keys** (`{ application }`, `{ applications, pagination }`, `{ user }`, `{ document }`, ...). Errors use `{ error: { code, message } }`.
- The **public internship catalogue** (`GET /api/v1/internships`, `GET /api/v1/internships/:id`) returns `{ data }`. This is deliberate and kept: it is a public, versioned contract with exactly one caller (`client/src/services/internshipService.js`, which also accepts a bare array) and is covered by tests, so changing it would be a breaking change for no functional gain.
- Public document verification returns `{ result, document? }`.


## Stage 09A — Internship automation foundation (tasks, completion rules, application evaluation) — backend only
No student task screens, no admin task screens, no GitHub integration (Stages 09B–09D).
- **Audit result:** the Stage 06/07 offer-letter and certificate flows were verified end to end (`test/stage09a.audit.test.js`): single issuance under parallel requests, ownership, revocation, QR verification, no certificate from an end date alone. No defect was found in them. The gap was that nothing tied task approval to completion/certificates; this stage adds that.
- **Task library → internship → student.** `task_templates` (reusable, one category each) → `internship_tasks` (a listing's own copy: content is copied on attach, so editing a template never changes a running internship; every edit appends to `internship_task_revisions`) → `student_tasks` (one row per internship record and task; `UNIQUE(enrollment_id, task_id)`; `is_required` is a snapshot) → `task_submissions` / `task_reviews` (append-only). Difficulty is `Beginner | Easy | Intermediate` only. A task can be published only when it has an objective, steps, expected output, submission requirements, evaluation criteria and a learning objective. Links must be `https://` and are only stored.
- **Assignment:** first activation assigns the listing's published tasks (idempotent; never another internship's; a failure never undoes the activation and is audited, and the worker retries it). Tasks added later reach students who already have a plan only through the explicit `POST /admin/internship-listings/:id/tasks/sync`.
- **Completion gate:** `services/completionEligibility.js`. If a student was given required tasks, `Completed` (admin Complete, legacy console, worker) and certificates (generated or uploaded) are refused until they are approved (percentage and "final project" configurable per internship). Internships without tasks behave exactly as before. The admin's own confirmation and certificate approval are still required.
- **Application evaluation:** `services/applicationEvaluation.js`. Criterion-by-criterion results and a recommendation (`recommend_approval` | `needs_review`). It never changes `applications.status`, has no reject outcome or score, reads only an allow-list of facts, and an administrator's response (accepted / overridden / information requested + reason) is stored and audited. `applications.status` keeps its five values on purpose (a sixth would need a table rebuild and student-UI changes); "Additional Information Required" is an admin-side review state for now.
- **API (administrator; writes need a signed-in administrator session, the shared key is read-only):** `/admin/task-templates`, `/admin/internship-listings/:id/{tasks,tasks/order,tasks/sync,completion-criteria,application-criteria}`, `/admin/internship-tasks/:taskId`, `/admin/internships/:id/{tasks,tasks/assign,completion-evaluation}`, `/admin/student-tasks/:id[/review]`, `/admin/applications/recommendations`, `/admin/applications/:id/evaluation[/review]`. (Listing IDs live under `/internship-listings`; `/internships` already means a student's internship record.)
- **Database:** migration 14 (additive only). **Tests:** `npm test -w server` (251 tests).

## Stage 09B (Part 1) — task library upgrade
- **Three learning stages** (derived from the task type, stored in `content.learningStage`; no migration): Beginner Foundation (Practical Assignment, difficulty Beginner), Intermediate Implementation (Mini Project, Easy) and Practical Internship Project (Final Project, Intermediate). Difficulty and estimated hours rise stage by stage.
- **Library:** 12 categories × 5 tasks (1 beginner, 3 intermediate, 1 final project) = 60 templates, written in `server/src/tasks/library/*.js` and built by `build.js`. Seeded idempotently (fixed IDs) at server start and with `npm run tasks:seed`; existing templates are never overwritten.
- **New optional `content` fields:** `problemStatement`, `concepts`, `features`, `technicalRequirements`, `folderStructure`, `expectedBehavior`, `testingRequirements`, `acceptanceCriteria`, `completionChecklist`, `rubric` (weights total 100). A task that carries a stage other than Beginner must have features, acceptance criteria, testing requirements and a rubric before it can be published. Stage 09A tasks are unaffected.
- **API:** `GET /admin/task-templates?stage=…` and `learningStages` in `/options`; student read-only `GET /student/tasks` and `GET /student/tasks/:id` (scoped to the signed-in student).
- **UI:** student “My Tasks” (grouped by stage) and the task detail page; admin “Task Library” (filters, preview, activate/deactivate); shared `components/tasks/TaskDetail.jsx`.

## Stage 09B (Part 2A) — GitHub project submissions
- **Scope:** students submit a *manually typed* GitHub repository link. ELVORA checks its **shape only** (`https://github.com/<owner>/<repo>`, normalised; no folders, branches, queries, credentials or other hosts). It does **not** contact GitHub, so nothing is verified; ownership, contents and commit history are Stage 09C. The required notice is shown verbatim beside the form.
- **Migration 15 (additive, nullable columns only):** `task_submissions.repository_description`, `documentation_url`, `submission_notes`; `task_reviews.score` (0–100) and `score_breakdown` (JSON), reserved for Part 2B. Existing rows and the append-only triggers are untouched.
- **API (student, session-scoped; no student ID is ever accepted):** `POST /student/tasks/:id/start`, `POST /student/tasks/:id/submissions` (rate limit `RATE_LIMIT_TASK_SUBMIT_MAX`, default 30/hour). `GET /student/tasks/:id` now also returns `submission` (status, `canSubmit`, pre-fill `draft`, `guide`) and every version; `GET /student/tasks` rows carry `submissionStatus`.
- **Rules:** every Mini/Final Project requires a repository (even if its stored type is `text`); one repository cannot be reused for another task of the same student (`DUPLICATE_REPOSITORY`); a task awaiting review or approved cannot be resubmitted; each resubmission is a new version, older versions and reviews are kept.
- **Statuses:** Not Submitted, Submitted, Under Review, Changes Requested, Resubmitted, Approved, Rejected. The stored `student_tasks.status` keeps its Stage 09A values; the first, second, fourth, fifth and sixth are derived from it. *Under Review* and *Rejected* are in the vocabulary but **not reachable until Part 2B** (they need the admin workflow and a `student_tasks` CHECK change).
- **Extension points for 09C:** `server/src/services/githubIntegration.js` (provider contract: `verifyOwnership`, `inspectRepository`, `createRepository`; `setProvider()`), `utils/github.js`, `tasks/githubSubmission.js`.

## Stage 09B Part 2B — administrator project evaluation

- **Admin screens:** *Project Reviews* in the admin navigation (`/admin/projects`, `/admin/projects/:id`). API: `/api/v1/admin/projects` (`GET /`, `GET /options`, `GET /:id`, `POST /:id/start-review`, `PUT /:id/evaluation`, `POST /:id/decision`). Reads accept the console key; every write needs an administrator session.
- **Rubric:** one place — `server/src/tasks/rubric.js` (default 30/20/20/10/10/10, optional per-category overrides, each totalling 100). Each criterion is scored 0–10 in steps of 0.5; weighted total = Σ score ÷ max × weight, rounded half-up to 2 decimals. The rubric used is stored as a snapshot on every evaluation.
- **Statuses:** the seven student-facing statuses are derived from `student_tasks.status` (unchanged Stage 09A values) + the new `student_tasks.project_status` (`Under Review` / `Rejected`) + the submission count. Legal moves live in `STATUS_TRANSITIONS` (`server/src/tasks/githubSubmission.js`).
- **History:** `project_evaluations` (migration 16). A finalized evaluation is immutable (database trigger); each submission version gets its own evaluation. Review start, draft saves and decisions are written to the audit log (`project.*`).
- **Decisions are explicit.** A score never approves or rejects. Changes/rejection need feedback; all criteria must be scored before any decision.
- **GitHub:** links are manually entered and *not verified*; the admin screen says so. Verification, OAuth and repository inspection remain Stage 09C (`services/githubIntegration.js` is the seam).
- **Tests:** `test/stage09b.part2b.service.test.js` (rubric maths, workflow, history, listing) and `test/stage09b.part2b.test.js` (HTTP: authorization, journeys, student visibility); both are in `npm test`.

## GitHub integration (Stage 09C, Part 1)

ELVORA talks to GitHub through **one GitHub App** (official REST API only). Everything is optional: with no GitHub settings the app works as before and
shows "setup required". Nothing is simulated, and repository code is never cloned or run on the server.

### 1. Create the GitHub App (organization settings → Developer settings → GitHub Apps → New)
| Setting | Value |
| --- | --- |
| Callback URL | the exact value of `GITHUB_CALLBACK_URL` (`https://<api-host>/api/v1/student/github/callback`) |
| Request user authorization (OAuth) during installation | off |
| Expire user authorization tokens | on (ELVORA refreshes them) |
| Webhook URL / secret | `https://<api-host>/api/v1/github/webhook` / the value of `GITHUB_WEBHOOK_SECRET` |
| Repository permissions | **Administration: Read & write** (create repositories), **Contents: Read & write** (starter files, read files and commits), **Metadata: Read-only** |
| Organization permissions | **Members: Read & write** only if you set `GITHUB_REVIEW_TEAM`; nothing else |
| Subscribe to events | Repository, Installation, Installation repositories, GitHub App authorization |
| Where can it be installed | Only on this account |

Generate a private key (PEM) and a client secret, then **install the App on the organization** (`GITHUB_ORGANIZATION`) with "All repositories".
No other permission is needed; do not grant more. The server mints a one-hour installation token per use and keeps it in memory only.

### 2. Environment (see `.env.example`)
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ORGANIZATION`, `GITHUB_CALLBACK_URL`, `GITHUB_WEBHOOK_SECRET`,
`GITHUB_REPOSITORY_VISIBILITY`, `GITHUB_DEFAULT_REPOSITORY_PERMISSION` (+ optional `GITHUB_REVIEW_TEAM`, `GITHUB_TOKEN_ENCRYPTION_KEY`).
Check it at `GET /api/v1/admin/github/status?live=1` (shows which settings are present, never their values, and compares the installation's permissions).

### 3. API (all under `/api/v1`)
Student (signed in; the student is always the session user): `GET /student/github/status`, `POST /student/github/connect` → `{ authorizeUrl }`,
`GET /student/github/callback` (GitHub redirects here), `DELETE /student/github`, and per task `GET|POST /student/github/tasks/:id/repository`,
`POST …/repository/link`, `DELETE …/repository/link`, `POST …/repository/verify-ownership`, `POST …/repository/inspect`, `GET …/repository/inspection`.
Administrator: `GET /admin/github/status`, `GET|POST /admin/github/tasks/:id/repository` (POST needs an admin session), `POST …/repository/inspect`.
Webhook: `POST /github/webhook` (HMAC-SHA256 signature checked on the raw body first).

## Stage 09C Part 2B — notifications, webhooks and final integration

**Notifications** reuse the existing `notifications` table (migration 19 adds `student_task_id` and an idempotency `dedupe_key`; the unique index only applies to rows that have a key, so older notifications are untouched). GitHub types: `github_connected`, `github_repo_created`, `github_repo_failed`, `github_repo_linked`, `github_verification_failed`, `github_verification_pending`, `project_submitted`, `submission_verified`; review decisions keep `task_approved` / `task_changes_requested` / `task_rejected` and now carry the task link. Notifications are written after the operation they describe and never throw into it.

**Webhook** `POST /api/v1/github/webhook` (raw body, `X-Hub-Signature-256`). Subscribe the GitHub App to: Repository, Push, Installation, Installation repositories, GitHub App authorization. Signature is checked first; each delivery id is processed once (a delivery that fails is forgotten so GitHub's redelivery is processed). Payloads for a different installation than the configured one are rejected. A push only marks evidence *outdated* (no GitHub call); the next refresh re-inspects. Visibility changes update the stored visibility; deletion, archiving or removal from the installation marks the repository unavailable.

**Still required outside the code:** create the GitHub App, set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ORGANIZATION`, `GITHUB_CALLBACK_URL`, `GITHUB_WEBHOOK_SECRET` and the token-encryption key (see `.env.example`), install the App on the organisation, point the webhook at your public HTTPS URL. Not verified against real GitHub.

## Stage 10A Part 1 — Private Priority Certificate Processing (foundation)
- **Private route:** `/priority-certificate` (sign-in required, `noindex`, not linked from navbar, footer, homepage, listings or robots.txt). Invitation links look like `/priority-certificate#invite=<token>`; the token is in the URL fragment and removed from the address bar at once.
- **Access:** signed-in student **and** a redeemed, unexpired, unrevoked invitation (`priority_invitations`: HMAC-hashed token, optional student binding, expiry, max uses). Create one with `node scripts/create-priority-invite.mjs [studentEmail] [days]` (admin UI is Part 2).
- **API** (`/api/v1/priority-certificate`): `GET|POST /access`, `GET /portal`, `/pricing`, `/options`, `/internships/:applicationId`, `POST /eligibility`, `POST|GET /requests`, `GET /requests/:id`, `/requests/:id/history`. Foreign IDs are a plain 404.
- **Eligibility** is computed only by `services/priorityCertificate.js`, reusing `completionEligibility.evaluateTasks` and `documents/eligibility.checkEligibility`. It never writes to internships, dates, tasks or documents.
- **Pricing:** `priority_pricing` (paise): 30d ₹49, 60d ₹99, 90d ₹199, none for 7 days. Changing a price retires the old row; requests keep their snapshot. GST wording is "proposed, subject to confirmation"; no invoice.
- **Not in this part:** payment, admin request dashboard, free correction workflow, certificate issuance. Payment statuses exist only as placeholders.
- **Tests:** `server/test/stage10a.priority.test.js` (in `npm test -w server`).

## Stage 10B Part 2B — refunds, settings, overdue management, notifications (final part of Stage 10B)

**No payment gateway is integrated.** Money moves by manual UPI; this software never sends, receives, reverses or verifies a transfer. All tests use mocked data — no real UPI payment or refund has been tested.

- **Manual refunds** (`services/paymentRefunds.js`, migration 25): `REFUND_REQUESTED → REFUND_PENDING → REFUNDED`, or `REFUND_REJECTED` from either open state. Permission `payment.refund` (separate from `payment.review`; checked in the route *and* the service; never the shared API key). `REFUNDED` is impossible without a real refund UTR **and** ticks that the actual bank/UPI statement was checked (also a DB CHECK). Refund UTR is globally unique (partial unique index) and cannot equal a payment UTR. Total of non-rejected refunds can never exceed the confirmed amount (checked in the transaction **and** by a DB trigger); a rejected refund releases its share. The confirmed payment row is never edited; refund history is append-only (`payment_refund_events`). Students see outcome only (no destination, notes or admin names). Notification wording never says money was sent before `REFUNDED`.
- **API** (`/api/v1/admin/priority-payments`): `GET /refunds`, `GET /refunds/:id`, `POST /refunds/:id/{pending|complete|reject}`, `GET|POST /:paymentId/refunds`, `GET /overdue`, `PUT|GET /config/qr`. Student: `GET /priority-certificate/payments/:id/refunds`, `GET /priority-certificate/payment-qr`.
- **Settings:** changing the UPI ID or payee name requires `confirm: true`; QR image upload (PNG/JPEG ≤ 512 KB, signature-checked, random private file name, replace removes the old file) requires confirmation; pricing already requires preview + confirm and creates a new immutable version. All audited; existing orders keep their frozen amount/version (DB triggers).
- **Overdue:** the configured verification target sets each deadline. Overdue payments are counted (queue, dashboard `payments.overdue`), filterable (`status=overdue`) and reviewers (`payment.review`) are notified once per payment+deadline (idempotent `dedupe_key`). Swept when the queue is opened and in every automation cycle. **Nothing is ever auto-approved or auto-rejected.**
- **Notifications added:** `refund_requested|pending|rejected|completed` (student), `refund_requested_admin`, `payment_overdue_admin`, `payment_duplicate_admin` (flag **and** blocked attempt), `payment_info_required` (rejection reason "Insufficient evidence").
- **Free corrections (Stage 10A) are unchanged and have no payment dependency** (test asserts the module references no payment/pricing/UPI/refund code).
- **No new environment variables.** Grant refund rights with `node scripts/grant-payment-permission.mjs <adminEmail> payment.refund` (or list the e-mail in `PAYMENT_ADMIN_EMAILS`, which grants every payment permission).
- **Tests:** `test/stage10b.part2b.service.test.js` (16) and `test/stage10b.part2b.http.test.js` (5), both in `npm test -w server` (437 tests total).

### Manual launch checklist (not done by code)
1. Run migrations (automatic on start; user_version 25). 2. Grant `payment.configure`, `pricing.manage`, `payment.review`, `payment.refund` to the right administrators. 3. Set the official UPI ID, payee name, instructions, support contact and verification target (Priority Pricing & UPI page); upload the official QR. 4. Set 1/2/3-month prices. 5. Confirm `PAYMENT_PROOF_DIR` (QR images are stored in a sibling `payment-qr` folder) is private, writable and backed up. 6. Set `SESSION_SECRET`, SMTP (if e-mails are wanted) and `AUTOMATION_ENABLED=true` so overdue sweeps run between page views. 7. Walk one mock order end-to-end (order → UTR → verify → refund) with test accounts. 8. Staff the verification process before advertising any turnaround; the target is a goal, not a guarantee.

### Known limitations
Refunding a payment does not revoke an already issued certificate (an administrator decision); a refund can be requested only for a VERIFIED payment; only student-facing text for in-app notifications (e-mail uses the existing mailer settings); the UI for Part 2B was build-checked but not browser-tested.

## Stage 10C — Part 1: payment audit, security hardening and financial records

*Manual UPI only. No gateway, no automatic verification: a student's UTR or screenshot is a claim, and every confirmation/rejection is an explicit administrator action.*

- **Transaction records** (migration 26): `payment_transactions` holds one append-only row per confirmed payment (`TXN-…`, student, request, confirmed amount and UTR, verifying admin, verification time). Existing verified payments are backfilled. Pending, rejected, expired and free-correction records never get a row.
- **Reports** (`GET /admin/priority-payments/reports/summary`, `/reports/transactions`, `/reports/transactions.csv?from=&to=&status=all|refund_pending|refunded|not_refunded`), permission `payment.report` (granted by migration to existing `payment.review` holders; `node scripts/grant-payment-permission.mjs <email> payment.report`). **Net Collections = Confirmed Gross Receipts − Completed Refunds**; requested/approved refunds are shown as refund-pending and are not deducted until the transfer is recorded. CSV has student IDs only (no names, e-mail, proofs, UPI details) and neutralises spreadsheet formulas.
- **Queue**: new `awaiting_payment` filter (alias `awaiting_verification` = `pending`); every row carries `statusLabel`, elapsed time, seconds to the verification deadline / overdue seconds, refund split, number of previous admin actions and the last action. Overdue is only an indicator.
- **Security**: per-account rate limits on payment writes, uploads, admin decisions and report/export (`RATE_LIMIT_PAYMENT_WRITE_MAX`, `…_PAYMENT_UPLOAD_MAX`, `…_ADMIN_PAYMENT_WRITE_MAX`, `…_ADMIN_EXPORT_MAX`); cross-site no-Origin writes refused; full PNG signature check; no orphan proof file on failed writes; impossible dates (`2026-13-40`) now return 400 instead of 500; over-long refund destinations are refused instead of truncated; QR/UPI destination-change warning on open orders.
- Tests: `npm test -w server` → 466 pass / 0 fail / 0 skipped (439 existing + 27 new in `stage10c.part1.*.test.js`).

## Stage 10C — Part 2 (in progress): certificate corrections — permission and separation of duties

*Backend security change. Manual UPI only; nothing here touches payments.*

- **New permission `certificate.correct`.** Needed to create, review (list/open), approve and cancel free certificate corrections. All `/admin/priority-certificates/corrections*` routes are gated in the router **and** again inside the service for create / approve / cancel. It is a database grant only: `PAYMENT_ADMIN_EMAILS` does **not** imply it, the shared API key never qualifies, and `GET /admin/priority-payments/permissions` is unchanged (it lists payment permissions only). Refusals return `403 PERMISSION_REQUIRED` and are audited (`admin.access_denied`).
- **Separation of duties.** The administrator who created a correction cannot approve it (`403 SELF_APPROVAL_FORBIDDEN`, audited as a failed `correction.approve`). A second administrator holding `certificate.correct` must approve; until then the request stays `Pending Approval` and the original certificate is untouched. Nothing bypasses this when only one authorized administrator exists. The creator may still cancel their own request (with a reason). Approval records `approved_by`, `approved_by_name`, `approved_at` next to the existing `created_by` / `created_at`; the audit row for the approval names both administrators. Students never see any of this.
- **Eligibility is unchanged and still re-checked at reissue** (completed internship, required tasks approved, certificate approval, dates genuine, no shortening). A correction bypasses payment only.
- **Migration 27 (backward-compatible).** Rebuilds `admin_permissions` with every row copied and `certificate.correct` added to the CHECK; **every existing administrator receives the permission** (`granted_by = 'migration 27'`) so nobody is locked out; administrators created later receive nothing until granted. Adds nullable `free_corrections.approved_at` and `approved_by_name` (older rows keep NULL). The migration is a function and the ADD COLUMNs are guarded, so it can be replayed. Migration 26's copy step now filters to the five permissions it knew about, so replaying 26 on a database that already holds `certificate.correct` no longer fails (no effect on a normal upgrade). Nothing is dropped except the old `admin_permissions` table after its rows are copied. **Before deploying: back up the database file.**
- **Granting and revoking** is done only by a **super administrator** through `node scripts/certificate-permission.mjs <grant|revoke|list> [adminEmail] --by <superAdminEmail>` (also `npm run cert:permission -- …`). `--by` must be an existing administrator account listed in the new env var `SUPER_ADMIN_EMAILS`; with it empty the script refuses everything. There is **no HTTP route** that changes permissions. Every change is audited (`permission.grant` / `permission.revoke`, in the super administrator's name); refused attempts are audited too; `scripts/grant-payment-permission.mjs` now audits its grants as well. Revoking down to fewer than two holders prints a warning: corrections need two different people.
- **Tests.** New `test/stage10c.part2.corrections.test.js` (5 tests, added to `npm test`). Existing tests were adjusted only in their *setup* because the rules they exercised changed: `stage10c.payfixture.js` and `stage10b.part1.test.js` grant `certificate.correct` to the test boss; `stage10a.part2.test.js` adds a second administrator (`checker`) who performs the approvals, and its one audit assertion now expects the approver's name (`Checker Admin`, previously `Boss Admin`). No assertion was removed or loosened.
- **Verification status.** The migration was run for real against a copy of the shipped database at schema 25 plus seeded administrators (upgrade, idempotent second start, and the migration-26 replay used by the finance test). The permission script test passed in an isolated copy. The HTTP tests and the full suite have **not** been run since these changes: run `npm test -w server`.
- **Not changed:** `POST /admin/priority-certificates/requests/:id/issue` (priority issuance) still needs only an administrator session; the admin UI does not yet show or explain the new permission (the server's error message is displayed).

## Stage 10D — admin setup, public priority certificate, automatic application approval

- **Creating administrators (`npm run admin:create`).** A new administrator always gets a hidden password prompt (12+ characters, entered twice). When you promote an **existing** student account, a terminal now asks for a new admin password by default (Enter = yes; before, the default was "no" and the old student password silently stayed). It then offers payment permissions: `1` verify/approve payments + reports (`payment.review`, `payment.report`), `2` everything (adds refunds, UPI settings, pricing), `3` none. Non-interactive shortcuts: `--verify-payments`, `--payments` (all) or `--payments payment.review,payment.refund`. For an existing administrator: `npm run admin:payments -- <email> payment.review`.
- **Public priority certificate.** Public by default: every signed-in student can open `/priority-certificate` without an invitation link. Eligibility checks, the server-set price and manual UPI payment verification are unchanged. Set `PRIORITY_PUBLIC_ACCESS=false` to go back to invitation only (invitation links keep working either way).
- **Automatic APPLICATION approval** (`services/autoApproval.js`, run by the automation worker, and right after a student submits when `AUTO_APPROVE_DELAY_MINUTES=0`). OFF unless `AUTO_APPROVE_APPLICATIONS=true`. An application is approved only when **all** hold: it is still `Submitted` (an administrator's "Under Review"/rejection is never touched); no administrator note exists on it; the waiting period has passed; the listing is allowed (`AUTO_APPROVE_INTERNSHIPS`) and not longer than `AUTO_APPROVE_MAX_DURATION_DAYS`; the existing transparent evaluation recommends approval (profile complete, required skills declared, seat free, inside the application window, account active, no duplicate); listing prerequisites a computer cannot check block only if `AUTO_APPROVE_ALLOW_MANUAL_CHECKS=false`; and the student holds fewer than `AUTO_APPROVE_MAX_ACTIVE` unfinished internships. Nothing is ever rejected automatically; anything that fails a condition waits for a person exactly as before. Each approval uses the normal status change (history row "Automation", student notification, audit entry) and stores the evaluation that justified it; the same cycle then creates the internship record and offer letter. **Tasks are NOT auto-approved**: task review stays manual.
- **Tests.** `server/test/stage10d.autoapprove.test.js` (6 tests). The pre-existing failing test in `stage10b.part2b.service.test.js` (source scan of `freeCorrections.js`) now allows the single permission import from `db/payments.js`. Full suite: run `npm test -w server`.

## Instant-certificate plans (1, 2 or 3 months)
- `/student/priority-certificate` now shows three plans: **1 month, 2 months, 3 months** (prices come from the server price list; there is no 7-day plan). Every signed-in student who can open the page can choose one; no earlier application or completed internship is needed.
- Flow: choose plan → confirm details → UPI payment order → student submits the UTR → an administrator verifies it (existing payment queue) → the **certificate is issued instantly** and appears under Documents.
- API: `GET /priority-certificate/plans`, `POST /priority-certificate/plans { months: 1|2|3, confirmPersonal, confirmAcademic }`. Everything after that reuses the existing payment endpoints.
- Server: `services/instantCertificate.js`. Choosing a plan creates a private (unpublished) listing for that length, an approved application and an internship record for the student, and a request flagged `instant = 1` (migration 28). When the payment is verified, the internship is marked complete and the certificate is issued through the normal Stage 06 issuing service. If issuing fails (for example organisation details are incomplete) the payment stays verified and issuing is retried when the student reopens the page.
- The older "completed internship" priority flow is unchanged. Test: `server/test/stage10e.plans.test.js`.

## Stage 10F — payment UI redesign and offer letter → certificate timing
- **Paid 1/2/3-month plans no longer issue the certificate on payment day.** When an administrator approves the payment: the plan starts today, the **offer letter is issued immediately**, and the certificate is pre-approved. The **certificate is issued automatically when the plan period ends** (start + 30/60/90 days) by the normal automation cycle (`services/instantCertificate.js` → `fulfilAllDue`, called from `automation/worker.js`). Required tasks, if any were assigned, must still be approved first. The request stays `Payment Verified` until the certificate exists, then becomes `Certificate Issued`.
- Admin **Payments** page (`/admin/payment-verification`) is now a card list with one clear **Approve** button; the five server-required checks are shown as a checklist with "Tick all". **Prices & UPI** page split into two tabs. Student payment screen restyled. New stylesheet `client/src/styles/pay.css`.
- Tests: `stage10e.plans.test.js` updated (offer letter now, nothing at +10 days, certificate after the period).
