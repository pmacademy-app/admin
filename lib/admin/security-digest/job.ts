import { deliverOutOfBandAlert } from '@/lib/monitoring/out-of-band-alert'

import { collectDayData } from './collect'
import { isMissingRelationError, type DigestDb } from './db'
import { buildSummary, evaluateRules, overallSeverity } from './rules'
import { buildDigestText, buildEmptyDigestText } from './text'
import { getAdminTimezone, isValidDay, localDay, previousDay } from './time'
import {
  SECURITY_EVENTS_MIGRATION,
  type DigestDelivery,
  type DigestSeverity,
  type DigestSummary,
} from './types'

/**
 * The nightly security summary job, shared by the Vercel cron route and the
 * admin "Generate now" route.
 *
 * Idempotent per day: the digest row is upserted (a re-run overwrites it), and
 * the webhook and the admin notifications are sent at most once per day. The
 * row's `summary.delivery` records when each went out; a re-run sends again only
 * when `force` is set.
 */

export type WebhookOutcome =
  | 'sent'
  | 'not_configured'
  | 'failed'
  | 'skipped_no_findings'
  | 'skipped_already_sent'

export type NotifyOutcome = 'sent' | 'skipped_not_high' | 'skipped_already_sent' | 'no_admins' | 'failed'

export type RunDigestResult =
  | {
      status: 'not_set_up'
      day: string
      missingTables: string[]
      migration: string
    }
  | {
      status: 'ok'
      day: string
      severity: DigestSeverity
      headline: string
      findings: number
      webhook: WebhookOutcome
      notified: NotifyOutcome
      dataGaps: string[]
    }

export interface DigestJobDeps {
  db: DigestDb
  now?: () => Date
  /** Sends the text out of band. Defaults to the ALERT_WEBHOOK_URL helper. */
  deliver?: (input: { day: string; severity: DigestSeverity; text: string }) => Promise<'sent' | 'not_configured' | 'failed'>
  /** Creates in-app notifications for every admin. Returns how many were created. */
  notifyAdmins?: (input: { db: DigestDb; day: string; headline: string }) => Promise<number>
  /** Defaults to SECURITY_DIGEST_SEND_EMPTY === 'true'. */
  sendEmpty?: boolean
}

export interface RunDigestOptions {
  day?: string
  force?: boolean
  trigger: 'cron' | 'admin'
}

export class InvalidDigestDayError extends Error {
  constructor() {
    super('day must be a YYYY-MM-DD date that is not in the future')
    this.name = 'InvalidDigestDayError'
  }
}

export class DigestWriteError extends Error {
  readonly code: string | null
  constructor(code: string | null) {
    super(`Could not write the security digest${code ? ` (${code})` : ''}`)
    this.name = 'DigestWriteError'
    this.code = code
  }
}

export function sendEmptyDigestEnabled(): boolean {
  return process.env.SECURITY_DIGEST_SEND_EMPTY?.trim().toLowerCase() === 'true'
}

/** Default delivery: reuses the critical-incident out-of-band webhook helper. */
export async function deliverDigestViaWebhook(input: {
  day: string
  severity: DigestSeverity
  text: string
}): Promise<'sent' | 'not_configured' | 'failed'> {
  const result = await deliverOutOfBandAlert({
    incidentId: `security-digest-${input.day}`,
    severity: input.severity === 'none' ? 'info' : input.severity,
    kind: 'security_digest',
    domain: 'security',
    operation: 'security.daily_digest',
    message: input.text,
    nextAction: 'Review the summary at /admin/security',
    fingerprint: `security_digest:${input.day}`,
  })
  if (result.delivered) return 'sent'
  return result.reason === 'not_configured' ? 'not_configured' : 'failed'
}

/** Default notifier: the same in-app path the logger uses for critical incidents. */
export async function notifyAdminsInApp(input: { db: DigestDb; day: string; headline: string }): Promise<number> {
  const { data, error } = await input.db.from('users').select('id').eq('is_admin', true).limit(100)
  if (error || !Array.isArray(data)) return 0
  const admins = data as Array<{ id: string }>
  if (admins.length === 0) return 0
  const { createInAppNotification } = await import('@/lib/notifications/in-app/service')
  const results = await Promise.all(
    admins.map((admin) =>
      createInAppNotification({
        userId: admin.id,
        idempotencyKey: `security_digest:${input.day}:${admin.id}`,
        category: 'security',
        title: `Security summary for ${input.day}: high severity`,
        body: input.headline,
        actionUrl: `/admin/security?day=${input.day}`,
      }).catch(() => ({ success: false }))
    )
  )
  return results.filter((r) => r.success).length
}

