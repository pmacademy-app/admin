import crypto from 'crypto'

import { redactStack, sanitizeErrorMessage as redactText, sanitizeStructuredPayload, stackFromError } from './redaction'
import { serverRelease } from './release'
import type { ClientErrorSource } from './client-error-beacon'
import {
  categoryForReport,
  resolveErrorReport,
  type ErrorReport,
  type ErrorSeverity,
  type FailureKind,
  type ErrorDomain,
} from './error-taxonomy'

export type { ErrorSeverity }

/**
 * Legacy category union, kept because ~40 existing call sites pass it.
 * New code should call `logErrorReport()` with a typed `ErrorReport` instead.
 */
export type ErrorCategory =
  | 'auth'
  | 'verification'
  | 'queue'
  | 'resend'
  | 'brevo'
  | 'webhook'
  | 'cron'
  | 'system'
  | 'email'
  | 'admin'
  | 'db'
  | 'api'
  | 'config'

/** Which app wrote the incident. The learner repo writes 'web' into the same table. */
export const MONITORING_APP = 'admin'

/** Where the failure happened. */
export type IncidentRuntime = 'server' | 'client'

export type { ClientErrorSource }

/**
 * Optional diagnostic context recorded in `details` (contract A).
 *
 * `error` is the caught value: its stack, and the stacks on its `cause` chain, are
 * redacted and stored. `stack` is a stack that arrived as text (a client report) and
 * wins over `error`. `release` defaults to this server's deployed commit; a client
 * report passes the browser's own. `runtime` defaults to 'server'.
 */
export interface IncidentContext {
  error?: unknown
  stack?: string
  release?: string
  runtime?: IncidentRuntime
  source?: ClientErrorSource
}

export interface LogSystemErrorOptions extends IncidentContext {
  severity: ErrorSeverity
  category: ErrorCategory
  operation: string
  message: string
  templateKey?: string
  queueId?: string
  resendId?: string
  userId?: string
  details?: Record<string, unknown>
}

/**
 * Dedup window (contract E), measured from the latest row's `updated_at`, which is
 * the last time the incident was seen: repeats inside it increment `occurrence_count`
 * instead of inserting. A sustained failure therefore stays on one row for as long
 * as it keeps recurring at least every 15 minutes.
 */
export const DEDUP_WINDOW_MS = 15 * 60 * 1000

/** `system_settings` key holding the ignore list: a JSON array of fingerprints (contract C). */
export const IGNORED_FINGERPRINTS_SETTING_KEY = 'monitoring_ignored_fingerprints'

/** Upper bound on the ignore list. The admin UI refuses to add past it. */
export const MAX_IGNORED_FINGERPRINTS = 500

/** How long a read of the ignore list is reused by this process. */
const IGNORE_LIST_CACHE_MS = 60 * 1000

/** At most one admin alert per fingerprint per hour, however often it recurs. */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000

/**
 * Redaction lives in `./redaction` so there is exactly ONE implementation shared by
 * the logger, the queue, and anything else that persists diagnostic payloads.
 * Re-exported here because existing call sites and tests import it from this module.
 */
export { sanitizeErrorMessage, maskEmailAddress, maskEmailsInText } from './redaction'

/**
 * Recursively sanitizes a details payload before persistence.
 *
 * Redacts by value shape AND by key name — a token in an unanticipated format is
 * still caught because of where it sits in the object.
 */
export function sanitizeDetails(value: unknown): unknown {
  return sanitizeStructuredPayload(value)
}

/**
 * Collapses volatile tokens so repeats of the same incident share a fingerprint.
 *
 * Legacy call sites interpolate ids and addresses into their message. Without this,
 * every occurrence hashes differently, dedup never matches, and one outage produces
 * one alert per affected user. Applied to the FINGERPRINT INPUT ONLY — the stored
 * message keeps its detail.
 */
export function stabilizeForFingerprint(input: string): string {
  return input
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '{email}')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '{timestamp}')
    .replace(/\b\d{4,}\b/g, '{n}')
    .trim()
}

function buildFingerprint(parts: string[]): string {
  return crypto.createHash('md5').update(parts.join(':')).digest('hex')
}

interface PersistArgs {
  severity: ErrorSeverity
  category: string
  domain: ErrorDomain | null
  kind: FailureKind | null
  retryability: string | null
  nextAction: string | null
  operation: string
  message: string
  fingerprint: string
  templateKey?: string
  queueId?: string
  resendId?: string
  userId?: string
  details?: Record<string, unknown>
}

/**
 * Normalizes a stored ignore list. Anything that is not an array of non-empty strings
 * is dropped, duplicates are removed and the result is capped, so a hand-edited or
 * corrupted setting can neither throw here nor grow without bound.
 */
