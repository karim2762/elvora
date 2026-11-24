# ELVORA — Production Hosting Preparation (Stage 11A, Part 1)

Status: PREPARED, NOT DEPLOYED. Nothing here has been run against a real host. Prices are USD list prices seen in Nov 2026 converted at an assumed ~₹88/USD; re-check before paying.

## 1. Stack (as inspected)
- Client: React 18 + Vite 5 + react-router 6 (static SPA, `client/`).
- Server: Node 22.13+ / Express 4, built-in `node:sqlite` (experimental warning on Node 22), helmet, cors, express-rate-limit, pdfkit, nodemailer.
- Database: ONE SQLite file (WAL, foreign keys ON), 57 tables / 137 indexes, migrations run on startup (`migrate()`).
- Files: PDFs in `DOCUMENTS_DIR`, payment proofs in `PAYMENT_PROOF_DIR`; never served statically, only through ownership-checked routes.
- Background worker (offers, certificates, emails) runs INSIDE the API process.

Consequence: the backend needs a persistent disk, exactly one always-on instance. Free tiers that sleep or wipe disk are unsuitable.

## 2. Recommended architecture
| Part | Choice | Why |
|---|---|---|
| Frontend | Vercel (Hobby) static | Free, HTTPS, SPA rewrites, `client/vercel.json` |
| Backend + DB + files | Render Web Service **Starter** + 1 GB persistent disk | Keeps SQLite and private files unchanged; always-on so the worker runs |
| Email | Existing SMTP via env (provider TBD by owner) | No code change |
| Backups | `server/scripts/backup-db.mjs` + disk snapshots + off-site copy | See §6 |

Estimated monthly cost: Starter ≈ $7 + disk 1 GB ≈ $0.25 → about **₹640/month** (Vercel free, domain not included). Render's pricing pages mention workspace plans (Hobby $0); confirm no extra fee applies.

Fallback: Railway or Fly.io with a volume (same single-instance rule; pricing UNVERIFIED), or Netlify instead of Vercel (`/api/*` proxy rule + SPA fallback in `netlify.toml`). Migrating to Postgres (Neon/Supabase) would give managed backups but needs a database-layer rewrite — NOT recommended now.

## 3. Provider comparison
| Option | Free tier | Fits ELVORA? | Notes |
|---|---|---|---|
| Vercel / Netlify (frontend) | Yes | Yes | Both fine; Vercel config prepared |
| Render free web | Sleeps after 15 min, ephemeral disk | **No** | Would lose SQLite + PDFs on every restart |
| Render Starter + disk | No (~₹640/mo) | **Yes** | Recommended; disks attach to paid services only; no disk snapshots promised here — verify |
| Railway / Fly volume | Trial/usage-based | Possible | Fallback; pricing UNVERIFIED |
| Neon / Supabase Postgres | Yes | Not without rewrite | Skip |

## 4. Same-site cookies (important)
Session cookie: `httpOnly`, `Secure` in production, `SameSite=Lax`.
- **Interim (default hostnames `*.vercel.app` + `*.onrender.com`)**: these are different sites, so Lax cookies would NOT be sent on direct API calls. Use the Vercel `/api/*` rewrite in `client/vercel.json` (browser sees one origin), keep `VITE_API_URL=/api/v1`. Replace `REPLACE-WITH-API-HOST` with the Render hostname.
- **With your own domain**: `app.example.com` (or apex) + `api.example.com` are same-site, so set `VITE_API_URL=https://api.example.com/api/v1`, `CORS_ORIGIN=https://example.com`. No proxy needed.
- `TRUST_PROXY`: rate limits and audit logs use client IP. Behind Vercel → Render it may need `2`, not `1`. Verify in Part 2 by checking the IP seen on a login attempt; a wrong value lets everyone share one rate-limit bucket or lets IPs be spoofed.

