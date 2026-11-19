# Prodily admin console

The Prodily admin console as a standalone Next.js 16 app. It was extracted from the learner
repo (`web`, app in `web/apps/web`) so the console can deploy on its own host, for example
`admin.prodily.app`. Both apps talk to the same Supabase project.

The split copies shared code instead of sharing a package. Admin-owned code lives only here.
Shared modules (Supabase clients, auth helpers, `withRoute`, notifications, emails, curriculum
loaders, UI primitives) are copies of the web repo files at the same paths, refreshed with
`npm run sync:web`.

## Layout

- `app/admin/**`: the console (`/admin/*`), the login page (`/admin/login`) and
  `/admin/access-denied`. `/` redirects to `/admin`.
- `app/api/admin/**`: the admin APIs (all `withRoute` with the admin policy).
- `app/api/auth/{login,session,refresh,logout}`: admin sign-in, sign-out (with refresh-token
  revocation) and token refresh. The login refuses non-admin accounts after the password check.
  There is no signup, no Google OAuth and no password reset on this host.
- `proxy.ts`: session refresh, the `/admin/*` guard (guests to `/admin/login`, signed-in
  non-admins to `/admin/access-denied`), the same-origin check for cookie-bearing API writes.
- `content/`: a snapshot of `web/content/dist` and `web/content/.ids`. The lesson loader reads it
  from `process.cwd()/content`, and `next.config.ts` traces it into every server function.
- `lib/learner-revalidate.ts`: purges learner caches on the learner site (see below).
- `lib/admin/cron-trigger.ts` and `POST /api/admin/system/cron/[name]`: runs a learner cron job.
- `scripts/sync-from-web.mjs`: refreshes the shared copies and the content snapshot.

## How it relates to the web repo

The admin app does not host `/api/cron/*`, the email webhooks, the send-email hook or
unsubscribe. Those stay on the learner site. Two server-to-server calls connect the apps:

1. Learner cache refresh. When an admin change affects what learners see, the admin app calls
   `POST ${LEARNER_SITE_URL}/api/internal/revalidate` with
   `Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}` and a JSON body
   `{ "tags"?: [{ "tag": string, "expire"?: number }], "paths"?: string[] }`.
   5 second timeout, best effort, never throws. Tags sent: `system_settings`, `leaderboard`
   (`expire: 0` on privacy changes and account deletion), `testimonials`. Paths sent:
   `/academy`, `/dashboard`, `/progress`, `/capstones` (the first four were `layout`
   revalidations in the web repo), `/p/<username>`, `/p/<username>/capstones/<slug>`,
   `/api/og/portfolio/<username>`, `/api/og/portfolio/<username>/capstones/<slug>`.
   Admin-only caches (`admin-dashboard`, `admin-analytics`, `admin-shell`, `admin-automations`,
   `/admin/...` paths) are still revalidated locally.
2. Scheduled jobs. Run-now calls `POST ${LEARNER_SITE_URL}/api/cron/<name>` with
   `Authorization: Bearer ${CRON_SECRET}` from the server. Allowed names: `process-email-queue`,
   `retry-failed`, `daily-reminder`, `weekly-recap`, `cleanup`, `lifecycle`,
   `process-broadcasts`.

Session cookies are host-only (no `Domain` attribute), so an admin session is never sent to the
learner site and a learner session is never sent here. Admins sign in again on the admin host.

## Setup

```bash
npm ci
npm run sync:web -- --dry-run   # see what changed in ../web since the last sync
npm run sync:web                # copy shared modules and the content snapshot
npx tsc --noEmit && npx eslint . && npx vitest run
```

`sync:web` reads the web repo from `../web`, or from `WEB_REPO_DIR` when set. It never writes
to the web repo, never touches admin-owned files, and never overwrites the files modified for the
split. It prints a warning when one of those changed upstream since the split, so the change can
be merged by hand. Protected files:

- `lib/lesson-loader.ts`, `lib/academy/lessons-db.ts` (content path)
- `lib/portfolio-revalidate.ts`, `lib/og/revalidate-capstone-cards.ts`, `lib/leaderboard-db.ts`
  (purge through `revalidateLearner`)
- `lib/security/origin-check.ts` (the admin host is the only trusted origin)
- `lib/auth/logout.ts` (no Quick Start, admin login fallback)
- `lib/brand.ts` (`siteUrl` reads `LEARNER_SITE_URL`)
- `app/api/auth/{login,session,refresh,logout}/route.ts`, `vitest.setup.ts`
- `lib/api/actor.ts`, `lib/auth.ts` and the other modules that diverged when the web repo
  removed the admin console (see the list in `scripts/sync-from-web.mjs`)
- the monitoring files: `lib/monitoring/{logger,redaction,client-error-beacon,client-error-listeners,release}.ts`,
  `lib/api/with-route.ts`, `lib/errors/api-response.ts`, `instrumentation.ts`,
  `app/api/client-errors/route.ts`

Every synced file also gets one automatic rewrite: `process.env.NEXT_PUBLIC_SITE_URL` becomes
`process.env.LEARNER_SITE_URL`, because here `NEXT_PUBLIC_SITE_URL` is the admin host and the
links in emails, certificates and portfolios must point at the learner site.