export function parseIgnoredFingerprints(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out = new Set<string>()
  for (const entry of value) {
    if (out.size >= MAX_IGNORED_FINGERPRINTS) break
    if (typeof entry === 'string' && entry.trim()) out.add(entry.trim())
  }
  return Array.from(out)
}

let ignoreListCache: { expiresAt: number; fingerprints: ReadonlySet<string> } | null = null

/** Forgets the cached ignore list. Called after the admin UI writes it, and by tests. */
export function invalidateIgnoredFingerprintsCache(): void {
  ignoreListCache = null
}

/**
 * The ignore list, cached for 60 seconds per process.
 *
 * Fails open: when the setting cannot be read the list is treated as empty, so a
 * database problem can only cause an extra alert, never a missed one. The failed
 * read is cached too, so an outage does not add a lookup to every incident.
 */
async function loadIgnoredFingerprints(
  supabase: ReturnType<typeof import('@/lib/supabase').createServiceRoleClient>
): Promise<ReadonlySet<string>> {
  const now = Date.now()
  if (ignoreListCache && ignoreListCache.expiresAt > now) return ignoreListCache.fingerprints

  let fingerprints: ReadonlySet<string> = new Set()
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', IGNORED_FINGERPRINTS_SETTING_KEY)
      .maybeSingle()
    if (!error) {
      fingerprints = new Set(parseIgnoredFingerprints((data as { value?: unknown } | null)?.value))
    }
  } catch {
    // Fail open.
  }
  ignoreListCache = { expiresAt: now + IGNORE_LIST_CACHE_MS, fingerprints }
  return fingerprints
}

/**
 * Adds the contract A fields to an already-sanitized details payload.
 *
 * The stack is redacted by `redactStack` and added after `sanitizeDetails`, whose
 * 2000-character string cap would otherwise cut a 4000-character stack in half.
 */
function withIncidentContext(
  details: Record<string, unknown> | undefined,
  context: IncidentContext
): Record<string, unknown> {
  const stack = redactStack(context.stack ?? stackFromError(context.error))
  const runtime = context.runtime ?? 'server'
  // A client report carries the release its bundle was built from; this server's
  // commit is only the default for incidents raised here.
  const release = context.release ?? (runtime === 'server' ? serverRelease() : undefined)
  return {
    ...(details || {}),
    ...(stack ? { stack } : {}),
    ...(release ? { release } : {}),
    app: MONITORING_APP,
    runtime,
    ...(context.source ? { source: context.source } : {}),
  }
}

/**
 * Detects whether the current process is running in an automated test environment.
 * Checks Vitest, Jest, and NODE_ENV test markers.
 */
export function isTestEnvironment(): boolean {
  return (
    typeof process !== 'undefined' &&
    (process.env.NODE_ENV === 'test' ||
      process.env.VITEST === 'true' ||
      Boolean(process.env.VITEST) ||
      Boolean(process.env.VITEST_WORKER_ID) ||
      Boolean(process.env.JEST_WORKER_ID))
  )
}

/**
 * Writes one incident.
 *
 * The newest row for the fingerprint decides what happens (one indexed lookup on
 * `(fingerprint, timestamp desc)`):
 *   - it is `resolved`: the failure came back after someone closed it, so a NEW row
 *     is inserted with status `new` and `details.regression = true` (contract D);
 *   - it was last seen (`updated_at`) inside the dedup window: its
 *     `occurrence_count` is incremented and `updated_at` moved to now (contract E);
 *   - otherwise, or when there is no row: a new row is inserted.
 *
 * An ignored fingerprint (contract C) is recorded exactly the same way but never
 * alerts.
 *
 * Ordering and taking one row cannot fail the way the old `.maybeSingle()` did on a
 * multi-row match, which silently disabled deduplication during sustained outages.
 */
