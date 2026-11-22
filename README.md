<p align="center"><img src="web/assets/brand/logo-mark.png" alt="Zintra" width="96"></p>

# Zintra حاضر

Staff attendance, points and rewards for **زينترا / Zintra**: location-checked check-in and check-out, a points system with green, red and black points, a monthly green reward, leave and early-leave requests, Telegram alerts for the owner, and monthly payroll-ready reports.

> Status: **Steps 1–10 built.** All the features are in place: attendance with a map, the points engine, scheduled jobs, Telegram and Web Push, leave and early leave, rewards, payroll exports and the leaderboard. Remaining hand-over items are listed below.

## Stack

- **Frontend:** plain HTML, CSS and ES-module JavaScript in `web/`. No build step and no framework.
- **Backend:** Supabase (Postgres, RLS, Edge Functions, pg_cron). Added from Step 2.

## Layout

```
assets/brand/            logo source files (unmodified; source of truth)
web/                     static site root (deploy this folder)
  index.html             app entry (login + staff shell + owner shell)
  design/index.html      DEV ONLY design-system preview (exclude from production)
  manifest.webmanifest   PWA manifest
  css/tokens.css         ALL design tokens (colors, type, spacing, radii, shadows, z, motion; light + dark)
  css/base.css           reset, typography, focus, RTL/LTR utilities
  css/components.css     button, field, select, switch, segmented, card, badge, table,
                         progress, empty state, skeleton, modal, toast, alert
  css/shell.css          sidebar / top bar / bottom bar / drawer / page header / login
  i18n/ar.json, en.json  one messages file per language (the product name is the single key `app.name`)
  js/boot.js             sets language, direction and theme before first paint
  js/core/               i18n, theme, router, dom helpers, safe storage
  js/ui/                 reusable components
  js/shell/              app shell + separate staff / owner navigation trees
  js/pages/              login, placeholder pages, design preview
tools/                   quality checks (contrast, token lint, UI matrix, keyboard)
```

## Backend (Supabase)

```
supabase/config.toml        CLI config (public sign-up OFF; functions do their own auth)
supabase/migrations/        versioned schema (apply in order)
supabase/rollback/          matching *.down.sql files (see supabase/rollback/README.md)
supabase/tests/rls_test.sql RLS/privilege tests (run inside a rolled-back transaction)
supabase/functions/         Edge Functions (Deno): login, owner-employees, bootstrap
```

### Features (Steps 3–10) and where they live
| Area | Database (`supabase/migrations/*_engine.sql`) | Screen |
|---|---|---|
| Check-in / check-out (geofence, server clock) | `svc_check_in`, `svc_check_out`, `svc_my_day` | Staff → Attendance (Leaflet + OpenStreetMap) |
| Windows, day rules, settings (audited, `rule_version`) | `private.evaluate_time`, `svc_save_day`, `svc_update_settings` | Owner → Settings |
| Points engine, red warning policy | `private.recalc_reds`, `private.add_event` | Staff → My points |
| Absence job, digest, weekly summary, reminders | `private.run_absence`, `run_digest`, `run_weekly`, `enqueue_reminders`, `private.tick()` | (scheduled) |
| Owner Telegram alerts + early-leave approve/reject from Telegram | outbox → `dispatch` / `telegram-webhook` functions | Owner → Settings → Connect Telegram |
| Staff Web Push reminders | `push_subscriptions` + `dispatch` | Staff → Home / My account |
| Outcome points, manual adjustments (Add/Remove/Set, black needs amount confirmation) | `svc_award_outcome`, `svc_manual_adjust` | Owner → Employees → Edit |
| Reward request & payout (InstaPay / Vodafone Cash) | `svc_request_reward`, `svc_decide_reward` | Staff → My points · Owner → Approvals |
| Leave, early leave, retroactive reversal | `svc_request_leave`, `svc_decide_leave`, `svc_request_early_leave`, `svc_decide_early_leave` | Staff → Requests · Owner → Approvals |
| Holidays | `svc_save_holiday` | Owner → Public holidays |
| Dashboards, payroll (PDF / Excel / CSV) | `svc_owner_dashboard`, `svc_payroll`, `svc_export_raw` | Owner → Dashboard, Payroll reports |
| Leaderboard (green only for staff) | `public.get_leaderboard()` | Leaderboard |
| Job titles | `profiles.job_title_ar/en`, `svc_set_job_title` | Owner → Employees |