## 5. Production configuration changes made in this part
1. `GET /api/v1/health/ready` — checks the database; returns 503 with no details on failure. Existing `/api/v1/health` unchanged.
2. Graceful SIGTERM/SIGINT shutdown with WAL checkpoint in `server/src/server.js`.
3. `server/scripts/backup-db.mjs` — consistent online backup via `VACUUM INTO`, integrity-verified, never overwrites.
4. `render.yaml`, `client/vercel.json` (SPA fallback, API rewrite, security headers, asset caching).
5. `.gitignore` hardened (`.env.*`, `*.db*`, backups); `.env.example` production section (placeholders only).

Existing behaviour already production-safe (read from code, not exercised): production refuses to boot without a 32+ char `SESSION_SECRET`, requires https `CLIENT_URL` / `GITHUB_CALLBACK_URL`, ignores dev flags (`ALLOW_SELF_REVIEW`, `DEV_LOG_RESET_LINKS`), hides error messages (generic "Server error"), scrypt password hashing (N=32768) with dummy verify, SHA-256-hashed session tokens, CORS allow-list + Origin/Sec-Fetch-Site CSRF checks, helmet, per-route rate limits, magic-byte checks on uploads, `nosniff` + `no-store` on private downloads, timing-safe key/webhook comparisons.

## 6. Database: readiness, backup, restore, rollback
- Migrations are additive and run at startup against the file at `DATABASE_URL`. **A fresh disk = an EMPTY database** (no students, payments or documents). Never point production at an empty file if real data exists elsewhere.
- Migrating existing data (if any): stop writes → `node server/scripts/backup-db.mjs` → copy the `.db` plus `documents/` and `payment-proofs/` to the disk → start → check `/health/ready` → compare row counts.
- Backup: run the script daily (Render cron/job or external) and copy off-site; back up `DOCUMENTS_DIR` and `PAYMENT_PROOF_DIR` too (the script does NOT). Test a restore before launch.
- Restore: stop service → keep the current file as `elevora.db.bad` → copy the verified backup to `DATABASE_URL` path (delete stale `-wal`/`-shm`) → start.
- Rollback of a deploy: redeploy the previous commit; migrations only add, so the old code runs on the new schema, but take a backup first.
- Pooling: not applicable (single local SQLite connection).

## 7. Domain plan (no domain purchased)
- `example.com` → Vercel (A/CNAME as Vercel instructs); `www` redirects to the apex; `api.example.com` → Render CNAME. HTTPS certificates are automatic on both.
- Update after the domain is confirmed: `CLIENT_URL`, `CORS_ORIGIN`, `VITE_API_URL`, `GITHUB_CALLBACK_URL` + the GitHub App callback/webhook URLs, `ORG_WEBSITE`, canonical/og:url tags. QR codes encode `CLIENT_URL/verify/<ref>`: documents issued BEFORE the final domain is set keep the old URL, so set the final domain before issuing real documents.

## 8. Remaining blockers / required from the owner
- Authorization to create Render and Vercel accounts and start a paid Starter plan; the domain choice.
- Secrets to be created in the dashboards: `ADMIN_API_KEY`, SMTP credentials, `MAIL_FROM`, `ORG_ADDRESS`, `ORG_EMAIL`, GitHub App credentials (optional feature), `SUPER_ADMIN_EMAILS`.
- UPI ID/QR/payee are admin settings stored in the database, so they must be entered in the production admin console (nothing is carried over from a dev database).
- Initial admin account: `npm run admin:create` on the server shell.

---

# Part 2 (Stage 11, final): Deployment runbook and verification status

Status: **NOT DEPLOYED — BLOCKED on owner actions** (no Render/Vercel accounts, no authorization for the paid plan, no domain, no SMTP credentials were available to the build environment, and its network cannot reach those providers). Everything below marked "verified locally" was run against a production-mode build on localhost, not on a public host.

## A. Changes made in Part 2
- `nodemailer` 6.10.1 → **10.6.1** (`npm audit --omit=dev` showed 1 high + several moderate advisories: address-parser DoS, recipient-domain bypasses). Mail tests and the full suite pass after the change.
- No other code changes. Features, routes, schema and pricing untouched.