async function persistIncident(args: PersistArgs): Promise<string | null> {
  try {
    const { createServiceRoleClient } = await import('@/lib/supabase')

    // In automated test environments, protect the production database from synthetic test telemetry.
    // Allow persistence ONLY if createServiceRoleClient is explicitly mocked/spied on in a test harness
    // or if test DB persistence is explicitly enabled.
    const isMocked =
      typeof createServiceRoleClient === 'function' &&
      ('_isMockFunction' in createServiceRoleClient ||
        'mock' in createServiceRoleClient ||
        'getMockName' in (createServiceRoleClient as unknown as Record<string, unknown>))

    if (isTestEnvironment() && !isMocked && process.env.ALLOW_TEST_SYSTEM_ERRORS !== 'true') {
      return `test_incident_${args.fingerprint.slice(0, 16)}`
    }

    const supabase = createServiceRoleClient()
    const nowIso = new Date().toISOString()
    const windowStartMs = Date.now() - DEDUP_WINDOW_MS

    const { data: recentRows, error: lookupErr } = await supabase
      .from('system_errors')
      .select('id, occurrence_count, status, updated_at, timestamp')
      .eq('fingerprint', args.fingerprint)
      .order('timestamp', { ascending: false })
      .limit(1)

    const latest =
      !lookupErr && recentRows && recentRows.length > 0
        ? (recentRows[0] as {
            id: string
            occurrence_count?: number | null
            status?: string | null
            updated_at?: string | null
            timestamp?: string | null
          })
        : null

    const isRegression = latest?.status === 'resolved'
    const lastSeenMs = latest ? Date.parse(latest.updated_at || latest.timestamp || '') : NaN

    if (latest && !isRegression && Number.isFinite(lastSeenMs) && lastSeenMs >= windowStartMs) {
      await supabase
        .from('system_errors')
        .update({
          occurrence_count: (latest.occurrence_count ?? 1) + 1,
          updated_at: nowIso,
        })
        .eq('id', latest.id)
      return latest.id
    }

    const details = isRegression ? { ...(args.details || {}), regression: true } : args.details
    const row = {
      severity: args.severity,
      category: args.category,
      domain: args.domain,
      kind: args.kind,
      retryability: args.retryability,
      next_action: args.nextAction,
      operation: args.operation,
      message: args.message,
      template_key: args.templateKey || null,
      queue_id: args.queueId || null,
      resend_id: args.resendId || null,
      user_id: args.userId || null,
      fingerprint: args.fingerprint,
      status: 'new',
      occurrence_count: 1,
      first_seen_at: nowIso,
      updated_at: nowIso,
      details: (details as unknown as import('@/lib/supabase').Json) || null,
    }

    let { data: inserted, error: insertErr } = await supabase
      .from('system_errors')
      .insert(row)
      .select('id')
      .maybeSingle()

    // `user_id` references `public.users`. An id with no profile row (a deleted user)
    // must not cost the incident itself: retry once without it.
    if (insertErr && row.user_id && (insertErr as { code?: string }).code === '23503') {
      const retry = await supabase
        .from('system_errors')
        .insert({ ...row, user_id: null })
        .select('id')
        .maybeSingle()
      inserted = retry.data
      insertErr = retry.error
    }

    if (insertErr) {
      console.warn('[logSystemError] DB insert failed (table may be pending migration):', insertErr.message)
      return null
    }

    const incidentId = (inserted as { id: string } | null)?.id || null

    if (args.severity === 'critical' && incidentId) {
      const ignored = await loadIgnoredFingerprints(supabase)
      if (!ignored.has(args.fingerprint)) {
        await notifyAdminsOnce(supabase, args, incidentId)
      }
    }

    return incidentId
  } catch (err) {
    console.warn('[logSystemError] Error logger invocation failed:', err)
    return null
  }
}

/**
 * Sends at most one admin in-app notification per fingerprint per hour.
 *
 * Previously every critical insert fanned out a notification to every admin, awaited
 * serially. Combined with the broken dedup above, a provider outage buried the signal
 * under hundreds of near-identical alerts.
 */
async function notifyAdminsOnce(
  supabase: Awaited<ReturnType<typeof import('@/lib/supabase').createServiceRoleClient>>,
  args: PersistArgs,
  incidentId: string
): Promise<void> {
  if (isTestEnvironment() && process.env.ALLOW_TEST_ADMIN_NOTIFICATIONS !== 'true') {
    return
  }
  try {
    const cooldownStart = new Date(Date.now() - ALERT_COOLDOWN_MS).toISOString()
    const { data: priorRows } = await supabase
      .from('system_errors')
      .select('id')
      .eq('fingerprint', args.fingerprint)
      .gte('timestamp', cooldownStart)
      .neq('id', incidentId)
      .limit(1)

    // An earlier incident with this fingerprint already alerted within the cooldown.
    if (priorRows && priorRows.length > 0) return

    // Out-of-band delivery happens BEFORE the admin lookup, deliberately.
    //
    // The in-app path below needs two more successful database reads and at least one
    // admin row, and returns silently if either is unavailable — which is precisely the
    // situation this channel exists for. Placing it after the cooldown check keeps the
    // one-alert-per-fingerprint-per-hour guarantee while making delivery independent of
    // everything downstream. Awaited so a test can observe it; it never throws.
    // B9-A / F-REL-4.
    const { deliverOutOfBandAlert } = await import('./out-of-band-alert')
    await deliverOutOfBandAlert({
      incidentId,
      severity: args.severity,
      kind: args.kind,
      domain: args.domain,
      operation: args.operation,
      message: args.message,
      nextAction: args.nextAction,
      fingerprint: args.fingerprint,
    })

    const { data: adminUsers } = await supabase.from('users').select('id').eq('is_admin', true)
    const adminList = (adminUsers || []) as unknown as Array<{ id: string }>
    if (adminList.length === 0) return

    const { createInAppNotification } = await import('@/lib/notifications/in-app/service')
    const title = `🚨 ${args.kind ? args.kind.replace(/_/g, ' ') : args.category.toUpperCase()}`
    const body = args.nextAction ? `${args.message} — ${args.nextAction}` : args.message

    await Promise.all(
      adminList.map((admin) =>
        createInAppNotification({
          userId: admin.id,
          category: 'security',
          title,
          body,
          actionUrl: '/admin/system',
        }).catch(() => {})
      )
    )
  } catch (adminNotifErr) {
    console.warn('[logSystemError] Non-fatal admin notification failure:', adminNotifErr)
  }
}