All staff/owner actions go through one Edge Function, `api`, which authenticates the caller and enforces their role, then calls the matching `svc_*` function. That function enforces every rule using the database clock in Africa/Cairo time.

### Schedules (pg_cron)
- `zh-tick` runs every minute. It calls `private.tick()`, which runs:
  - the absence job after the cutoff, with catch-up for up to 7 days;
  - the digest at its send time (a missed digest for today is sent late once; older ones are recorded as skipped);
  - the weekly summary;
  - the monthly deductions on the 1st;
  - flags for missing check-outs;
  - reminder fan-out.
- `zh-dispatch` runs every minute, but only when the outbox has due messages. It POSTs to the `dispatch` function with a random token stored in Supabase Vault.
- Run records are kept in `public.job_runs`. Each job is idempotent: running it twice doesn't create duplicate points or send duplicate messages.

### Data model highlights
- **Profiles and roles.** Each person has a `profiles` row with role `owner` or `staff`. The role is also copied into `app_metadata.role` for routing, but the database row is what counts. Every Auth user has a made-up internal email (`<uuid>@staff.invalid`) that is never shown and never used to sign in.
- **Row Level Security on every table.**
  - **Who counts as signed in.** A request is accepted only if the JWT is valid, the profile is active, and the JWT's `session_id` still exists in `auth.sessions`. So revoking a session, regenerating a code or deactivating someone takes effect on the very next request.
  - **Who sees what.** Staff read only their own rows. The owner reads everything.
  - **How data changes.** Writes go through Edge Functions to `svc_*` SQL functions. Only the service role can execute these; browser roles can't.
