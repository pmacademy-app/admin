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

## Environment variables

Names only. Set them in the Vercel project (Production and Preview).

Required at run time:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SITE_URL`: the admin URL, for example `https://admin.prodily.app`
- `LEARNER_SITE_URL`: the learner URL, for example `https://prodily.app`
- `INTERNAL_REVALIDATE_SECRET`: the same value as in the web project
- `CRON_SECRET`: the same value as in the web project
- `RESEND_API_KEY` and/or `BREVO_API_KEY` (the console sends direct messages, broadcasts and test
  emails), plus optional `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`, `BREVO_FROM_EMAIL`,
  `BREVO_FROM_NAME`, `PRIMARY_EMAIL_PROVIDER`

Optional:

- `ADMIN_TIMEZONE` (day boundaries on the dashboard; defaults to the server timezone)
- `VERCEL_API_TOKEN`, `SUPABASE_MANAGEMENT_API_KEY` (system page integrations)
- `ALERT_WEBHOOK_URL` (out-of-band alerts)

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