/**
 * Structured entry point. Severity is derived from `kind` — do not pass one in.
 *
 * `summary` must be a stable sentence with no ids in it; identifiers go in `subject`.
 */
export async function logErrorReport(
  report: ErrorReport,
  context: IncidentContext = {}
): Promise<string | null> {
  const resolved = resolveErrorReport(report)
  const summary = redactText(resolved.summary)
  const category = categoryForReport(resolved)

  const fingerprint = buildFingerprint([
    resolved.domain,
    resolved.kind,
    resolved.operation,
    stabilizeForFingerprint(summary),
  ])

  const details = sanitizeDetails({
    ...(resolved.details || {}),
    // B9-B. In `details`, never in the fingerprint above: the fingerprint is what
    // collapses repeats of one incident into a single alert, and a per-request value
    // in it would give every occurrence a distinct hash.
    ...(resolved.requestId ? { requestId: resolved.requestId } : {}),
    ...(resolved.provider
      ? {
          provider: resolved.provider.name,
          providerStatusCode: resolved.provider.statusCode,
          providerExternalId: resolved.provider.externalId,
          providerAttempt: resolved.provider.attempt,
        }
      : {}),
    ...(resolved.subject?.maskedEmail ? { maskedEmail: resolved.subject.maskedEmail } : {}),
    ...(resolved.subject?.broadcastId ? { broadcastId: resolved.subject.broadcastId } : {}),
    ...(resolved.allProvidersFailed ? { allProvidersFailed: true } : {}),
  }) as Record<string, unknown>

  console.error(
    `[SystemError:${resolved.severity.toUpperCase()}:${resolved.domain}/${resolved.kind}]` +
      `${resolved.requestId ? ` [${resolved.requestId}]` : ''} ${resolved.operation} - ${summary}`
  )

  return persistIncident({
    severity: resolved.severity,
    category,
    domain: resolved.domain,
    kind: resolved.kind,
    retryability: resolved.retryability,
    nextAction: resolved.nextAction,
    operation: resolved.operation,
    message: summary,
    fingerprint,
    templateKey: resolved.subject?.templateKey,
    queueId: resolved.subject?.queueId,
    resendId: resolved.provider?.externalId,
    userId: resolved.subject?.userId,
    details: withIncidentContext(details, context),
  })
}

/**
 * Structured System Error Logger (legacy signature).
 *
 * Retained so the existing call sites keep working unchanged. New instrumentation
 * should use `logErrorReport()`, which derives severity and keeps summaries stable.
 */
export async function logSystemError(options: LogSystemErrorOptions): Promise<string | null> {
  const sanitizedMsg = redactText(options.message)
  const fingerprint = buildFingerprint([
    options.category,
    options.operation,
    stabilizeForFingerprint(sanitizedMsg),
  ])

  console.error(
    `[SystemError:${options.severity.toUpperCase()}:${options.category}] ${options.operation} - ${sanitizedMsg}`
  )

  return persistIncident({
    severity: options.severity,
    category: options.category,
    domain: null,
    kind: null,
    retryability: null,
    nextAction: null,
    operation: options.operation,
    message: sanitizedMsg,
    fingerprint,
    templateKey: options.templateKey,
    queueId: options.queueId,
    resendId: options.resendId,
    userId: options.userId,
    details: withIncidentContext(
      sanitizeDetails(options.details) as Record<string, unknown> | undefined,
      options
    ),
  })
}