- **Salaries are owner-only.** `employee_salaries` has no staff policy of any kind.
- **Credential tables are server-only.** `login_codes` (bcrypt hashes only) and `login_attempts` (HMAC'd client identifiers only) can't be read by any browser session, not even the owner's.
- **Point counters are derived.** Totals come from active `point_events` through `v_point_totals`; pending or declined events never count.
- **Money is stored in integer piastres.** 1 EGP = 100 piastres.

### Provisioning
- **Supabase MCP (preferred).** Connect with `/mcp` (browser OAuth, scoped to this project, development branch first). No personal access token is needed. Migrations, functions and SQL are applied through the MCP from the versioned files in this repo.
- **Supabase CLI (fallback):**
  ```bash
  supabase link --project-ref <ref>       # confirm the ref first
  supabase db push                        # applies supabase/migrations
  supabase functions deploy login --no-verify-jwt
  supabase functions deploy owner-employees --no-verify-jwt
  supabase functions deploy bootstrap --no-verify-jwt
  ```
- **Local development (needs Docker):** `supabase start`, then `supabase db reset` (migrations + `seed.sql`), then `supabase functions serve`.
- **Migration test without Docker:** `tools/sql-test/run.sh` applies the migrations to a scratch Postgres with Supabase `auth` stubs, runs the RLS tests, runs the rollback, and applies the migrations again.

### Required Auth settings (Dashboard → Authentication)
- **Sign In / Providers:** turn off "Allow new users to sign up". Keep the Email provider enabled, because the login function uses it to create sessions. Accounts are created only by the owner through `owner-employees`.
- **Sessions:**
  - **Access tokens:** JWT expiry 3600 s; supabase-js refreshes them silently.
  - **Refresh tokens:** they don't expire by default, so a session lasts until logout or revocation. That meets the "at least 30 days" requirement.
  - **Time-box / inactivity timeout:** optional and needs a paid plan. If enabled, set it to 30 days or more.

### Code-only login: security trade-off
Signing in with a code alone is convenient: one number, no email account, nothing else to remember. It is also weaker than an identifier plus a password, because everyone's code comes from the same numeric space. These controls are therefore mandatory and must not be weakened for convenience:

- **Codes:**
  - Each code is a random 8-digit number by default, configurable from 6 to 12. It comes from a cryptographically secure generator with rejection sampling to avoid bias, and is unique among current codes.
  - Codes are stored only as salted bcrypt hashes and verified only in the `login` Edge Function. The function compares the submitted code against every stored hash, so timing doesn't reveal a match.
- **Failures:** every failure gets the same generic message, padded to a similar response time.
- **Lockout:**
  - A device or IP is locked out after 5 failures within 15 minutes. The lock lasts 15 minutes, then 1 hour, then 24 hours for repeat offenders.
  - A global throttle kicks in at 50 failures per hour across all clients.
  - The owner gets a Telegram alert, which never contains a submitted code.
  - All thresholds are editable in `settings`.
- **Code display:** a code is shown once to the owner when it is created or regenerated, then never again. It never appears in logs, the audit log, the notification outbox, Telegram messages, URLs or browser storage.

### Sessions (design choice B)
After a code matches, the `login` function creates a real Supabase session for that person's Auth user. It calls `admin.generateLink` with type magiclink, then completes `verifyOtp` on the server. No email is sent, and the user has no password. The browser installs the session with `setSession`.

We chose this over hand-made JWTs because Supabase already handles refresh-token rotation, `auth.uid()` for RLS, and per-session revocation. Sign-out ends only this device's session. The owner can list and revoke sessions per employee.

### Initial owner code
The owner code is never shown in a terminal, a log or chat. It comes back encrypted to a key that exists only on the developer's machine.

```bash
node tools/bootstrap/prepare.mjs owner      # makes a key + one-time token in .secrets/, prints only public values
# run the printed SQL to insert the token hash (expires in 15 min)
# call the bootstrap function: POST /functions/v1/bootstrap
#   {"token": <contents of .secrets/bootstrap-token.txt>, "purpose": "owner",
#    "public_key_jwk": <printed public key>, "owner_name_ar": "...", "owner_name_en": "..."}
# save the JSON response to a file, then:
node tools/bootstrap/open.mjs response.json # writes .secrets/owner-code.txt (never printed)
```

After signing in, the owner should regenerate their code from **My account** and delete the file. If the owner code is lost, a developer runs the same procedure; the `owner` purpose works only while no owner exists. Otherwise, another owner regenerates it from Employees. `purpose: "seed_staff"` creates three demo staff accounts for development.

### Secrets (names only, never values)
| Name | Where | Used by |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | provided by the platform to Edge Functions | all functions |
| `TELEGRAM_BOT_TOKEN` | Dashboard → Edge Functions → Secrets | `dispatch`, `api` (connect/test), `telegram-webhook` |
| `VAPID_PRIVATE_KEY` | Dashboard → Edge Functions → Secrets | `dispatch` (web push). The public key is in `web/js/core/push.js` and `dispatch/index.ts` |
| `LOGIN_HASH_PEPPER` (optional) | Dashboard → Edge Functions → Secrets | HMAC key for attempt identifiers (defaults to a service-key-derived key) |
| `ALLOWED_ORIGINS` (optional) | Dashboard → Edge Functions → Secrets | CORS allow-list for the static site origin |

Secret values are entered only in the Dashboard. They never go in chat, MCP arguments, command lines, git or logs. The browser gets only the project URL and the publishable key (`web/js/config.js`).

### Telegram setup
1. Create the bot with @BotFather (`/newbot`). Put the token in the secret `TELEGRAM_BOT_TOKEN`, entered in the Dashboard only.
2. From the owner chat (ID 1360140225 by default), send `/start` to the bot.
3. Owner → Settings → **Connect Telegram bot**. This calls `setWebhook` with a secret header that only our webhook accepts.
4. Send yourself a test message from the same screen.
5. Early-leave requests arrive with ✅/❌ buttons. You can also reply `موافق 7` / `رفض 7` (or `approve 7` / `reject 7`). Updates from any other chat are ignored.

### Web Push (VAPID)
The key pair was generated once with `web-push generate-vapid-keys`. The private key was written to a git-ignored file under `.secrets/`, then moved by the owner into the Dashboard secret `VAPID_PRIVATE_KEY`, and the local file was deleted. To rotate the keys:
1. Generate a new pair.
2. Replace the public key in both files above.
3. Update the secret.
4. Redeploy `dispatch` and the site.
5. Staff re-enable notifications from **My account**.

### Backups
Supabase takes daily backups on paid plans, and Point-in-Time Recovery is an add-on. On the free plan, run `supabase db dump -f backup.sql --data-only` (plus a schema dump) on a schedule. To check a restore, run `psql "$DB_URL" -f backup.sql` against a scratch project.

## Run locally

```bash
npm run serve            # http://127.0.0.1:8787  (any static server works)
# app:     http://127.0.0.1:8787/index.html#/login
# design:  http://127.0.0.1:8787/design/index.html
```

## Quality checks

The checks need Node 18 or later and Playwright with Chromium.

```bash
npm run check:tokens     # no raw colors / font sizes / px spacing outside tokens.css
npm run check:contrast   # every shipped text/background pair passes WCAG AA, both themes
npm run check:ui         # 6 pages x 360/1440 px x ar/en x light/dark: no console errors, no overflow
npm run check:keyboard   # tab order + visible focus, keyboard language switch, modal/drawer focus
npm run check:auth       # login/guards/code-once/employees flows (MOCKED backend)
npm run check:sql        # migrations + RLS tests + rollback on a scratch Postgres
npm run check:deno       # Edge Function unit tests (code generation, hashing, matching)
node tools/e2e-features.mjs   # Steps 3–10 flows (MOCKED backend): geofence, check-in/out, approvals, exports
node tools/pwa-check.mjs      # installability + offline
```

`ui-check`, `keyboard-check` and `check:auth` replace the Supabase API with a mock (`tools/mock-backend.mjs`), so they test the UI without a network. Real-backend behaviour is checked separately against the project.

## Installable app (PWA)
- **Manifest:** `manifest.webmanifest` provides:
  - the name "Zintra حاضر" and standalone display;
  - brand icons, including a maskable one;
  - shortcuts to Attendance and My points;
  - screenshots for the richer install dialog.
- **Service worker (`sw.js`):**
  - It precaches the app shell, so the installed app opens instantly.
  - Navigations try the network first, with an offline fallback.
  - It **never** caches Supabase/API calls.
  - New versions wait until the user taps "Update".
  - Bump `VERSION` in `sw.js` on each deploy.
- **Install UI:**
  - Android and desktop Chrome/Edge get an install card and button.
  - iPhone and iPad get the "Share → Add to Home Screen" steps, because Safari has no install prompt.
  - It is hidden once installed, and "Not now" is remembered.
- **Testing:** `node tools/pwa-check.mjs` checks Chromium's installability criteria, that every precached file exists, and offline start-up.

## Brand and design notes

- **Name:** "Zintra حاضر" is rendered inside `<bdi dir="ltr">`. In `<title>` it is wrapped in LRI…PDI isolates, so it keeps the same visual order in Arabic and English layouts.
- **Palette:** colors come from the logo (brand blue `#0245A0`, navy `#011B5A`, cyan `#02B0C8`/`#0CE4EF`, gold `#E4AF48`).
- **Gold:** used only for rewards.
- **Status colors:** jade, burnt orange, crimson and violet. They are chosen to stay distinct from the brand colors and from the green, red and black point colors.
- **Dark mode:** follows the device setting by default. A manual toggle is stored per device in `localStorage`.
- **Font:** IBM Plex Sans Arabic (SIL OFL 1.1), self-hosted in `web/assets/fonts/`.
- **Icons:** favicons and PWA icons are generated from `assets/brand/zintra-logo-source.png` and are never recolored or stretched.