Never run a `supabase` command from this repo, and never commit `.env*` files.

## Monitoring

Errors are recorded in the shared `system_errors` table, self-hosted, with no third-party SDK.
Both apps write to it; `details.app` says which one (`admin` here, `web` on the learner site).

What is captured:

- Server: every unexpected fault in a `withRoute` handler, every server render, route, action
  or proxy error Next.js reports to `instrumentation.ts`, and the failures the System page
  answers with a fallback. Each row carries the message, `details.stack` (redacted, at most
  30 frames and 4000 characters), `details.release`, `details.app`, `details.runtime`
  (`server`), the request id, and the signed-in admin in `user_id`.
- Browser: the error boundaries (`app/global-error.tsx`, `app/error.tsx`, the console and
  communications boundaries) and global `error` / `unhandledrejection` listeners mounted by the
  console shell post to `POST /api/client-errors` (`details.runtime` is `client`,
  `details.source` is `boundary`, `window.onerror` or `unhandledrejection`). At most 5 reports
  per page load, deduplicated, with ResizeObserver, opaque "Script error." and extension noise
  dropped. The route accepts anonymous reports (8 KB body cap, 10 per minute per IP and 300 per
  10 minutes overall) and attributes a report to the admin only from the session cookie.

Repeats of one fingerprint within 15 minutes of its last occurrence (`updated_at`) increment
`occurrence_count` instead of adding a row. A fingerprint whose latest row is resolved gets a new
row marked `details.regression = true`.

Where to look: System > Errors groups incidents by fingerprint (occurrences are the sum of
`occurrence_count`, last seen is the latest `updated_at`), with filters for app and release; the
drawer shows the stack and full details of the latest occurrence. System > Alerts lists
individual rows; "Show details" expands the same view.

Ignore list: "Ignore" in the error drawer adds the fingerprint to the `system_settings` key
`monitoring_ignored_fingerprints` (a JSON array, at most 500 entries, audited). Ignored groups
are still recorded but never alert, and are hidden from the Errors list unless "Show ignored" is
on. "Unignore" removes the entry. The logger caches the list for 60 seconds per instance and
alerts as usual when it cannot read it.

Release tagging: Vercel sets `VERCEL_GIT_COMMIT_SHA` automatically and the server tags rows
with its first 12 characters. `next.config.ts` copies it into
`NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` at build time so browser reports carry the same release;
set `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` yourself only when building outside Vercel. Without
either, rows have no release.

## Security summary

A rule-based daily security summary (no AI, no paid services). Every sentence in it is a fixed
template filled with counts.

**Migration first.** The tables come from the held migration
`20261119000007_security_events.sql` in the web repo (`security_event_counts`,
`security_digests` and the `record_security_event` RPC). Until it is applied, the page shows
"not set up yet" with the migration name, the cron answers `200` with `status: "not_set_up"`,
and the event recorder switches itself off for 10 minutes at a time. Nothing crashes.

**What feeds it.** Both apps count security events into `security_event_counts` per day
(Asia/Kolkata calendar day), event type, app, network (`ip_bucket`: the client IP coarsened to
its IPv4 /24 or IPv6 /48, or `unresolved`; paths are stored without query or fragment) and hashed account
(`subject_hash`, the first 16 hex characters of sha256 of the lowercased email, with a masked
hint such as `v***m@example.com`; raw emails are never stored). This app records
`admin_login_failed` (wrong password, unknown or unconfirmed account), `admin_login_rate_limited`
and `admin_login_non_admin` from `/api/auth/login`, and `cron_auth_failed` from the digest cron.
The digest also reads `admin_audit_logs`, `system_errors` and the count of new `users` rows for
the day, and the 7 days before it for averages.

**What it detects** (thresholds are named constants in `lib/admin/security-digest/rules.ts`):

| Rule | Fires when | Severity |
| --- | --- | --- |
| `credential_stuffing` | one network has 30 or more `login_failed` + `admin_login_failed` over 10 or more accounts | high |
| `brute_force_account` | one account has 20 or more login failures from any networks | high if any were on the admin login, else medium |
| `admin_login_attack` | any `admin_login_rate_limited`, or 10 or more `admin_login_failed` | high |
| `non_admin_probing` | 3 or more `admin_login_non_admin` | medium |
| `secret_probing` | 5 or more webhook, email hook, cron and internal revalidate auth failures combined | medium, high at 50 |
| `csrf_attempts` | 20 or more `origin_rejected` | low, medium at 200 |
| `reset_spam` | one account with 5 or more reset requests, or total resets above 3x the 7-day daily average and at least 20 | medium |
| `bot_signups` | 20 or more `signup_blocked` + `turnstile_failed` (medium); new signups above 3x the 7-day average and at least 20 (low, possible bot wave) | medium or low |
| `client_error_flood` | any `client_errors_flood` | medium |
| `quiz_abuse` | 20 or more `quiz_check_rate_limited` | low |
| `privilege_changes` | any `grant_admin_role` in the audit log (high, review it); other sensitive actions such as `revoke_admin_role`, `admin_user_deleted`, progress resets, ignore list changes, settings updates and bulk actions are listed (low) | high or low |
| `error_spike` | 1 or more critical `system_errors` (medium); 10 or more new fingerprints or 1 or more regressions (low) | medium or low |
| `rate_limit_trips` | any `*_rate_limited` event, listed per limiter | low |