async function readExistingDelivery(db: DigestDb, day: string): Promise<DigestDelivery | 'missing'> {
  const { data, error } = await db.from('security_digests').select('summary').eq('day', day).maybeSingle()
  if (error) {
    if (isMissingRelationError(error)) return 'missing'
    // Unknown read failure: assume nothing was sent, a duplicate beats a lost alert.
    return { webhookSentAt: null, notifiedAt: null }
  }
  const summary = (data as { summary?: Partial<DigestSummary> } | null)?.summary
  return {
    webhookSentAt: summary?.delivery?.webhookSentAt ?? null,
    notifiedAt: summary?.delivery?.notifiedAt ?? null,
  }
}

async function writeDigest(
  db: DigestDb,
  row: { day: string; generated_at: string; severity: DigestSeverity; summary: DigestSummary; findings: unknown }
): Promise<void> {
  const { error } = await db.from('security_digests').upsert(row as unknown as Record<string, unknown>, { onConflict: 'day' })
  if (error) throw new DigestWriteError(error.code ?? null)
}

export async function runSecurityDigest(deps: DigestJobDeps, options: RunDigestOptions): Promise<RunDigestResult> {
  const now = (deps.now ?? (() => new Date()))()
  const timezone = getAdminTimezone()
  const day = options.day ?? previousDay(now, timezone)
  if (!isValidDay(day) || day > localDay(now, timezone)) throw new InvalidDigestDayError()

  const notSetUp = (missingTables: string[]): RunDigestResult => ({
    status: 'not_set_up',
    day,
    missingTables,
    migration: SECURITY_EVENTS_MIGRATION,
  })

  const prior = await readExistingDelivery(deps.db, day)
  if (prior === 'missing') return notSetUp(['security_digests'])

  const data = await collectDayData(deps.db, day, { timezone })
  if (data.missingTables.includes('security_event_counts')) return notSetUp(data.missingTables)
  // Any other missing source (not expected in production) is reported as a data gap.
  data.dataGaps = [...new Set([...data.dataGaps, ...data.missingTables])]

  const findings = evaluateRules(data)
  const severity = overallSeverity(findings)
  const summary = buildSummary(data, findings)
  const delivery: DigestDelivery = { ...prior }
  const generatedAt = now.toISOString()

  // Persist first, so the digest exists even if a delivery below hangs or fails.
  await writeDigest(deps.db, { day, generated_at: generatedAt, severity, summary: { ...summary, delivery }, findings })

  // Webhook: findings at low or above, or the optional once-a-day empty line.
  const sendEmpty = deps.sendEmpty ?? sendEmptyDigestEnabled()
  let webhook: WebhookOutcome
  if (severity === 'none' && !sendEmpty) {
    webhook = 'skipped_no_findings'
  } else if (delivery.webhookSentAt && !options.force) {
    webhook = 'skipped_already_sent'
  } else {
    const text = severity === 'none' ? buildEmptyDigestText(day) : buildDigestText(summary, findings)
    webhook = await (deps.deliver ?? deliverDigestViaWebhook)({ day, severity, text })
    if (webhook === 'sent') delivery.webhookSentAt = generatedAt
  }

  // In-app notifications for admins: high severity only, once per day.
  let notified: NotifyOutcome
  if (severity !== 'high') {
    notified = 'skipped_not_high'
  } else if (delivery.notifiedAt && !options.force) {
    notified = 'skipped_already_sent'
  } else {
    try {
      const count = await (deps.notifyAdmins ?? notifyAdminsInApp)({ db: deps.db, day, headline: summary.headline })
      notified = count > 0 ? 'sent' : 'no_admins'
      if (count > 0) delivery.notifiedAt = generatedAt
    } catch {
      notified = 'failed'
    }
  }

  if (delivery.webhookSentAt !== prior.webhookSentAt || delivery.notifiedAt !== prior.notifiedAt) {
    await writeDigest(deps.db, { day, generated_at: generatedAt, severity, summary: { ...summary, delivery }, findings })
  }

  return {
    status: 'ok',
    day,
    severity,
    headline: summary.headline,
    findings: findings.length,
    webhook,
    notified,
    dataGaps: summary.dataGaps,
  }
}