## B. Deploy steps (do these in order)
1. **Render** (Starter + 1 GB disk, region Singapore): New → Blueprint from your Git repo containing `render.yaml`. In the dashboard set: `CORS_ORIGIN`, `CLIENT_URL` (both = final https frontend origin), `ADMIN_API_KEY` (`npm run admin:key`), `SUPER_ADMIN_EMAILS`, `ORG_ADDRESS`, `ORG_EMAIL`, `ORG_SIGNATORY_NAME/TITLE`, SMTP vars + `MAIL_FROM`. `SESSION_SECRET` is generated automatically. Wait for `/api/v1/health/ready` → `{"status":"ok","database":"ok"}`.
2. **Admin account**: Render Shell → `npm run admin:create -- --email you@example.com --name "Your Name"`; then `npm run tasks:seed` is NOT needed (library seeds on boot).
3. **Vercel**: import the repo, root `client`, framework Vite. Env: `VITE_API_URL=/api/v1`. Edit `client/vercel.json` and replace `REPLACE-WITH-API-HOST` with the Render hostname (`xxxx.onrender.com`), commit, redeploy.
4. **Set `CLIENT_URL` / `CORS_ORIGIN`** on Render to the Vercel URL, redeploy the API. Set the final domain BEFORE issuing real documents (QR codes embed `CLIENT_URL`).
5. **TRUST_PROXY**: behind Vercel→Render try `2`. Verify: log in wrongly 6 times from your phone and from a second network; each IP must be throttled independently, and the audit log must show your real IP.
6. **Admin console → Payments settings**: enter the real UPI ID, payee, QR. Confirm prices 49 / 99 / 199 and no 7-day paid option.
7. **Backups**: schedule `node server/scripts/backup-db.mjs <dir>` daily (Render Cron Job on the same disk is not possible — disks attach to one service — so run it from the web service's shell/cron or an external runner), and copy `/var/data/documents` and `/var/data/payment-proofs` off-site. Do a restore drill (section D) before launch.
8. **Monitoring** (free): UptimeRobot/BetterStack on `https://<api>/api/v1/health/ready`; enable Render deploy-failure email notifications; Vercel deployment notifications.
9. Run the full manual checklist in section E on the live URL.

## C. Custom domain (when you own one)
`example.com` → Vercel (records Vercel shows); `www` → redirect to apex; `api.example.com` → CNAME to the Render hostname. Then: `VITE_API_URL=https://api.example.com/api/v1`, `CORS_ORIGIN=https://example.com`, `CLIENT_URL=https://example.com`, `GITHUB_CALLBACK_URL` + GitHub App URLs, `ORG_WEBSITE`. Remove the `/api` rewrite once same-site.

## D. Backup / restore (backup verified locally; restore drill is on a copy only)
- Backup: `node server/scripts/backup-db.mjs /var/data/backups` (integrity-checked, never overwrites).
- Restore: stop service → `mv elevora.db elevora.db.bad` → delete stale `-wal`/`-shm` → copy backup in as `elevora.db` → start → `/health/ready` → compare row counts. A scripted row-count comparison (57 tables, 0 mismatches, 0 FK violations) passed on a local backup.
- Render's own disk snapshot behaviour is UNVERIFIED — check the dashboard; do not rely on it alone.

## E. Live checklist (not yet run — requires a deployed site)
Student: register → login → browse → apply → dashboard → tasks → submit → documents → `/verify/<ref>`. Priority: eligibility → UPI instructions → test UTR → pending → admin approve/reject (use a test student, never a real payment) → status. Admin: login, internships, applications, students, tasks, evaluation, documents, payments, audit logs, settings. General: mobile widths, broken links, console errors, session expiry, direct nested-route refresh, headers on the Vercel domain (`curl -I`), cache headers on `/api/*` (`Cache-Control: no-store` for private routes).

## F. Troubleshooting & rollback
- API won't boot: Render logs show the config error (`SESSION_SECRET`, `CLIENT_URL` must be https, Node ≥ 22.13).
- Login works but session lost: cookies are Lax — you are on two different sites without the `/api` rewrite.
- All users rate-limited together / wrong IPs: `TRUST_PROXY` hop count.
- 503 on `/health/ready`: disk not mounted or DB file unreadable.
- Rollback: backup first, then redeploy the previous commit (migrations are additive). Vercel: Promote previous deployment.