The day's severity is the highest finding severity, or `none`. The summary stores a one-line
headline (for example "2 high, 1 medium findings: possible credential stuffing from 1 network,
1 admin role granted"), totals per event type with the 7-day average and change, the top 5
networks by failures, the top 5 targeted accounts (masked hints only), signups and error counts.

**When it runs.** `vercel.json` schedules `GET /api/admin/cron/security-digest` at `30 19 * * *`
(19:30 UTC, 01:00 IST) and builds the summary for the previous Asia/Kolkata day. On the Hobby
plan Vercel runs crons at most once a day and only to within the hour, so expect it between
01:00 and 02:00 IST. Vercel sends `Authorization: Bearer ${CRON_SECRET}`; the route compares it
in constant time and refuses anything else with 401 (an admin session is not accepted there).
The proxy lets that path through without a session for that reason.

**Delivery.** When the severity is low or higher, the plain-text summary (at most 3500
characters) goes to `ALERT_WEBHOOK_URL` through the same out-of-band helper as critical
incidents. When it is high, every admin also gets an in-app notification. Each goes out at most
once per day: a re-run overwrites the stored digest but does not resend unless forced. With
`SECURITY_DIGEST_SEND_EMPTY=true`, a day without findings sends one short "no findings" line.

**Where to see it.** Console > System > Security (`/admin/security`): the selected day's
severity, headline, findings with evidence tables, totals against the 7-day average, top
networks and accounts, and the last 30 digests. "Generate now" (admin only,
`POST /api/admin/security/digest` with an optional `day` and `force`) builds yesterday or a
chosen day on demand; the run is written to the audit log as `security_digest_generated`.

**Environment variables.**

- `CRON_SECRET` (required for the cron): must be set in the admin Vercel project; the same
  value as the web project is fine. Without it the cron path refuses every call.
- `ALERT_WEBHOOK_URL` (optional, https only): where the text summary goes.
- `ADMIN_TIMEZONE` (optional): day boundaries for the audit log, errors and signups in the
  summary; defaults to `Asia/Kolkata` there. `security_event_counts.day` is always an
  Asia/Kolkata day because the database computes it.
- `SECURITY_DIGEST_SEND_EMPTY` (optional, `true` to enable): send the daily "no findings" line.

## Environment variables

Names only. Set them in the Vercel project (Production and Preview).

Required at run time:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SITE_URL`: the admin URL, for example `https://admin.prodily.app`
- `LEARNER_SITE_URL`: the learner URL, for example `https://prodily.app`
- `INTERNAL_REVALIDATE_SECRET`: the same value as in the web project
- `CRON_SECRET`: the same value as in the web project. Also authenticates the security summary
  cron (see Security summary)
- `RESEND_API_KEY` and/or `BREVO_API_KEY` (the console sends direct messages, broadcasts and test
  emails), plus optional `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`, `BREVO_FROM_EMAIL`,
  `BREVO_FROM_NAME`, `PRIMARY_EMAIL_PROVIDER`

Optional:

- `ADMIN_TIMEZONE` (day boundaries on the dashboard, defaulting to the server timezone, and in
  the security summary, defaulting to Asia/Kolkata)
- `SECURITY_DIGEST_SEND_EMPTY` (`true` sends a daily "no findings" line for the security summary)
- `VERCEL_API_TOKEN`, `SUPABASE_MANAGEMENT_API_KEY` (system page integrations)
- `ALERT_WEBHOOK_URL` (out-of-band alerts and the daily security summary)

Build time: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are inlined into the
client bundle and shape the CSP, so set them before building. `NEXT_PUBLIC_SITE_URL` sets the
metadata base and the trusted origin.

Client bundles do not see `LEARNER_SITE_URL`, so links to learner pages in the browser (for
example public portfolio, certificate and lesson links) fall back to `https://prodily.app`.

## Vercel

1. Create a new Vercel project from this repository. Root directory: the repository root.
   Framework: Next.js. `vercel.json` pins the region to `bom1`, like the web project.
2. Add the environment variables above.
3. Add the domain, for example `admin.prodily.app`.

## Owner steps

1. Create the GitHub repository and push this repo (`git remote add origin ...`, then push).
2. Create the Vercel project and connect it to the repository.
3. Add the environment variables. Generate one `INTERNAL_REVALIDATE_SECRET` and set the same
   value in both the admin and the web Vercel projects. Use the web project's `CRON_SECRET`.
4. Deploy the web side of the contract (`/api/internal/revalidate`, cron routes accepting only
   the bearer) before or together with this app.
5. Add the admin domain and sign in at `/admin/login` with an account whose `users.is_admin`
   is true.
6. Apply `20261119000007_security_events.sql` from the web repo, then open `/admin/security`
   and use "Generate now" once to check the security summary.
